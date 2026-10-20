import {mountPersonalExport} from './admin-downloads.js';

export function openSettings({ dialog, api, esc, theme, apkUrl, version, onUpdated, onDeleted, manageShelf, manageDownloads, mountUpdates,flush=async()=>{} }) {
  const node = dialog('設定', '<div class="modal-body settings-body"><p role="status">アカウントを確認しています…</p></div>', 'settings-modal');
  const body = node.querySelector('.modal-body');
  let disposed = false, disposeUpdates,disposeExport;
  node.addEventListener('close', () => { disposed = true; disposeUpdates?.();disposeExport?.(); }, { once: true });
  api('/account').then(account => {
    if (disposed) return;
    const user = account.user;
    const blocked = account.ownedShelves.filter(s => s.assetCount > 0 || s.memberCount > 1);
    body.innerHTML = `<section class="settings-section"><span class="eyebrow">YOUR PREFERENCES</span><h3>あなたに合う表示に。</h3><label>テーマ<select class="theme-select"><option value="system">端末に合わせる</option><option value="light">ライト</option><option value="dark">ダーク</option></select></label><p class="muted">テーマはこの端末に保存されます。本のページや動画の色は変更しません。</p></section>
      <section class="settings-section"><h3>アカウント情報</h3><p class="muted">変更すると他の端末はログアウトします。この端末のログインは更新されます。</p><form class="account-form"><label>表示名<input name="name" maxlength="80" autocomplete="name" value="${esc(user.name)}" required></label><label>メールアドレス<input name="email" type="email" maxlength="254" autocomplete="email" value="${esc(user.email)}" required></label><label>新しいパスワード（変更する場合）<input name="newPassword" type="password" minlength="12" maxlength="128" autocomplete="new-password" placeholder="変更しない場合は空欄"></label><label>現在のパスワード<input name="currentPassword" type="password" maxlength="128" autocomplete="current-password" required></label><p class="form-error" role="alert" hidden></p><button class="button primary" type="submit">変更を保存</button></form></section>
      <section class="settings-section"><h3>端末のダウンロード</h3><p class="muted">この端末に暗号化して保存した作品を管理します。開くときはオンラインで権限を確認します。</p><button class="button secondary manage-downloads">端末のダウンロードを開く</button></section>
      <section class="settings-section"><h3>閲覧記録のダウンロード</h3><div class="personal-export-container"></div></section>
      <section class="settings-section"><h3>Androidアプリ</h3>${mountUpdates ? '<div class="update-container"></div>' : `<p class="muted">サーバー ${esc(version)} · 専用署名版APKです。旧テスト署名版からの初回移行は手動で行ってください。署名が異なるAPKは上書きできません。アンインストールすると端末内ダウンロードは失われます。</p><a class="button secondary apk-download" href="${esc(apkUrl)}" target="_blank" rel="noopener noreferrer">Android版APKをダウンロード ↗</a>`}</section>
      <section class="settings-section account-danger"><h3>アカウントを削除</h3><p>アカウント・個人の閲覧記録・続き位置・暗号化ダウンロードの登録と、この端末の保存データを削除します。他の端末の暗号化データは開けなくなりますが、物理的な消去は各端末で行ってください。共有本棚の作品は残り、アップロード者の紐付けだけが外れます。自分だけの空の本棚も削除します。元に戻せません。</p>
      ${blocked.length ? `<div class="account-blockers"><strong>先に本棚の管理を引き継いでください</strong>${blocked.map(s => `<button class="text-button" type="button" data-manage-shelf="${esc(s.id)}">${esc(s.name)} · ${s.assetCount}作品／${s.memberCount}人 →</button>`).join('')}<small>自分だけの本棚なら、作品を削除して空にすることでも退会できます。</small></div>` : ''}
      ${account.lastServerAdmin ? '<p class="permission-note">最後のサーバー管理者です。先にサーバー管理メニューで別の管理者を指定する必要があります。</p>' : ''}
      <form class="account-delete"><label>確認のためメールアドレスを入力<input name="confirmEmail" type="email" autocomplete="off" required></label><label>現在のパスワード<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><label class="confirm-row"><input name="confirm" type="checkbox" required>削除内容を確認しました</label><p class="form-error" role="alert" hidden></p><button class="button danger" type="submit" ${blocked.length || account.lastServerAdmin ? 'disabled' : ''}>アカウントを完全に削除</button></form></section>`;
    const themeSelect = body.querySelector('.theme-select'); themeSelect.value = theme.value; themeSelect.onchange = () => theme.set(themeSelect.value);
    body.querySelector('.manage-downloads').onclick=()=>{node.close();manageDownloads?.();};
    disposeExport=mountPersonalExport(body.querySelector('.personal-export-container'),{api,flush});
    if (mountUpdates) disposeUpdates = mountUpdates(body.querySelector('.update-container'), { onClose: () => node.close() });
    body.querySelectorAll('[data-manage-shelf]').forEach(button => { button.onclick = () => { node.close(); manageShelf(button.dataset.manageShelf); }; });
    const handle = (selector, action) => { const form = body.querySelector(selector); form.onsubmit = async event => {
      event.preventDefault(); const button = form.querySelector('button'), error = form.querySelector('.form-error'); button.disabled = true; error.hidden = true;
      try { await action(form); } catch (err) { if (!disposed) { error.textContent = err.message; error.hidden = false; button.disabled = false; } }
    }; };
    handle('.account-form', async form => {
      const fields = form.elements, payload = { name: fields.name.value.trim(), email: fields.email.value.trim(), currentPassword: fields.currentPassword.value };
      if (fields.newPassword.value) payload.newPassword = fields.newPassword.value;
      const result = await api('/account', { method: 'PATCH', body: payload });
      form.reset(); node.close(); await onUpdated(result);
    });
    handle('.account-delete', async form => {
      if (!form.elements.confirm.checked) return;
      await api('/account', { method: 'DELETE', body: { confirmEmail: form.elements.confirmEmail.value.trim(), currentPassword: form.elements.currentPassword.value } });
      form.reset(); node.close(); await onDeleted();
    });
  }).catch(error => { if (!disposed) body.textContent = error.message; });
  return node;
}
