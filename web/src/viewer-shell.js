export function createViewerScreen({ title, kind, onClose, doc = document }) {
  const previousFocus = doc.activeElement, app = doc.querySelector('#app'), wasInert = app?.inert;
  const node = doc.createElement('section'); node.className = `viewer-screen ${kind === 'video' ? 'video-screen' : 'book-screen'}`;
  node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.setAttribute('aria-label', title); node.tabIndex = -1;
  node.innerHTML = '<header class="viewer-header"><button class="viewer-back" type="button" aria-label="ライブラリへ戻る">← <span>ライブラリ</span></button><div><small></small><h1></h1></div><button class="viewer-fullscreen icon-button" type="button" aria-label="全画面を切り替える">⛶</button></header><div class="viewer-body"></div>';
  node.querySelector('h1').textContent = title; node.querySelector('small').textContent = kind === 'video' ? 'MIREA / WATCH' : 'MIREA / READ';
  let closed = false; node.open = true;
  const previousOverflow = doc.body.style.overflow;
  const fullscreen = () => { const operation = doc.fullscreenElement ? doc.exitFullscreen?.() : node.requestFullscreen?.(); operation?.catch?.(() => {}); };
  const keydown = event => { if (event.key === 'Escape' && !doc.fullscreenElement && !doc.querySelector('dialog[open]')) { event.preventDefault(); node.close(); } };
  node.close = () => {
    if (closed) return; closed = true; node.open = false;
    if (doc.fullscreenElement === node) doc.exitFullscreen?.().catch(() => {});
    doc.removeEventListener('keydown', keydown);
    node.remove();
    if (app) app.inert = wasInert;
    doc.body.style.overflow = previousOverflow;
    onClose?.();
    node.dispatchEvent(new Event('close'));
    if (!doc.querySelector('.viewer-screen') && previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
  };
  node.querySelector('.viewer-back').onclick = () => node.close(); node.querySelector('.viewer-fullscreen').onclick = fullscreen;
  doc.addEventListener('keydown', keydown); doc.body.append(node); if (app) app.inert = true; doc.body.style.overflow = 'hidden'; node.focus();
  return node;
}
