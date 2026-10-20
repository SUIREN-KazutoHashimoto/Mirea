import { isTimedKind } from '../../server/audio-types.js';
import { getSession,getEndpoint } from './api.js';
import { createProgressSync,resumeVideoMs } from './progress-core.js';

const active=new Set(),finishing=new Set();
let nativeActive=true;
export function progressNativeState(isActive){nativeActive=isActive;if(!isActive)for(const manager of active)manager.checkpoint();}
export async function flushProgress(){await Promise.all([...active].map(manager=>manager.checkpoint()).concat([...finishing]));}
export async function clearAccountProgress(){
  const user=getSession()?.user.id,endpoint=getEndpoint();if(!user)return;
  await flushProgress();
  const prefix=`mirea.progress.v1|${endpoint || location.origin}|${user}|`;
  for(const key of Object.keys(localStorage))if(key.startsWith(prefix))localStorage.removeItem(key);
}

function cacheFor(partition,assetId){
  const prefix=`mirea.progress.v1|${partition}|`,key=prefix+assetId;
  // Only small pending positions, never tokens/media. Bounded per account/server.
  try{
    const rows=Object.keys(localStorage).filter(key=>key.startsWith(prefix)).map(key=>{
      try{return {key,at:JSON.parse(localStorage.getItem(key))?.at??0};}catch{return {key,at:0};}
    }).sort((a,b)=>b.at-a.at);
    rows.forEach((row,index)=>{if(index>=200 || row.at<Date.now()-30*86400000)localStorage.removeItem(row.key);});
  }catch{/* The server remains the primary store. */}
  let ownedId;
  return {
    read(){try{const row=JSON.parse(localStorage.getItem(key));ownedId=row?.pending?.updateId;return row;}catch{return null;}},
    write(row){
      try{
        if(row){ownedId=row.pending?.updateId;localStorage.setItem(key,JSON.stringify(row));}
        else{const current=JSON.parse(localStorage.getItem(key));if(!current || current.pending?.updateId===ownedId)localStorage.removeItem(key);}
      }catch{/* In-memory retries still work when storage is unavailable. */}
    }
  };
}

export async function openProgress(item,{status=()=>{},saved=()=>{}}={}){
  const session=getSession(),endpoint=getEndpoint();
  if(!session)throw new Error('ログインしてください。');
  const cache=cacheFor(`${endpoint || location.origin}|${session.user.id}`,item.id);
  const request=async(method,body)=>{
    const response=await fetch(`${endpoint}/api/v1/items/${item.id}/progress`,{method,headers:{Authorization:`Bearer ${session.token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store',keepalive:method==='PUT',signal:AbortSignal.timeout(10000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(data.error || '進行度の通信に失敗しました。'),{status:response.status});
    return data;
  };
  const read=()=>request('GET'),send=body=>request('PUT',body);
  let queued=cache.read(),initial=null,revision=null;
  if(queued){
    const recover=createProgressSync({revision:queued.pending?.revision??null,pending:queued.pending,desired:queued.desired,read,send,persist:cache.write,status});
    await recover.flush();queued=cache.read();
  }
  try{const result=await read();initial=result.progress;revision=result.revision;}
  catch(error){
    if([401,403,404].includes(error.status))throw error;
    status('pending');initial=queued?.desired || (queued?.pending?Object.fromEntries(Object.entries(queued.pending).filter(([key])=>!['revision','updateId'].includes(key))):null);
    if(initial?.positionMs!==undefined)initial={...initial,completed:initial.positionMs>=initial.durationMs};
  }
  // If an acknowledgement was lost, retain its exact request ID/revision.
  // A concurrent remote change will return 409 instead of rewinding progress.
  if(queued?.pending)revision=queued.pending.revision;
  const lastValue=initial?(isTimedKind(item.kind)?{positionMs:initial.positionMs,durationMs:initial.durationMs}:{page:initial.page,scrollX:initial.scrollX,scrollY:initial.scrollY,zoom:initial.zoom}):null;
  const sync=createProgressSync({revision,pending:queued?.pending,desired:queued?.desired,lastValue,read,send,persist:cache.write,status,saved});
  let disposed=false,snapshot=()=>null;
  const listeners=[];
  const listen=(target,event,fn)=>{target.addEventListener(event,fn);listeners.push(()=>target.removeEventListener(event,fn));};
  const manager={initial,
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
