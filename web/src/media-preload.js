// One bounded, non-playing decoder. It records no view/progress and is owned by
// the current account/endpoint; access is checked again during transition.
export function createMediaPreloader({api,absoluteUrl,attach,scope,current,quality=()=> 'auto',doc=document}){
 let pending,record,disposed=false,request;
 const release=()=>{record?.stream.dispose();if(record){record.video.removeAttribute('src');record.video.load();}record=null;};
 return {async preload(item){if(disposed||!current()||!item||!['video','audio'].includes(item.kind)||item.offlineUnavailable||pending===item.id||record?.id===item.id&&Date.now()-record.at<=300000)return;pending=item.id;release();
   request?.abort();request=new AbortController();try{const ticket=await api(`/items/${item.id}/playback-ticket`,{method:'POST',diagnostics:false,signal:AbortSignal.any([request.signal,AbortSignal.timeout(3000)])});if(disposed||!current()||pending!==item.id)return;const video=doc.createElement(item.kind==='audio'?'audio':'video');video.preload='auto';video.muted=true;const stream=attach(video,{ticket,absoluteUrl,initialQuality:quality(),preload:true});record={id:item.id,ticket,video,stream,scope,at:Date.now()};}catch{/* Speculative media must not produce a visible error. */}finally{if(pending===item.id)pending=null;}
 },take(id){if(!record||record.id!==id||!current()||Date.now()-record.at>300000)return null;const value=record;record=null;return value;},dispose(){disposed=true;pending=null;request?.abort();release();}};
}
