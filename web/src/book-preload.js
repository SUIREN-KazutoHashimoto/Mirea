// Prepare only the next book's opening page. This is ephemeral memory, never an
// offline download, and cannot outlive the account/viewer that authorized it.
export function createBookPreloader({pages,blob,current=()=>true,maxBytes=16*1024*1024}){
  let pending,prepared,disposed=false;
  function cancel(){pending?.controller.abort();pending=null;prepared=null;}
  function preload(item){
    if(disposed||!current()||item?.kind!=='image-book'){cancel();return;}
    if(pending?.id===item.id||prepared?.id===item.id)return;
    cancel();const task={id:item.id,controller:new AbortController()};pending=task;
    const valid=()=>!disposed&&pending===task&&!task.controller.signal.aborted&&current();
    void (async()=>{const manifest=await pages(item.id,task.controller.signal);if(!valid())return;const first=manifest.pages?.[0];let firstPage=null;
      if(first&&(first.displayUrl||Number.isSafeInteger(first.size)&&first.size<=maxBytes)){firstPage=await blob(first.displayUrl||first.url,task.controller.signal);if(firstPage.size>maxBytes)firstPage=null;}
      if(valid()){prepared={id:item.id,pages:manifest.pages,firstPage,quality:first?.displayUrl?'display':'original'};pending=null;}
    })().catch(()=>{if(pending===task)pending=null;});
  }
  return {preload,take(id){if(disposed||!current()||prepared?.id!==id)return null;const result=prepared;prepared=null;return result;},dispose(){disposed=true;cancel();}};
}
