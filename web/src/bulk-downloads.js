export function downloadableSnapshot(items){
  const seen=new Set();return items.filter(item=>!item.pending&&!seen.has(item.id)&&seen.add(item.id)).map(item=>({...item}));
}
// Serial transfers respect per-user limits. A cancelled transfer retains its
// encrypted chunks, and authentication changes stop the entire queue.
export async function runBulkDownloads(items,{list,download,signal,isCurrent=()=>true,changed=()=>{}}){
  const queue=downloadableSnapshot(items),saved=new Set((await list()).filter(row=>row.state==='ready').map(row=>row.assetId));
  const result={total:queue.length,completed:0,skipped:0,failed:[],cancelled:false};
  for(const [index,item] of queue.entries()){
    if(signal?.aborted||!isCurrent()){result.cancelled=true;break;}
    if(saved.has(item.id)){result.skipped++;changed({...result,index,item,state:'skipped'});continue;}
    changed({...result,index,item,state:'downloading',received:0,totalBytes:item.size});
    try{
      await download(item,progress=>{if(!signal?.aborted&&isCurrent())changed({...result,index,item,state:'downloading',received:progress.received,totalBytes:progress.total});},signal);
      result.completed++;changed({...result,index,item,state:'complete'});
    }catch(error){
      if(signal?.aborted||error.name==='AbortError'||!isCurrent()){result.cancelled=true;break;}
      result.failed.push({id:item.id,title:item.title,message:error.message||'取得に失敗しました。'});changed({...result,index,item,state:'failed'});
      if([401,403].includes(error.status)||error.name==='QuotaExceededError'){result.cancelled=true;break;}
    }
  }
  changed({...result,state:'finished'});return result;
}
