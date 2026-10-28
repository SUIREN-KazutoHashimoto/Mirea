// Bounded shared execution, distinct from durable database queues and transfer slots.
import {jobContext,jobCancellationSignal} from './job-context.js';
export function createJobPool(limit=()=>5){
  const waiting=[],keyed=new Map(),listeners=new Set();let running=0,transferUntil=0,transferCooldown=0,wake,notifying=false;
  function available(){if(notifying||running>=limit()||waiting.length||Date.now()<transferUntil)return;notifying=true;queueMicrotask(()=>{notifying=false;if(running<limit()&&!waiting.length&&Date.now()>=transferUntil)for(const listener of listeners)listener();});}
  // A busy transfer may briefly yield CPU, but repeated chunks must never move
  // the deadline forever and starve otherwise independent media lanes.
  function prioritizeTransfers(ms=200){const now=Date.now();if(ms>0&&now>=transferCooldown){transferUntil=now+Math.min(250,ms);transferCooldown=transferUntil+1000;}if(now<transferUntil&&!wake){wake=setTimeout(()=>{wake=null;pump();},Math.max(1,transferUntil-now));wake.unref?.();}if(waiting.length)wake?.ref?.();}

  function pump(){if(waiting.length&&Date.now()<transferUntil){prioritizeTransfers(0);return;}while(waiting.length&&running<limit()){
    const row=waiting.shift(),{work,resolve,reject}=row;running++;
    const settle=(ok,value)=>{running--;if(keyed.get(row.key)===row)keyed.delete(row.key);if(ok)resolve(value);else reject(value);pump();};
    Promise.resolve().then(()=>jobContext.run({signal:row.signal},work)).then(value=>settle(true,value),error=>settle(false,error));
  }available();}
  return {run:(work,key)=>new Promise((resolve,reject)=>{const controller=new AbortController(),parent=jobCancellationSignal(),row={work,resolve,reject,key,controller,signal:parent?AbortSignal.any([parent,controller.signal]):controller.signal};if(key!==undefined)keyed.set(key,row);waiting.push(row);pump();}),pump,prioritizeTransfers,
    onAvailable(listener){listeners.add(listener);available();return()=>listeners.delete(listener);},
    cancel(key){const row=keyed.get(key);if(!row)return false;row.controller.abort(new DOMException('ジョブをキャンセルしました。','AbortError'));const index=waiting.indexOf(row);if(index>=0){waiting.splice(index,1);keyed.delete(key);row.resolve();pump();}return true;},
    get running(){return running;},get queued(){return waiting.length;}};
}

// Separate bounded lanes reserve thumbnail capacity even when every encoder is
// occupied. A lane never awaits a job submitted to that same lane.
export function createJobLanes(settings){
  const limits={ingest:()=>settings().maxConcurrentIngest??2,thumbnail:()=>settings().maxConcurrentThumbnails??2,transcode:()=>settings().maxConcurrentJobs??5,preview:()=>settings().maxConcurrentPreviews??1,other:()=>1};
  const lanes=Object.fromEntries(Object.entries(limits).map(([name,limit])=>[name,createJobPool(limit)]));
  return {run:(work,key,kind='ingest')=>(lanes[kind]??lanes.other).run(work,key),
    onAvailable(listener){let scheduled=false,live=true;const changed=()=>{if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;if(live)listener();});}};const stops=Object.values(lanes).map(lane=>lane.onAvailable(changed));return()=>{live=false;stops.forEach(stop=>stop());};},
    lane:kind=>lanes[kind]??lanes.other,pump(){for(const lane of Object.values(lanes))lane.pump();},
    cancel(key){let found=false;for(const lane of Object.values(lanes))found=lane.cancel(key)||found;return found;},
    prioritizeTransfers(ms=200){lanes.transcode.prioritizeTransfers(ms);lanes.preview.prioritizeTransfers(ms);},
    get running(){return Object.values(lanes).reduce((n,lane)=>n+lane.running,0);},get queued(){return Object.values(lanes).reduce((n,lane)=>n+lane.queued,0);},
    inspect(){return Object.fromEntries(Object.entries(lanes).map(([name,lane])=>[name,{running:lane.running,queued:lane.queued,limit:limits[name]()}]));}
  };
}
