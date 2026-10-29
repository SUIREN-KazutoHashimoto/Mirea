export function selectPreviewTarget(candidates, viewport, currentId) {
  const eligible = [];
  for (const candidate of candidates) {
    const r = candidate.rect;
    if (r.width <= 0 || r.height <= 0) continue;
    const visibleWidth = Math.max(0, Math.min(r.right, viewport.width) - Math.max(r.left, 0));
    const visibleHeight = Math.max(0, Math.min(r.bottom, viewport.height) - Math.max(r.top, 0));
    const centerY = r.top + r.height / 2;
    if (visibleWidth * visibleHeight / (r.width * r.height) < 0.7 || centerY < viewport.height * 0.2 || centerY > viewport.height * 0.8) continue;
    eligible.push({ ...candidate, score: Math.abs(centerY - viewport.height / 2) / viewport.height + 0.25 * Math.abs(r.left + r.width / 2 - viewport.width / 2) / viewport.width });
  }
  eligible.sort((a, b) => a.score - b.score);
  const best = eligible[0];
  const current = eligible.find(candidate => candidate.id === currentId);
  // Small scroll/layout jitter should not oscillate between adjacent cards.
  return current && best && current.score <= best.score + 0.08 ? current.id : best?.id ?? null;
}

export const allowAutomaticPreview = ({ reducedMotion = false, saveData = false, effectiveType = '' } = {}) =>
  !reducedMotion && !saveData && !['slow-2g', '2g'].includes(effectiveType);

export function mountVideoPreviews(root, {
  native = false, api, authenticatedBlob, trackPreview,
  win = window, doc = document, nav = navigator, urls = URL,
  hoverDelay = 350, scrollDelay = 650, idleDelay = 180, pollLimit = 25_000
}) {
  const buttons = [...root.querySelectorAll('[data-preview-id]')];
  const byId = new Map(buttons.map(button => [button.dataset.previewId, button]));
  const covers = new Map(buttons.map(button => [button.dataset.previewId, button.querySelector('.video-cover')]));
  const reduce = win.matchMedia('(prefers-reduced-motion: reduce)');
  const hover = win.matchMedia('(hover: hover) and (pointer: fine)');
  const reasons = new Set();
  const listeners = [];
  let disposed = false, dwellTimer, idleTimer, intent = null, active = null, lastCandidate = null;
  let observer;
  const listen = (target, event, listener, options) => {
    target?.addEventListener?.(event, listener, options);
    listeners.push(() => target?.removeEventListener?.(event, listener, options));
  };
  const scrollingMode = () => native || !hover.matches;
  const allowed = () => !disposed && !doc.hidden && !reasons.size && allowAutomaticPreview({ reducedMotion: reduce.matches, saveData: nav.connection?.saveData, effectiveType: nav.connection?.effectiveType });
  const viewport = () => ({ width: win.innerWidth, height: win.innerHeight });
  function visible(id) {
    const cover = covers.get(id);
    if (!cover?.isConnected) return false;
    const r = cover.getBoundingClientRect();
    return r.bottom > 0 && r.top < win.innerHeight && r.right > 0 && r.left < win.innerWidth;
  }
  function stop() {
    clearTimeout(dwellTimer);
    intent = null;
    const previous = active;
    active = null;
    if (!previous) return;
    previous.tracker?.dispose();
    previous.controller.abort();
    previous.video?.pause();
    if (previous.video) {
      previous.video.removeAttribute('src');
      previous.video.load();
      previous.video.remove();
    }
    previous.cover.classList.remove('preview-loading', 'preview-playing');
    previous.label?.remove();
    if (previous.url) urls.revokeObjectURL(previous.url);
  }
  const valid = entry => active === entry && allowed() && visible(entry.id) && !entry.controller.signal.aborted;
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('Aborted'));
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      function abort() { clearTimeout(timer); reject(new Error('Aborted')); }
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async function start(id) {
    if (!allowed() || !visible(id) || intent !== id) return;
    const cover = covers.get(id);
    const entry = { id, cover, controller: new AbortController() };
    active = entry;
    const { signal } = entry.controller;
    entry.label = doc.createElement('span');
    entry.label.className = 'video-preview-label';
    entry.label.setAttribute('aria-hidden', 'true');
    entry.label.textContent = 'プレビュー準備中…';
    (cover.closest?.('.card-open')?.querySelector('.card-content')??cover).append(entry.label);
    cover.classList.add('preview-loading');
    try {
      const deadline = Date.now() + pollLimit;
      let state = await api(`/items/${id}/preview`, { method: 'POST', signal });
      while (valid(entry) && state.state !== 'ready') {
        if (state.state === 'unavailable' || Date.now() >= deadline) throw new Error('Preview unavailable');
        await sleep(Math.min(3000, Math.max(200, state.retryAfterMs ?? 1200)), signal);
        state = await api(`/items/${id}/preview`, { method: ['busy', 'absent'].includes(state.state) ? 'POST' : 'GET', signal });
      }
      if (!valid(entry)) return;
      const blob = await authenticatedBlob(`/api/v1/items/${id}/preview/content`, signal);
      if (!valid(entry)) return;
      // The small authenticated clip is bounded at 2 MiB by the server; never
      // fetch the original video or store clips in a cross-session browser cache.
      if (blob.size > 2 * 1024 * 1024 || blob.type.split(';')[0] !== 'video/mp4') throw new Error('Invalid preview clip');
      const video = doc.createElement('video');
      entry.video = video;
      video.className = 'video-preview';
      video.muted = true;
      video.defaultMuted = true;
      video.volume = 0;
      video.loop = true;
      video.playsInline = true;
      video.controls = false;
      video.disablePictureInPicture = true;
      video.preload = 'auto';
      video.tabIndex = -1;
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.setAttribute('aria-hidden', 'true');
      video.addEventListener('playing', () => {
        if (!valid(entry)) return;
        cover.classList.remove('preview-loading');
        cover.classList.add('preview-playing');
        entry.label.textContent = 'プレビュー · 音声なし';
      });
      video.addEventListener('error', () => { if (active === entry) stop(); });
      entry.url = urls.createObjectURL(blob);
      video.src = entry.url;
      cover.append(video);
      entry.tracker = trackPreview?.(id,video);
      let timeout;
      try {
        await Promise.race([video.play(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Playback timeout')), 8000); })]);
      } finally { clearTimeout(timeout); }
      if (!valid(entry) && active === entry) stop();
    } catch { if (active === entry) stop(); } // Keep the existing JPEG on any failure.
  }
  function target(id) {
    if (!allowed()) id = null;
    if (id === intent) return;
    stop();
    if (!id) return;
    intent = id;
    dwellTimer = setTimeout(() => { start(id); }, scrollingMode() ? scrollDelay : hoverDelay);
  }
  function choose() {
    if (!allowed() || !scrollingMode()) return;
    const id = selectPreviewTarget([...covers].map(([id, cover]) => ({ id, rect: cover.getBoundingClientRect() })), viewport(), lastCandidate);
    lastCandidate = id;
    target(id);
  }
  function scheduleChoice() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(choose, idleDelay);
  }
  function setPaused(reason, paused) {
    if (paused) reasons.add(reason); else reasons.delete(reason);
    if (!allowed()) stop(); else scheduleChoice();
  }
  for (const button of buttons) {
    const id = button.dataset.previewId;
    listen(button, 'pointerenter', event => { if (!scrollingMode() && event.pointerType !== 'touch') target(id); });
    listen(button, 'pointerleave', () => { if (!scrollingMode() && intent === id) target(null); });
    listen(button, 'focus', () => { if (!scrollingMode()) target(id); });
    listen(button, 'blur', () => { if (!scrollingMode() && intent === id) target(null); });
  }
  listen(win, 'scroll', () => {
    if (scrollingMode()) { stop(); scheduleChoice(); }
    else if (intent && !visible(intent)) stop();
  }, { passive: true, capture: true });
  listen(win, 'resize', () => { stop(); scheduleChoice(); }, { passive: true });
  listen(doc, 'visibilitychange', () => { if (!allowed()) stop(); else scheduleChoice(); });
  listen(win, 'blur', () => setPaused('window', true));
  listen(win, 'focus', () => setPaused('window', false));
  listen(win, 'pagehide', () => setPaused('page', true));
  listen(win, 'pageshow', () => setPaused('page', false));
  listen(reduce, 'change', () => { stop(); scheduleChoice(); });
  listen(hover, 'change', () => { stop(); scheduleChoice(); });
  listen(nav.connection, 'change', () => { if (!allowed()) stop(); else scheduleChoice(); });
  if (win.IntersectionObserver) {
    observer = new win.IntersectionObserver(() => {
      if (intent && !visible(intent)) stop();
      if (scrollingMode()) scheduleChoice();
    }, { threshold: [0, 0.7, 1] });
    for (const cover of covers.values()) observer.observe(cover);
  }
  setPaused('dialog', Boolean(doc.querySelector('dialog[open]')));
  scheduleChoice();
  return { setPaused, dispose() {
    disposed = true;
    stop();
    clearTimeout(idleTimer);
    observer?.disconnect();
    for (const remove of listeners) remove();
    byId.clear(); covers.clear();
  } };
}
