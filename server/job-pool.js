// Bounded shared execution, distinct from durable database queues and transfer slots.
import {jobContext,jobCancellationSignal} from './job-context.js';
export function createJobPool(limit=()=>5){
  const waiting=[],keyed=new Map();let running=0,transferUntil=0,wake;
  function prioritizeTransfers(ms=1200){transferUntil=Math.max(transferUntil,Date.now()+ms);if(!wake){wake=setTimeout(()=>{wake=null;pump();},Math.max(1,transferUntil-Date.now()));wake.unref?.();}if(waiting.length)wake.ref?.();}

  function pump(){if(waiting.length&&Date.now()<transferUntil){prioritizeTransfers(0);return;}while(waiting.length&&running<limit()){
    const row=waiting.shift(),{work,resolve,reject}=row;running++;
    Promise.resolve().then(()=>jobContext.run({signal:row.signal},work)).then(resolve,reject).finally(()=>{running--;if(keyed.get(row.key)===row)keyed.delete(row.key);pump();});
  }}
  return {run:(work,key)=>new Promise((resolve,reject)=>{const controller=new AbortController(),parent=jobCancellationSignal(),row={work,resolve,reject,key,controller,signal:parent?AbortSignal.any([parent,controller.signal]):controller.signal};if(key!==undefined)keyed.set(key,row);waiting.push(row);pump();}),pump,prioritizeTransfers,
    cancel(key){const row=keyed.get(key);if(!row)return false;row.controller.abort(new DOMException('ジョブをキャンセルしました。','AbortError'));const index=waiting.indexOf(row);if(index>=0){waiting.splice(index,1);keyed.delete(key);row.resolve();}return true;},
    get running(){return running;},get queued(){return waiting.length;}};
}
