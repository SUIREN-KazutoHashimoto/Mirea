/** Track user scrubbing, not media playback/seeking events or timeline hover. */
export function bindSeekInteraction(seek, { document: doc = globalThis.document, window: win = globalThis.window, changed = () => {} } = {}) {
  const removers = []; let active = false, pointer, keyHeld = false, disposed = false;
  const listen = (target, type, fn, options) => { target?.addEventListener(type, fn, options); removers.push(() => target?.removeEventListener(type, fn, options)); };
  const set = value => { if (active !== value) { active = value; changed(value); } };
  const cancel = () => { pointer = undefined; keyHeld = false; set(false); };
  listen(seek, 'pointerdown', event => {
    if (pointer !== undefined) { cancel(); return; }
    if (seek.disabled || event.button !== 0 || event.isPrimary === false) return;
    pointer = event.pointerId; set(true);
    try { seek.setPointerCapture(pointer); } catch { /* Global release still ends scrubbing. */ }
  });
  for (const target of new Set([seek, win])) for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(target, type, event => { if (pointer === event.pointerId) cancel(); });
  const keys = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown']);
  listen(seek, 'keydown', event => { if (!seek.disabled && keys.has(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) { keyHeld = true; set(true); } });
  listen(seek, 'keyup', event => { if (keys.has(event.key)) cancel(); });
  // input also covers assistive technology; change ends one committed action.
  listen(seek, 'input', () => { if (!seek.disabled) set(true); });
  listen(seek, 'change', () => { if (!keyHeld) cancel(); }); listen(seek, 'blur', cancel); listen(win, 'blur', cancel);
  listen(doc, 'visibilitychange', () => { if (doc.hidden) cancel(); });
  listen(doc, 'fullscreenchange', cancel);
  return { get active() { return active; }, cancel, dispose() { if (disposed) return; disposed = true; cancel(); for (const remove of removers) remove(); } };
}
