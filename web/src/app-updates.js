import { registerPlugin } from '@capacitor/core';
import { native, getEndpoint } from './api.js';
import { isUpdateBusy, subscribeUpdateBusy } from './update-busy.js';

const updater = native ? registerPlugin('MireaUpdater') : null;
const listeners = new Set();
let initialized, busyQueue = Promise.resolve(), lastStatus = {}, readyNotice;
function publish(status) {
  if (!status) return;
  lastStatus = status;
  for (const listener of listeners) listener(status);
  if (['ready','permission_required','confirmation_required'].includes(status.state) && status.nextCode && readyNotice !== status.nextCode) {
    readyNotice = status.nextCode;
    window.dispatchEvent(new CustomEvent('mirea:update-ready', { detail: status.nextVersion }));
  }
  return status;
}
export async function refreshAppUpdates() {
  if (!updater) return;
  try { return publish(await updater.getStatus()); } catch { /* older bootstrap builds do not expose the plugin */ }
}
async function check(manual, download) {
  if (!updater) return;
  const serverUrl = getEndpoint();
  if (!serverUrl) return refreshAppUpdates();
  await busyQueue;
  await updater.configure({ serverUrl });
  return publish(await updater.check({ manual, download }));
}
export function initializeAppUpdates() {
  if (!updater) return Promise.resolve();
  return initialized ??= (async () => {
    await updater.addListener('updateState', publish);
    subscribeUpdateBusy(busy => {
      busyQueue = busyQueue.catch(() => {}).then(() => updater.setBusy({ busy }));
      busyQueue.catch(() => {});
    });
    await busyQueue;
    const status = await refreshAppUpdates();
    if (status?.automatic && getEndpoint()) await check(false, true);
  })().catch(() => { /* Updates must not prevent login or asset access. */ });
}
export function appUpdatesEndpointChanged() {
  if (updater) initializeAppUpdates().then(() => check(false, true)).catch(() => {});
}
export function mountAppUpdates(container, { onClose = () => {} } = {}) {
  if (!updater) return () => {};
  container.classList.add('app-updates');
  container.innerHTML = `<p class="update-version"></p><p class="update-status" role="status" aria-live="polite">更新状態を確認しています…</p>
    <progress class="update-progress" max="1" value="0" hidden aria-label="アプリ更新のダウンロード"></progress>
    <label class="confirm-row"><input class="update-auto" type="checkbox">自動的に更新を確認・取得・適用する</label>
    <label class="confirm-row"><input class="update-unmetered" type="checkbox">取得はWi-Fiなどの非従量制回線のみ</label>
    <p class="muted">自動確認は約12時間ごと（Androidの省電力制御により遅れる場合があります）。再生・閲覧・転送中は適用しません。Androidの版や設定によっては、最後に確認操作が必要です。</p>
    <div class="update-actions"><button class="button secondary update-check" type="button">更新を確認</button><button class="button secondary update-fetch" type="button" hidden>取得・再開</button><button class="button secondary update-permission" type="button" hidden>インストール許可を設定</button><button class="button primary update-install" type="button" hidden>更新を適用</button></div>
    <p class="update-error form-error" role="alert" hidden></p>`;
  const find = selector => container.querySelector(selector);
  let disposed = false, operation = false;
  const render = s => {
    if (disposed) return;
    find('.update-version').textContent = s.currentVersion ? `インストール済み ${s.currentVersion}${s.nextVersion ? ` → ${s.nextVersion}` : ''}` : 'Androidアプリの更新';
    find('.update-status').textContent = !s.sourceConfigured ? 'ログイン画面でHTTPSのサーバーURLを保存すると更新を確認できます。' : s.message || '更新を確認できます。';
    find('.update-auto').checked = s.automatic !== false; find('.update-unmetered').checked = s.unmeteredOnly !== false;
    const progress = find('.update-progress'); progress.hidden = !s.total || !s.received;
    progress.max = s.total || 1; progress.value = s.received || 0;
    find('.update-fetch').hidden = !s.nextCode || ['ready','permission_required','confirmation_required','installing'].includes(s.state);
    find('.update-permission').hidden = !s.nextCode || s.canInstall;
    find('.update-install').hidden = !['ready','permission_required','confirmation_required'].includes(s.state) || !s.nextCode;
    find('.update-install').textContent = s.state === 'confirmation_required' ? 'Androidの更新確認を開く' : '更新を適用';
    for (const button of container.querySelectorAll('button')) button.disabled = operation || s.working || isUpdateBusy();
    find('.update-check').disabled ||= !getEndpoint(); find('.update-fetch').disabled ||= !getEndpoint();
    find('.update-install').disabled ||= !s.canInstall;
    for (const input of container.querySelectorAll('input')) input.disabled = operation;
  };
  const run = async action => {
    if (operation) return;
    operation = true; find('.update-error').hidden = true; render(lastStatus);
    try { publish(await action()); }
    catch (error) { if (!disposed) { find('.update-error').textContent = error.message || '更新処理に失敗しました。'; find('.update-error').hidden = false; } }
    finally { operation = false; if (!disposed) { await refreshAppUpdates(); render(lastStatus); } }
  };
  find('.update-auto').onchange = e => { const automatic = e.target.checked; run(() => updater.configure({ automatic })); };
  find('.update-unmetered').onchange = e => { const unmeteredOnly = e.target.checked; run(() => updater.configure({ unmeteredOnly })); };
  find('.update-check').onclick = () => run(() => check(true, false));
  find('.update-fetch').onclick = () => run(() => check(true, true));
  find('.update-permission').onclick = () => run(async () => { await updater.requestInstallPermission(); return updater.getStatus(); });
  find('.update-install').onclick = () => run(async () => {
    if (isUpdateBusy()) throw new Error('再生・閲覧・転送を終了してください。');
    if (!window.confirm('Mireaを更新します。アプリが終了する場合があります。続けますか？')) return updater.getStatus();
    await updater.install(); onClose(); return updater.getStatus();
  });
  listeners.add(render);
  const unsubscribe = subscribeUpdateBusy(() => render(lastStatus));
  const timer = setInterval(() => { if (!disposed) refreshAppUpdates(); }, 2000);
  initializeAppUpdates().then(refreshAppUpdates); render(lastStatus);
  return () => { disposed = true; clearInterval(timer); listeners.delete(render); unsubscribe(); };
}
export function openAppUpdates(dialog) {
  const node = dialog('アプリの更新', '<div class="modal-body"><div class="update-container"></div></div>');
  const dispose = mountAppUpdates(node.querySelector('.update-container'), { onClose: () => node.close() });
  node.addEventListener('close', dispose, { once: true });
  return node;
}
