import {absoluteUrl,authHeaders,getSession} from './api.js';
import {nativeExportAvailable,nativeFileWriter} from './file-export.js';
import {beginUpdateActivity} from './update-busy.js';

async function guarded(work){const release=beginUpdateActivity();try{return await work();}finally{release();}}
export const saveBlob=(...args)=>guarded(()=>saveBlobFile(...args));
async function saveBlobFile(blob,name){
  if(nativeExportAvailable()){
    const session=getSession(),writer=await nativeFileWriter(name,blob.type||'application/octet-stream',blob.size);
    try{for(let offset=0;offset<blob.size;offset+=256*1024){if(getSession()!==session)throw new Error('ログイン状態が変わりました。');await writer.write(await blob.slice(offset,offset+256*1024).arrayBuffer());}await writer.close();}
    catch(error){await writer.abort().catch(()=>{});throw error;}return;
  }
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
// Bounded ranges work through Cloudflare. File System Access writes encrypted
// bytes directly; other browsers download explicit numbered parts, never GB blobs.
export const saveBackup=(...args)=>guarded(()=>saveBackupFile(...args));
async function saveBackupFile(row,onProgress,offset=0,isCurrent=()=>true){
  const session=getSession(),name=`mirea-${row.mode}-${row.id}.mireabackup`,chunk=8*1024*1024;
  const native=nativeExportAvailable(),picker=!native&&typeof window.showSaveFilePicker==='function' && offset===0;
  const file=picker?await window.showSaveFilePicker({suggestedName:name}):null;
  const writable=native?await nativeFileWriter(name,'application/octet-stream',row.size):file?await file.createWritable():null;let position=offset;
  try{
    do{
      if(getSession()!==session||!isCurrent())throw new Error('ダウンロードを取り消しました。');
      const end=Math.min(position+chunk,row.size)-1;
      const response=await fetch(absoluteUrl(`/api/v1/admin/backups/${row.id}/content`),{headers:{...authHeaders(),Range:`bytes=${position}-${end}`},cache:'no-store'});
      if(response.status!==206 || response.headers.get('content-range')!==`bytes ${position}-${end}/${row.size}`)throw new Error('バックアップの分割取得に失敗しました。');
      const bytes=await response.arrayBuffer();if(bytes.byteLength!==end-position+1 || getSession()!==session || !isCurrent())throw new Error('受信データまたはログイン状態が変わりました。');
      if(writable)await writable.write(bytes);else await saveBlob(new Blob([bytes],{type:'application/octet-stream'}),row.size<=chunk?name:`${name}.part-${String(Math.floor(position/chunk)+1).padStart(6,'0')}`);
      position=end+1;onProgress(position,row.size);
    }while(writable && position<row.size);
    await writable?.close();return {offset:position,complete:position===row.size,parts:!writable&&row.size>chunk};
  }catch(error){await writable?.abort().catch(()=>{});throw error;}
}

export function mountPersonalExport(container,{api,flush}){
  let cursor=0,disposed=false;
  container.innerHTML='<p>詳細な閲覧・操作ログは無期限で保存されます。内容はこの画面に表示せず、本人のログだけをNDJSONで取得できます。1ファイル最大1,000件で、続きは同じボタンから取得します。出力は平文の個人情報なので、保存先と取り扱いにご注意ください。</p><button class="button secondary personal-export">自分の閲覧記録をダウンロード</button><p class="personal-export-status" role="status"></p>';
  const button=container.querySelector('button'),status=container.querySelector('[role=status]');
  button.onclick=async()=>{
    const session=getSession();button.disabled=true;
    try{
      await flush();const data=await api(`/analytics/me/events?limit=1000&after=${cursor}`);
      if(disposed||getSession()!==session)return;
      await saveBlob(new Blob([data.events.map(row=>JSON.stringify(row)).join('\n')+(data.events.length?'\n':'')],{type:'application/x-ndjson'}),`mirea-my-records-after-${cursor}.ndjson`);
      cursor=data.nextCursor;status.textContent=`${data.events.length}件を出力しました。${data.hasMore?'続きがあります。':'現時点の末尾まで取得しました。'}`;
      button.textContent=data.hasMore?'続きの閲覧記録をダウンロード':'以降の新しい閲覧記録をダウンロード';
    }catch(error){if(!disposed)status.textContent=error.message;}finally{if(!disposed)button.disabled=false;}
  };return ()=>{disposed=true;};
}
