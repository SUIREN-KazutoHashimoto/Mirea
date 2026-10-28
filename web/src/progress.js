import {createProgressCache} from './progress-cache.js';
import { isTimedKind } from '../../server/audio-types.js';
import { getSession,getEndpoint,isOfflineSession } from './api.js';
import { createProgressSync,resumeVideoMs } from './progress-core.js';

const active=new Set(),finishing=new Set();
let nativeActive=true;
export function progressNativeState(isActive){nativeActive=isActive;if(!isActive)for(const manager of active)manager.checkpoint();}
export async function flushProgress(){await Promise.all([...active].map(manager=>manager.checkpoint()).concat([...finishing]));}
export async function syncStoredProgress(){
  const session=getSession(),endpoint=getEndpoint();if(!session?.token)return;
  const prefix=`mirea.progress.v1|${endpoint||location.origin}|${session.user.id}|`;
  for(const key of Object.keys(localStorage).filter(key=>key.startsWith(prefix))){
    const id=key.slice(prefix.length);if(!/^[0-9a-f-]{36}$/.test(id)||[...active].some(manager=>manager.assetId===id))continue;
    if(getSession()?.user.id!==session.user.id||getEndpoint()!==endpoint)return;
    const cache=cacheFor(`${endpoint||location.origin}|${session.user.id}`,id),row=cache.read();if(!row?.pending&&!row?.desired)continue;
    const request=async(method,body)=>{
      const r=await fetch(`${endpoint}/api/v1/items/${id}/progress`,{method,headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(10000)}),value=await r.json();
      if(!r.ok)throw Object.assign(new Error('進行度を同期できません。'),{status:r.status});return value;
    };
    const sync=createProgressSync({revision:row.pending?.revision??row.revision??null,pending:row.pending,desired:row.desired,read:()=>request('GET'),send:body=>request('PUT',body),persist:value=>cache.write(value?{...row,...value}:row.last?{last:row.last,revision:row.revision}:null),saved:progress=>{row.last=progress;row.revision=progress.revision;}});
    await sync.flush();
  }
}
export async function clearAccountProgress(){
  const user=getSession()?.user.id,endpoint=getEndpoint();if(!user)return;
  await flushProgress();
  const prefix=`mirea.progress.v1|${endpoint || location.origin}|${user}|`;
  for(const key of Object.keys(localStorage))if(key.startsWith(prefix))localStorage.removeItem(key);
}

function cacheFor(partition,assetId){return createProgressCache(localStorage,partition,assetId);}
export function rememberDownloadProgress(item,result){
  const session=getSession();if(!session)return;
  const cache=cacheFor(`${getEndpoint()||location.origin}|${session.user.id}`,item.id),old=cache.read();
  if(!old?.pending&&!old?.desired&&![...active].some(manager=>manager.assetId===item.id))cache.write({last:result.progress,revision:result.revision});
}

export async function openProgress(item,{status=()=>{},saved=()=>{}}={}){
  const session=getSession(),endpoint=getEndpoint();
  if(!session)throw new Error('ログインしてください。');
  const cache=cacheFor(`${endpoint || location.origin}|${session.user.id}`,item.id);
  const request=async(method,body)=>{
    if(isOfflineSession()||!getSession()?.token)throw new Error('続き位置はオンライン復帰後に同期します。');
    const response=await fetch(`${endpoint}/api/v1/items/${item.id}/progress`,{method,headers:{Authorization:`Bearer ${getSession()?.user.id===session.user.id&&getEndpoint()===endpoint?getSession().token:''}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store',keepalive:method==='PUT',signal:AbortSignal.timeout(2500)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(data.error || '進行度の通信に失敗しました。'),{status:response.status});
    return data;
  };
  const read=()=>request('GET'),send=body=>request('PUT',body);
  let queued=cache.read(),initial=null,revision=null;
  if(queued?.pending||queued?.desired){
    const recover=createProgressSync({revision:queued.pending?.revision??queued.revision??null,pending:queued.pending,desired:queued.desired,read,send,persist:row=>cache.write(row?{...queued,...row}:queued.last?{last:queued.last,revision:queued.revision}:null),status});
    await recover.flush();queued=cache.read();
  }
  try{const result=await read();initial=result.progress;revision=result.revision;}
  catch(error){
    if([401,403,404].includes(error.status))throw error;
    status('pending');revision=queued?.pending?.revision??queued?.revision??item.progress?.revision??null;
    initial=queued?.desired || (queued?.pending?Object.fromEntries(Object.entries(queued.pending).filter(([key])=>!['revision','updateId'].includes(key))):null) || queued?.last || item.progress || null;
    if(initial?.positionMs!==undefined)initial={...initial,completed:initial.positionMs>=initial.durationMs};
  }
  // If an acknowledgement was lost, retain its exact request ID/revision.
  // A concurrent remote change will return 409 instead of rewinding progress.
  if(queued?.pending)revision=queued.pending.revision;
  const lastValue=initial?(isTimedKind(item.kind)?{positionMs:initial.positionMs,durationMs:initial.durationMs}:{page:initial.page,scrollX:initial.scrollX,scrollY:initial.scrollY,zoom:initial.zoom}):null;
  let lastSaved=initial,lastRevision=revision;
  if(!queued?.pending&&!queued?.desired&&revision!==null)cache.write({last:initial,revision});
  const persist=row=>cache.write(row?{...row,last:lastSaved,revision:lastRevision}:lastSaved?{last:lastSaved,revision:lastRevision}:null);
  const sync=createProgressSync({revision,pending:queued?.pending,desired:queued?.desired,lastValue,read,send,persist,status,saved:value=>{lastSaved=value;lastRevision=value.revision;saved(value);}});
  let disposed=false,snapshot=()=>null;
  const listeners=[];
  const listen=(target,event,fn)=>{target.addEventListener(event,fn);listeners.push(()=>target.removeEventListener(event,fn));};
  const manager={assetId:item.id,initial,
    bind(fn){snapshot=fn;},
    capture(){if(!disposed)sync.update(snapshot());},
    checkpoint(){manager.capture();return sync.flush();},
    dispose(){
      if(disposed)return;manager.capture();disposed=true;clearInterval(timer);listeners.forEach(remove=>remove());active.delete(manager);
      const done=sync.flush();finishing.add(done);done.finally(()=>finishing.delete(done));
    }
  };
  const timer=setInterval(()=>{if(isTimedKind(item.kind) || nativeActive && !document.hidden)manager.checkpoint();},5000);
  listen(document,'visibilitychange',()=>{if(document.hidden)manager.checkpoint();});
  listen(window,'pagehide',()=>manager.checkpoint());
  active.add(manager);return manager;
}

export function bindVideoProgress(video,manager){
  let initialized=false,restoring=false,touched=false,restartRequested=false;
  const listeners=[];
  const listen=(type,fn)=>{video.addEventListener(type,fn);listeners.push(()=>video.removeEventListener(type,fn));};
  manager.bind(()=>{
    if(!initialized || restoring || !touched || !Number.isFinite(video.duration) || video.duration<=0)return null;
    const durationMs=Math.round(video.duration*1000);
    return {positionMs:video.ended?durationMs:Math.min(durationMs,Math.max(0,Math.round(video.currentTime*1000))),durationMs};
  });
  listen('loadedmetadata',()=>{
    if(initialized || !Number.isFinite(video.duration))return;
    initialized=true;const target=restartRequested?0:resumeVideoMs(manager.initial,video.duration*1000)/1000;
    if(target>0){restoring=true;video.currentTime=target;}
    else if(restartRequested)manager.checkpoint();
  });
  listen('seeking',()=>{if(!restoring)touched=true;});
  listen('seeked',()=>{
    if(restoring){restoring=false;if(!video.paused)touched=true;else return;}
    manager.checkpoint();
  });
  listen('play',()=>{touched=true;});
  listen('timeupdate',()=>{if(!video.paused)manager.capture();});
  for(const event of ['pause','ended'])listen(event,()=>manager.checkpoint());
  const cleanup=()=>listeners.forEach(remove=>remove());
  cleanup.restart=()=>{restartRequested=true;touched=true;restoring=false;video.currentTime=0;manager.checkpoint();};
  return cleanup;
}
