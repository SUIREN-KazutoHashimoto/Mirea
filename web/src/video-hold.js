/** A temporary rate, never a saved playback preference. Only the video surface
 * receives gestures; transport buttons and timeline keep their normal meaning. */
export function mountVideoHold(media, { document: doc = globalThis.document, window: win = globalThis.window, changed = () => {}, delay = 500, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const removers = []; let pointer, origin, timer, previous, boosted = false, suppress = false, disposed = false;
  const listen = (target, type, fn, options) => { target?.addEventListener(type, fn, options); removers.push(() => target?.removeEventListener(type, fn, options)); };
  function cancel() {
    clearTimer(timer); timer = undefined; pointer = undefined;
    if (boosted) { boosted = false; try { media.playbackRate = previous; } finally { changed(false); } }
  }
  listen(media, 'pointerdown', event => {
    if (pointer !== undefined) { suppress = true; cancel(); return; }
    suppress = false;
    if (disposed || event.isPrimary === false || event.button !== 0 || media.paused || media.ended || media.readyState < 3) return;
    pointer = event.pointerId; origin = [event.clientX, event.clientY];
    try { media.setPointerCapture(pointer); } catch { /* Window release/cancel is also observed. */ }
    timer = setTimer(() => {
      timer = undefined;
      if (pointer === undefined || media.paused || media.ended || media.readyState < 3) return;
      previous = media.playbackRate;
      try { media.playbackRate = 2; boosted = true; suppress = true; changed(true); } catch { cancel(); }
    }, delay);
  });
  listen(media, 'pointermove', event => { if (event.pointerId === pointer && Math.hypot(event.clientX - origin[0], event.clientY - origin[1]) > 12) { suppress = true; cancel(); } });
  for (const target of new Set([media, win])) for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(target, type, event => { if (event.pointerId === pointer) cancel(); });
  listen(media, 'click', event => { if (suppress) { suppress = false; event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  listen(media, 'contextmenu', event => { if (pointer !== undefined || suppress) event.preventDefault(); });
  for (const type of ['pause', 'ended', 'waiting', 'seeking', 'loadstart', 'emptied', 'error', 'enterpictureinpicture']) listen(media, type, cancel);
  listen(media, 'ratechange', () => { if (boosted && media.playbackRate !== 2) { boosted = false; changed(false); } });
  listen(win, 'blur', cancel); listen(doc, 'visibilitychange', () => { if (doc.hidden) cancel(); });
  return { cancel, get active() { return boosted; }, dispose() { disposed = true; cancel(); for (const remove of removers) remove(); } };
}
