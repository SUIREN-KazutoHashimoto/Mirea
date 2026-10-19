import { getSession, getEndpoint, native } from './api.js';
import { version } from '../../package.json';
import { createViewRecorder, pageViewport } from './analytics-core.js';
import { browserStore, createOutbox } from './analytics-outbox.js';

let transport, init, generation = 0, appActive = true;
const trackers = new Set();
let collectionEnabled = false;
export function configureAnalytics(config) { collectionEnabled = config?.enabled === true; }
export function analyticsNativeState(active) { appActive = active; for (const tracker of trackers) tracker.lifecycle('native'); }
export async function startAnalytics() {
  const session = getSession();
  if (!session || !collectionEnabled) return;
  const revision = ++generation, endpoint = getEndpoint(), partition = `${endpoint || location.origin}|${session.user.id}`;
  init = (async () => {
    const store = await browserStore(partition);
    if (revision !== generation) { store.close?.(); return; }
    const controller = new AbortController();
    const outbox = createOutbox({ store, partition,
      status: state => window.dispatchEvent(new CustomEvent('mirea:analytics-status', { detail: state })),
      send: body => fetch(`${endpoint}/api/v1/analytics/events`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]), keepalive: true })
    });
    const timer = setInterval(() => outbox.flush(), 5000);
    transport = { outbox, controller, timer };
    outbox.flush();
  })();
  await init;
}
export async function flushAnalytics() { await init; await transport?.outbox.flush(); }
export async function stopAnalytics() {
  generation++;
  for (const tracker of [...trackers]) tracker.dispose();
  const old = transport; transport = null;
  if (old) { clearInterval(old.timer); old.controller.abort(); await old.outbox.dispose(); }
}
export async function clearAccountAnalytics() {
  const user=getSession()?.user.id,endpoint=getEndpoint();
  await stopAnalytics();
  if(!user)return;
  const store=await browserStore(`${endpoint || location.origin}|${user}`);
  try{await store.remove((await store.list()).map(row=>row.key));}finally{store.close?.();}
}

export function trackAsset(assetId, context = 'viewer') {
  if (!collectionEnabled || !getSession()) return null;
  const view = { id: crypto.randomUUID(), assetId, context, platform: native ? 'android' : 'web', clientVersion: version };
  const listeners = [];
  let disposed = false, rendered = false, page, previousPage, element, stage, video, zoom = 1, buffering = true;
  let foreground = appActive && !document.hidden, focused = document.hasFocus(), lastInput = performance.now();
  const isIdle=()=>performance.now()-lastInput>120000 && (!video || video.paused || video.ended);
  const listen = (target, type, fn, options) => { target.addEventListener(type,fn,options); listeners.push(() => target.removeEventListener(type,fn,options)); };
  const snapshot = () => {
    let geometry = {};
    if (rendered && element) {
      const clip = stage?.getBoundingClientRect() ?? { left:0,top:0,right:innerWidth,bottom:innerHeight };
      geometry = pageViewport(element.getBoundingClientRect(), { left:Math.max(0,clip.left),top:Math.max(0,clip.top),right:Math.min(innerWidth,clip.right),bottom:Math.min(innerHeight,clip.bottom) });
    }
    const state = { visible: foreground && rendered && (geometry.visibleRatio ?? 0)>0, focused, idle: isIdle(),
      ...geometry, viewportWidth: Math.min(32768,Math.round(innerWidth)), viewportHeight: Math.min(32768,Math.round(innerHeight)) };
    if (video) {
      state.toMs = Math.max(0,video.currentTime*1000 || 0);
      if (Number.isFinite(video.duration)) state.durationMs = Math.max(0,video.duration*1000);
      Object.assign(state, { playing: !video.paused && !video.ended, seeking: video.seeking, buffering, rate:Math.min(16,Math.max(0.1,video.playbackRate || 1)), muted:video.muted,volume:video.volume,fullscreen:Boolean(document.fullscreenElement?.contains(video)) });
      const dropped = video.getVideoPlaybackQuality?.().droppedVideoFrames;
      if (Number.isInteger(dropped)) state.droppedFrames = dropped;
    } else if (page && rendered) Object.assign(state,{page,zoom});
    return state;
  };
  // The transport identity is captured at construction; never reassign old events
  // to a newly logged-in account or a different server.
  const targetInit = init, targetGeneration = generation;
  const targetTransport = transport;
  const emit = (v,e) => {
    if (targetTransport) targetTransport.outbox.enqueue(v,e);
    else targetInit?.then(() => { if (generation===targetGeneration && transport) transport.outbox.enqueue(v,e); });
  };
  const recorder = createViewRecorder({ view, emit, snapshot });
  const lifecycle = reason => recorder.change(reason==='focus'?'focus':'visibility', () => { foreground=appActive&&!document.hidden; focused=document.hasFocus(); }, { reason });
  const tracker = {
    lifecycle,
    loading() { recorder.change('page_loading',()=>{ rendered=false; },{ reason:'page' }); },
    ready(nextPage, node, viewport, scale = 1) {
      recorder.change(nextPage === previousPage ? 'ready' : 'page_enter',()=>{ page=nextPage; element=node; stage=viewport; zoom=scale; rendered=true; lastInput=performance.now(); }, { ...(previousPage ? { previousPage } : {}), reason:'ready' });
      previousPage=nextPage;
    },
    zoom(scale) { recorder.change('zoom',()=>{ zoom=scale; lastInput=performance.now(); },{ reason:'zoom' }); },
    viewport(reason='scroll') { recorder.change('viewport',()=>{ lastInput=performance.now(); },{ reason }); },
    error() { recorder.change('error',()=>{ rendered=false; },{ errorCode:'load', reason:'error' }); },
    video(node) {
      video=node; element=node;
      for (const [name,type] of Object.entries({loadeddata:'ready',playing:'play',pause:'pause',seeking:'seeking',seeked:'seeked',ended:'ended',ratechange:'rate_change',waiting:'buffering',stalled:'buffering',volumechange:'viewport',emptied:'page_loading',error:'error'})) {
        listen(node,name,()=>recorder.change(type,()=>{
          if (name==='loadeddata') rendered=true;
          if (name==='playing' || name==='seeked' && node.readyState>=3) { buffering=false; rendered=true; }
          if (['waiting','stalled','emptied','error'].includes(name)) buffering=true;
          if (['emptied','error'].includes(name)) rendered=false;
        }, name==='error'?{errorCode:'decode',reason:'error'}:{}));
      }
      listen(document,'fullscreenchange',()=>recorder.change('viewport'));
      return tracker;
    },
    dispose() {
      if (disposed) return;
      recorder.close(); disposed=true; clearInterval(timer);
      for (const remove of listeners) remove(); trackers.delete(tracker);
      transport?.outbox.flush();
    }
  };
  const timer = setInterval(()=>recorder.sample(),1000);
  listen(document,'visibilitychange',()=>lifecycle('visibility'));
  listen(window,'blur',()=>lifecycle('focus')); listen(window,'focus',()=>lifecycle('focus'));
  listen(window,'pagehide',()=>{ recorder.change('visibility',()=>{foreground=false;},{reason:'visibility'}); transport?.outbox.flush(); });
  listen(window,'pageshow',()=>lifecycle('visibility'));
  for (const name of ['pointerdown','keydown','touchstart','wheel']) listen(window,name,()=>{
    const wasIdle=isIdle();
    if (wasIdle) recorder.change('idle',()=>{lastInput=performance.now();},{reason:'idle'}); else lastInput=performance.now();
  },{passive:true});
  trackers.add(tracker);
  return tracker;
}
