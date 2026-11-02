// The source browser retains File objects after its upload dialog closes.
// Remote devices request the same durable server slot; they never receive files.
const sources=new Set();
export function startLocalManualUpload(transferId){
 for(const source of sources)if(source.current()){const job=source.jobs.find(job=>job.transferId===transferId);if(job)return source.batch.forceStart(job.key);}
 return false;
}
export function registerManualUploadBatch({batch,jobs,api,isCurrent}){
 const controller=new AbortController(),source={batch,jobs,current:isCurrent};let timer,stopped=false;
 sources.add(source);
 const stop=()=>{stopped=true;clearTimeout(timer);controller.abort();sources.delete(source);};
 async function poll(){
  if(stopped||!isCurrent()){stop();return;}
  try{const value=await api('/transfers/manual-upload',{signal:controller.signal});if(!stopped&&isCurrent()&&value.slot)startLocalManualUpload(value.slot.transferId);}
  catch(error){if([401,403,404].includes(error.status)){stop();return;}}
  if(!stopped)timer=setTimeout(poll,2000);
 }
 void poll();batch.transferred.then(stop,stop);return stop;
}
