import { swipeStep } from './book-gestures.js';
export function bookScale(width, height, availableWidth, availableHeight, zoom = 'fit', maxScale = 4) {
  return zoom === 'fit' ? Math.max(.01, Math.min((availableWidth - 8) / width, (availableHeight - 8) / height, maxScale)) : Number(zoom);
}
export function bookDirection(key, direction) {
  if (key === 'PageDown') return 1; if (key === 'PageUp') return -1;
  if (key === 'ArrowRight') return direction === 'rtl' ? -1 : 1;
  if (key === 'ArrowLeft') return direction === 'rtl' ? 1 : -1;
  return 0;
}
export function createBookChrome(container, { kind, total, onError = () => {} }) {
  container.classList.add('book-viewer');
  container.innerHTML = `<div class="book-toolbar"><button class="book-directory icon-button" type="button" aria-label="目次・ページ一覧を開く" aria-expanded="false">☷</button><span class="book-reader-label">READING ROOM</span><div class="book-display-options"><label><span class="sr-only">ページの開き方</span><select class="book-direction"><option value="ltr">左開き</option><option value="rtl">右開き</option></select></label><label><span class="sr-only">表示倍率</span><select class="book-zoom"><option value="fit">ページ全体</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select></label></div></div>
    <div class="book-workspace"><aside class="book-directory-panel" aria-label="目次・ページ一覧" hidden><h2>この本の目次</h2><div class="book-outline"></div><h3>ページへ移動</h3><div class="book-page-list"></div></aside><div class="book-stage ${kind === 'pdf' ? 'pdf-stage' : 'image-stage'}" tabindex="0" aria-label="本のページ"><p class="${kind === 'pdf' ? 'pdf-loading' : 'image-loading'}" role="status">本を開いています…</p>${kind === 'pdf' ? '<canvas aria-label="本のページ" hidden></canvas>' : '<img class="image-page" alt="本のページ" hidden>'}</div></div>
    <footer class="book-footer"><div class="book-page-controls"><button class="icon-button previous" type="button" aria-label="前のページ">←</button><label><input class="page-input" type="number" min="1" value="1" aria-label="ページ番号"><span class="page-total">/ ${total || '…'}</span></label><button class="icon-button next" type="button" aria-label="次のページ">→</button><output class="book-percent">0%</output></div><label class="book-scrubber"><span class="sr-only">本の進行度からページを選択</span><input type="range" min="1" max="${total || 1}" value="1" step="1" disabled></label><p class="book-reading-hint">ページの端をタップ・左右にスワイプして読み進める</p></footer>`;
  const stage = container.querySelector('.book-stage'), panel = container.querySelector('.book-directory-panel'), directory = container.querySelector('.book-directory'), direction = container.querySelector('.book-direction'), slider = container.querySelector('.book-scrubber input');
  const zoom = container.querySelector('.book-zoom'), screen = container.closest('.viewer-screen');
  (container.assetTools??screen?.querySelector('.viewer-tools'))?.append(container.querySelector('.book-toolbar'));
  container.querySelector('.book-footer').setAttribute('data-viewer-chrome', '');
  let state = { page: 1, total: total || 1, ready: false }, handlers = {}, disposed = false, pointer, lastSwipe = 0;
  const pointers = new Set();
  try { if (localStorage.getItem('mirea.book-direction') === 'rtl') direction.value = 'rtl'; } catch {}
  const listeners = []; const listen = (target, name, fn, options) => { target.addEventListener(name, fn, options); listeners.push(() => target.removeEventListener(name, fn, options)); };
  const invoke = fn => { try { Promise.resolve(fn?.()).catch(onError); } catch (error) { onError(error); } };
  const navigate = step => { if (state.ready) { screen?.showChrome(false); invoke(step > 0 ? handlers.next : handlers.previous); } };
  function pageList() {
    const list = panel.querySelector('.book-page-list'); list.replaceChildren();
    const from = Math.max(1, state.page - 40), end = Math.min(state.total, from + 99);
    for (let page = from; page <= end; page++) { const button = document.createElement('button'); button.type = 'button'; button.textContent = String(page); if (page === state.page) button.setAttribute('aria-current', 'page'); button.onclick = () => { invoke(() => handlers.go?.(page)); panel.hidden = true; directory.setAttribute('aria-expanded', 'false'); }; list.append(button); }
  }
  directory.onclick = () => { panel.hidden = !panel.hidden; directory.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) { pageList(); invoke(handlers.outline); } };
  direction.onchange = () => { try { localStorage.setItem('mirea.book-direction', direction.value); } catch {} stage.dataset.direction = direction.value; };
  slider.oninput = () => { container.querySelector('.book-percent').textContent = `${slider.value}ページ`; };
  slider.onchange = () => invoke(() => handlers.go?.(Number(slider.value)));
  listen(container, 'keydown', event => { if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName) || event.ctrlKey || event.metaKey || event.altKey) return; const step = bookDirection(event.key, direction.value); if (step) { event.preventDefault(); navigate(step); } });
  listen(stage, 'pointerdown', event => {
    if (event.target.closest('a,button')) return;
    pointers.add(event.pointerId);
    if (pointers.size !== 1 || event.isPrimary === false || event.button > 0) { pointer = null; return; }
    pointer = { id:event.pointerId, x:event.clientX, y:event.clientY };
    stage.setPointerCapture?.(event.pointerId);
  });
  listen(stage, 'pointercancel', event => { pointers.delete(event.pointerId); pointer = null; });
  listen(stage, 'lostpointercapture', event => { pointers.delete(event.pointerId); pointer = null; });
  listen(stage, 'pointerup', event => {
    pointers.delete(event.pointerId);
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    const step = swipeStep({dx,dy,width:stage.clientWidth,direction:direction.value,canTurn:stage.scrollWidth <= stage.clientWidth + 2 && !String(window.getSelection?.()??'')});
    pointer = null;
    if (step) { lastSwipe = Date.now(); event.preventDefault(); navigate(step); }
    else if (Math.abs(dx)>12 || Math.abs(dy)>12) lastSwipe=Date.now();
  });
  listen(stage, 'click', event => { if (event.target.closest('a,button') || Date.now() - lastSwipe < 400) return; const rect = stage.getBoundingClientRect(), position = (event.clientX - rect.left) / rect.width; if (stage.scrollWidth <= stage.clientWidth+2 && position < .16) navigate(direction.value === 'rtl' ? 1 : -1); else if (stage.scrollWidth <= stage.clientWidth+2 && position > .84) navigate(direction.value === 'rtl' ? -1 : 1); else screen?.showChrome(screen.dataset.chrome!=='visible'); });
  return {
    stage, direction, zoom,
    bind(value) { handlers = value; },
    update(value) { if (disposed) return; state = { ...state, ...value }; slider.max = String(state.total || 1); slider.value = String(state.page); slider.disabled = !state.ready; container.querySelector('.book-percent').textContent = `${Math.round(state.page / Math.max(1, state.total) * 100)}%`; if (!panel.hidden) pageList(); },
    outline(entries) { const list = panel.querySelector('.book-outline'); list.replaceChildren(); if (!entries.length) { list.textContent = '章の目次はありません。ページ番号から移動できます。'; return; } for (const entry of entries.slice(0, 200)) { const button = document.createElement('button'); button.type = 'button'; button.textContent = entry.title; button.onclick = () => { invoke(entry.go); panel.hidden = true; directory.setAttribute('aria-expanded', 'false'); }; list.append(button); } },
    dispose() { disposed = true; pointers.clear(); listeners.forEach(remove => remove()); container.classList.remove('book-viewer'); }
  };
}
