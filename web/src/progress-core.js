// One in-flight update per viewer, optimistic revisions across viewers/devices.
export function createProgressSync({revision=0,pending=null,desired=null,conflict=null,lastValue=null,read,send,persist=()=>{},status=()=>{},saved=()=>{},uuid=()=>crypto.randomUUID(),now=Date.now}) {
  let running,stopped=false,last=desired?JSON.stringify(desired):lastValue?JSON.stringify(lastValue):null;
  const store=()=>persist(pending || desired || conflict ? {pending,desired,revision,conflict,at:now()}:null);
  function prepare(){if(!pending && desired && revision!==null)pending={revision,updateId:uuid(),...desired};}
  function update(value){
    if(stopped || !value)return;
    const key=JSON.stringify(value);if(key===last)return;
    last=key;desired={...value};prepare();store();
  }
  async function flush(){
    if(running)return running;if(stopped||conflict)return;
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
          prepare();saved(result.progress);store();status('saved');
          if(!pending)return;
        }
      }catch(error){
        if(error.status===409){
          conflict={revision,at:now()};store();status('conflict');
        }else if([400,403,404,422].includes(error.status)){
          stopped=true;pending=null;desired=null;store();status(error.status===409?'conflict':'forbidden');
        }else{store();status(error.status===401?'unauthorized':'pending');}
      }
    })().finally(()=>{running=null;});
    return running;
  }
  async function resolveConflict(choice){
    if(!['local','remote'].includes(choice))throw new Error('続き位置の選択が不正です。');
    if(running)await running;
    const remote=await read();
    const local=desired??(pending?Object.fromEntries(Object.entries(pending).filter(([key])=>!['revision','updateId'].includes(key))):null);
    revision=remote.revision;pending=null;conflict=null;stopped=false;
    if(choice==='remote'){
      desired=null;last=remote.progress?JSON.stringify(remote.progress):null;
      saved(remote.progress);store();status('saved');return remote.progress;
    }
    desired=local;last=local?JSON.stringify(local):null;prepare();store();await flush();
    if(conflict)throw Object.assign(new Error('別の端末で続き位置が再び更新されました。使う位置をもう一度選択してください。'),{code:'PROGRESS_CONFLICT',status:409});
    if(stopped)throw Object.assign(new Error('続き位置を保存する権限を確認できません。ライブラリから開き直してください。'),{code:'PROGRESS_FORBIDDEN'});
    if(pending||desired)throw Object.assign(new Error('この端末の続き位置は保持しています。接続後に自動で再送します。'),{code:'PROGRESS_PENDING'});
    return local;
  }
  return {update,flush,resolveConflict,get conflicted(){return Boolean(conflict);},get stopped(){return stopped;}};
}

const clamp=value=>Math.max(0,Math.min(1,Number.isFinite(value)?value:0));
export function bookPosition(stage,page,zoom='fit',completed) {
  if(!stage.clientWidth || !stage.clientHeight)return null;
  return {page,scrollX:clamp(stage.scrollLeft/Math.max(1,stage.scrollWidth-stage.clientWidth)),scrollY:clamp(stage.scrollTop/Math.max(1,stage.scrollHeight-stage.clientHeight)),zoom,...(typeof completed==='boolean'?{completed}:{})};
}
export function restoreBookPosition(stage,position) {
  stage.scrollLeft=clamp(position?.scrollX)*Math.max(0,stage.scrollWidth-stage.clientWidth);
  stage.scrollTop=clamp(position?.scrollY)*Math.max(0,stage.scrollHeight-stage.clientHeight);
}
export function resumeVideoMs(progress,durationMs) {
  if(progress?.completed)return 0;
  return Math.max(0,Math.min(progress?.positionMs??0,Math.max(0,durationMs-250)));
}
