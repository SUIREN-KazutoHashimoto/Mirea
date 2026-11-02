import {Capacitor,registerPlugin} from '@capacitor/core';
import {ciphertextHash} from './download-core.js';
export const NativeTransfer=registerPlugin('MireaTransfer');
export const nativeTransfersAvailable=()=>Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('MireaTransfer');
const waiting=new Map(),active=new Set(),invalidating=new Map();let listener,contextProvider;
const contextKey=context=>(context.origin||location.origin)+'|'+context.userId;
export function configureNativeTransfers(provider){contextProvider=provider;}
export const nativeTransferContext=()=>{const value=contextProvider?.();if(!value)throw Error('ログインしてください。');return value;};
let refreshing,pendingRefresh=false;
export function refreshNativeTransfers(){
  if(refreshing){pendingRefresh=true;return refreshing;}
  refreshing=(async()=>{await new Promise(resolve=>setTimeout(resolve,100));await readNativeTransfers();})().finally(()=>{refreshing=null;if(pendingRefresh&&waiting.size){pendingRefresh=false;refreshNativeTransfers().catch(()=>{});}});return refreshing;
}
async function readNativeTransfers(){
  if(!nativeTransfersAvailable()||!waiting.size)return;
  const context=nativeTransferContext(),result=await NativeTransfer.status(context);
  for(const row of result.jobs??[]){
    const task=waiting.get(row.id);if(!task)continue;
    if(task.context.origin!==context.origin||task.context.userId!==context.userId){task.reject(Error('ログイン先が変更されました。'));waiting.delete(row.id);continue;}
    task.update(row);
    if(row.state==='complete'){waiting.delete(row.id);task.resolve(row.result);}
    else if(row.state==='failed'||row.state==='cancelled'){waiting.delete(row.id);task.reject(Object.assign(Error(row.error||'転送を一時停止しました。'),{status:row.status,name:row.state==='cancelled'?'AbortError':'Error'}));}
  }
}
export async function requestTransferNotifications(){
  if(nativeTransfersAvailable()){const result=await NativeTransfer.notifications().catch(()=>({granted:false}));await NativeTransfer.prepare();return result;}
  if(globalThis.Notification&&Notification.permission==='default')return {granted:await Notification.requestPermission()==='granted'};
  return {granted:globalThis.Notification?.permission==='granted'};
}
export function nativeUpload(context,shelfId,files,title,onProgress,{retainOriginal=true,seriesId=null,protocolVersion=1,monitorProcessing=true,clientTransferId}={}){
  return nativeTransferTask(context,'upload',{shelfId,files,title,retainOriginal,protocolVersion,monitorProcessing,...(clientTransferId?{clientTransferId}:{}),...(seriesId?{seriesId}:{})},row=>onProgress(row.state==='processing'||row.state==='complete'?100:Math.min(99,row.percent),row.state==='processing'?{stage:'processing'}:row.state==='queued'?{stage:'waiting-slot'}:undefined));
}
export function nativeTransferTask(context,direction,job,update=()=>{}){
  let id,uploadId,stopped=false,cleanupOnAbort=true,processing=false,transferredResolve,transferredReject;
  const operation={context,abort:()=>abort(false)};active.add(operation);
  const transferred=new Promise((resolve,reject)=>{transferredResolve=resolve;transferredReject=reject;});transferred.catch(()=>{});
  const promise=(async()=>{
    listener??=NativeTransfer.addListener('transferChanged',()=>refreshNativeTransfers().catch(()=>{}));
    await listener;
    // A new session for this account must not enqueue until an older logout's
    // native cancellation has completed. Other accounts remain independent.
    await invalidating.get(contextKey(context));
    if(stopped)throw new DOMException('一時停止しました。','AbortError');
    const queued=await NativeTransfer.enqueue({...context,direction,job});id=queued.id;
    if(stopped){await NativeTransfer.cancel({...context,id,cleanup:cleanupOnAbort});throw new DOMException('一時停止しました。','AbortError');}
    return new Promise((resolve,reject)=>{waiting.set(id,{context,resolve,reject,update:row=>{uploadId=row.uploadId;processing=row.state==='processing';if(processing||row.state==='complete')transferredResolve({id:row.uploadId});update(row);}});refreshNativeTransfers().catch(reject);});
  })().catch(error=>{transferredReject(error);throw error;}).finally(()=>active.delete(operation));
  function abort(cleanup=true){stopped=true;cleanupOnAbort=cleanup;if(id){NativeTransfer.cancel({...context,id,cleanup}).catch(()=>{});const task=waiting.get(id);waiting.delete(id);task?.reject(new DOMException('一時停止しました。','AbortError'));}}
  return {promise,transferred,get uploadId(){return uploadId;},get processing(){return processing;},abort,detach:()=>abort(false)};
}
export function invalidateTransfers(context){
  const key=contextKey(context);
  // Cancel the old JavaScript operations immediately, before asynchronous
  // hashing can allow another account's newly queued operations to appear.
  for(const task of active)if(contextKey(task.context)===key)task.abort();
  if(!nativeTransfersAvailable())return Promise.resolve();
  const previous=invalidating.get(key),pending=(async()=>{
    await previous?.catch(()=>{});
    const partition=await ciphertextHash(new TextEncoder().encode(key));
    await NativeTransfer.invalidate({partition});
  })();invalidating.set(key,pending);
  pending.then(()=>{if(invalidating.get(key)===pending)invalidating.delete(key);},()=>{});
  return pending;
}
