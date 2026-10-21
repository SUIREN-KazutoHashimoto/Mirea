import {mountPlaybackDock} from './playback-dock.js';
export function createViewerScreen({ title, kind, onClose, doc = document }) {
  const previousFocus = doc.activeElement, app = doc.querySelector('#app'), wasInert = app?.inert;
  const node = doc.createElement('section'); node.className = `viewer-screen ${kind === 'audio' ? 'audio-screen' : kind === 'video' ? 'video-screen' : 'book-screen'}`;
  node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.setAttribute('aria-label', title); node.tabIndex = -1;
  node.dataset.chrome = 'hidden';
  node.innerHTML = '<div class="viewer-top" data-viewer-chrome><header class="viewer-header"><button class="viewer-back" type="button" aria-label="ライブラリへ戻る">← <span>ライブラリ</span></button><div><small></small><h1></h1></div><button class="viewer-fullscreen icon-button" type="button" aria-label="全画面を切り替える">⛶</button></header><div class="viewer-meta"></div><div class="viewer-tools"></div></div><div class="viewer-body"></div><button class="viewer-chrome-toggle" type="button" aria-label="操作メニューを表示" aria-expanded="false">•••</button>';
  node.querySelector('h1').textContent = title; node.querySelector('small').textContent = kind === 'audio' ? 'MIREA / LISTEN' : kind === 'video' ? 'MIREA / WATCH' : 'MIREA / READ';
  let closed = false, minimized=false,mini,media,dockOptions,stopDockBinding; node.open = true;
  const previousOverflow = doc.body.style.overflow;
  const fullscreen = () => { const operation = doc.fullscreenElement ? doc.exitFullscreen?.() : node.requestFullscreen?.(); operation?.catch?.(() => {}); };
  let chromeTimer;
  const chromeObserver = new ResizeObserver(entries => {
    node.style.setProperty('--viewer-top-height', `${entries[0].target.getBoundingClientRect().height}px`);
  });
  chromeObserver.observe(node.querySelector('.viewer-top'));
  const toggle = node.querySelector('.viewer-chrome-toggle');
  node.showChrome = (visible = true) => {
    if (closed) return;
    clearTimeout(chromeTimer);
    if (!visible && node.querySelector('[data-chrome-pinned="true"]')) return;
    node.dataset.chrome = visible ? 'visible' : 'hidden';
    toggle.setAttribute('aria-expanded', String(visible));
    toggle.setAttribute('aria-label', visible ? '操作メニューを隠す' : '操作メニューを表示');
    node.dispatchEvent(new CustomEvent('viewer:chrome', { detail: visible }));
  };
  toggle.onclick = () => node.showChrome(node.dataset.chrome !== 'visible');
  node.addEventListener('viewer:toggle-chrome', () => toggle.click());
  node.addEventListener('pointermove', event => {
    if (event.pointerType === 'mouse' && !event.target.closest('.viewer-chrome-toggle') && event.clientY - node.getBoundingClientRect().top < 30) node.showChrome();
  });
  node.addEventListener('viewer:player-controls', event => {
    if (event.detail) { node.showChrome(); chromeTimer = setTimeout(() => {
      if (!node.querySelector('[data-viewer-chrome]:focus-within, [data-viewer-chrome] details[open]')) node.showChrome(false);
    }, 2800); }
    else if (!node.querySelector('[data-viewer-chrome]:focus-within')) node.showChrome(false);
  });
  const updateDock=()=>mini?.update({key:dockOptions?.key??title,id:dockOptions?.id,title,kind,playing:Boolean(media&&!media.paused),positionMs:(media?.currentTime||0)*1000,durationMs:(media?.duration||0)*1000});
  node.bindBackground=(element,options)=>{stopDockBinding?.();media=element;dockOptions=options;const events=['play','pause','timeupdate','durationchange','loadedmetadata','ended'];for(const name of events)element.addEventListener(name,updateDock);stopDockBinding=()=>{for(const name of events)element.removeEventListener(name,updateDock);};updateDock();};
  const restore=()=>{if(closed)return;minimized=false;node.isMinimized=false;node.style.display='';node.dispatchEvent(new Event('viewer:presentation'));mini?.dispose();mini=null;if(app)app.inert=true;doc.body.style.overflow='hidden';node.focus();};
  node.minimize = () => {
    if(closed||minimized)return;minimized=true;node.isMinimized=true;node.style.display='none';node.dispatchEvent(new Event('viewer:presentation'));if(app)app.inert=wasInert;doc.body.style.overflow=previousOverflow;
    if(doc.fullscreenElement===node)doc.exitFullscreen?.().catch(()=>{});
    mini=mountPlaybackDock({doc,onRestore:restore,onToggle:()=>{if(media){if(media.paused)return media.play();media.pause();}},onStop:()=>node.close(),loadArtwork:(state,signal)=>dockOptions?.loadArtwork?.(state,signal)});updateDock();
  };
  const keydown = event => {
    if(minimized)return;
    if (event.key === 'Tab' && node.contains(doc.activeElement)) node.showChrome();
    if (event.key.toLowerCase() === 'i' && !['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName)) { event.preventDefault(); toggle.click(); }
    if (event.key === 'Escape' && !doc.fullscreenElement && !doc.querySelector('dialog[open]')) { event.preventDefault(); node.requestReturn(); }
  };
  node.close = () => {
    if (closed) return; closed = true; node.open = false;
    clearTimeout(chromeTimer);
    chromeObserver.disconnect();
    if (doc.fullscreenElement === node) doc.exitFullscreen?.().catch(() => {});
    doc.removeEventListener('keydown', keydown);
    stopDockBinding?.();mini?.dispose();node.remove();
    if (app) app.inert = wasInert;
    doc.body.style.overflow = previousOverflow;
    onClose?.();
    node.dispatchEvent(new Event('close'));
    if (!doc.querySelector('.viewer-screen') && previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
  };
  node.requestReturn=()=>{if(['audio','video'].includes(kind)&&node.onReturn)node.onReturn();else node.close();};
  node.querySelector('.viewer-back').onclick = () => node.requestReturn(); node.querySelector('.viewer-fullscreen').onclick = fullscreen;
  doc.addEventListener('keydown', keydown); doc.body.append(node); if (app) app.inert = true; doc.body.style.overflow = 'hidden'; node.focus();
  return node;
}
