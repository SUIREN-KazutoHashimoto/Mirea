// Pure recorder. Timers, DOM state and durable transport are supplied by adapters.
export function createViewRecorder({ view, emit, snapshot, clock = () => performance.now(), wallClock = Date.now, uuid = () => crypto.randomUUID() }) {
  const started = clock();
  let last = 0, previous = snapshot(), seq = 0, counted = false, closed = false;
  const elapsed = () => Math.max(0, Math.round(clock() - started));
  function event(type, data = {}) {
    if (closed || elapsed() > 7 * 86400000) return;
    emit(view, { id: uuid(), seq: ++seq, type, at: wallClock(), elapsedMs: elapsed(), ...data });
  }
  function count(state) {
    if (!counted && state.visible && state.focused && !state.idle && (state.page || state.playing && !state.buffering && !state.seeking)) {
      counted = true; event('view_start', state);
    }
  }
  function sample() {
    if (closed) return;
    const end = elapsed(), current = snapshot();
    // Long suspended timer gaps are unknown, never silently credited as viewing.
    const raw = Math.max(0, end - last);
    const intervalMs = Math.min(raw, 2000);
    if (intervalMs) {
      const visibleMs = previous.visible ? intervalMs : 0;
      const activeMs = visibleMs && previous.focused && !previous.idle ? intervalMs : 0;
      const data = { ...previous, elapsedMs: end, intervalMs, visibleMs, activeMs, watchMs: 0, gapMs: raw - intervalMs, reason: 'heartbeat' };
      if (previous.toMs !== undefined) {
        data.fromMs = previous.toMs; data.toMs = current.toMs ?? previous.toMs;
        const delta = data.toMs - data.fromMs;
        if (activeMs && previous.playing && !previous.seeking && !previous.buffering && !current.seeking && delta > 0 && delta <= intervalMs * (previous.rate ?? 1) * 1.5 + 300 && raw <= 2000) {
          data.watchMs = Math.min(activeMs, Math.round(delta / (previous.rate ?? 1)));
        }
        if (delta < 0) event('loop', current);
      }
      event('interval', data);
    }
    last = end; previous = current; count(current);
  }
  // Flush the previous state BEFORE the adapter changes it.
  function change(type, update = () => {}, data = {}) {
    if (closed) return;
    sample(); update(); previous = snapshot();
    event(type, { ...previous, ...data }); count(previous);
  }
  event('open', previous); count(previous);
  return { sample, change, close() { if (closed) return; sample(); event('close', { ...snapshot(), reason: 'close' }); closed = true; } };
}

export function pageViewport(rect, clip) {
  if (!rect.width || !rect.height) return { x: 0, y: 0, width: 0, height: 0, visibleRatio: 0 };
  const left = Math.max(rect.left, clip.left), top = Math.max(rect.top, clip.top);
  const width = Math.max(0, Math.min(rect.right, clip.right) - left) / rect.width;
  const height = Math.max(0, Math.min(rect.bottom, clip.bottom) - top) / rect.height;
  return { x: Math.min(1, Math.max(0, (left - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (top - rect.top) / rect.height)), width, height, visibleRatio: width * height };
}
