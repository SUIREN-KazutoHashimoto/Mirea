// One in-flight update per viewer, optimistic revisions across viewers/devices.
export function createProgressSync({revision=0,pending=null,desired=null,lastValue=null,read,send,persist=()=>{},status=()=>{},saved=()=>{},uuid=()=>crypto.randomUUID(),now=Date.now}) {
  let running,stopped=false,last=desired?JSON.stringify(desired):lastValue?JSON.stringify(lastValue):null;
  const store=()=>persist(pending || desired ? {pending,desired,at:now()}:null);
  function prepare(){if(!pending && desired && revision!==null)pending={revision,updateId:uuid(),...desired};}
  function update(value){
    if(stopped || !value)return;
    const key=JSON.stringify(value);if(key===last)return;
    last=key;desired={...value};prepare();store();
  }
  async function flush(){
    if(running)return running;if(stopped)return;
    running=(async()=>{
      try{
        if(revision===null){const result=await read();revision=result.revision;}
        // Coalesce changes made while an acknowledgement is in flight.
        for(let attempt=0;attempt<4;attempt++){
          prepare();if(!pending)return;
          const sent=pending, result=await send(sent);
          revision=result.progress.revision;pending=null;
          const {revision:ignored,updateId,...sentValue}=sent;
          if(JSON.stringify(desired)===JSON.stringify(sentValue))desired=null;
          prepare();store();saved(result.progress);status('saved');
          if(!pending)return;
        }
      }catch(error){
        if([400,403,404,409,422].includes(error.status)){
          stopped=true;pending=null;desired=null;store();status(error.status===409?'conflict':'forbidden');
        }else{store();status(error.status===401?'unauthorized':'pending');}
      }
    })().finally(()=>{running=null;});
    return running;
  }
  return {update,flush,get stopped(){return stopped;}};
}

const clamp=value=>Math.max(0,Math.min(1,Number.isFinite(value)?value:0));
export function bookPosition(stage,page,zoom='fit') {
  if(!stage.clientWidth || !stage.clientHeight)return null;
  return {page,scrollX:clamp(stage.scrollLeft/Math.max(1,stage.scrollWidth-stage.clientWidth)),scrollY:clamp(stage.scrollTop/Math.max(1,stage.scrollHeight-stage.clientHeight)),zoom};
}
export function restoreBookPosition(stage,position) {
  stage.scrollLeft=clamp(position?.scrollX)*Math.max(0,stage.scrollWidth-stage.clientWidth);
  stage.scrollTop=clamp(position?.scrollY)*Math.max(0,stage.scrollHeight-stage.clientHeight);
}
export function resumeVideoMs(progress,durationMs) {
  if(progress?.completed)return 0;
  return Math.max(0,Math.min(progress?.positionMs??0,Math.max(0,durationMs-250)));
}
