// Publishing a replacement is the last step: a failed/cancelled lease refresh
// must leave the previous ready package and its ciphertext untouched.
export async function commitDownload({authorize,commit,valid=()=>true,signal,cleanup=async()=>{}}){
  const check=()=>{signal?.throwIfAborted();if(!valid())throw new Error('ログイン先が変更されました。');};
  check();const lease=await authorize();if(lease&&typeof lease==='object')lease.key='';check();
  const ready=await commit();
  if(!valid())throw new Error('ログイン先が変更されました。');
  // Cleanup may be retried independently; failure here cannot undo a successful
  // download or cause the already-published replacement to be reported failed.
  if(valid())await cleanup(ready).catch(()=>{});
  return ready;
}

export function createDownloadResetGuard(){
  const revisions=new Map(),clearing=new Set();
  return {
    revision:partition=>revisions.get(partition)??0,
    valid:(partition,revision)=>!clearing.has(partition)&&(revisions.get(partition)??0)===revision,
    begin(partition){if(clearing.has(partition))throw new Error('保存データを削除中です。少し待ってください。');revisions.set(partition,(revisions.get(partition)??0)+1);clearing.add(partition);return ()=>clearing.delete(partition);}
  };
}

export async function clearNativeTransfers(bridge,partition){
  try{await bridge.clearDownloads({partition});}
  catch(error){
    if(error?.code==='UNIMPLEMENTED'||/not implemented|does not exist|is not a function/i.test(error?.message??''))throw Object.assign(new Error('保存データをすべて削除するにはアプリを更新してください。保存済みデータは削除していません。'),{code:'NATIVE_DOWNLOAD_UPDATE_REQUIRED'});
    throw error;
  }
}
