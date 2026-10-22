import {Capacitor,registerPlugin} from '@capacitor/core';
export const NativeTransfer=registerPlugin('MireaTransfer');
export const nativeTransfersAvailable=()=>Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('MireaTransfer');
const waiting=new Map();let listener,contextProvider;
export function configureNativeTransfers(provider){contextProvider=provider;}
export const nativeTransferContext=()=>{const value=contextProvider?.();if(!value)throw Error('ログインしてください。');return value;};
export async function refreshNativeTransfers(){
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
export function nativeUpload(context,shelfId,files,title,onProgress,{retainOriginal=true,seriesId=null}={}){
  return nativeTransferTask(context,'upload',{shelfId,files,title,retainOriginal,...(seriesId?{seriesId}:{})},row=>onProgress(row.state==='processing'||row.state==='complete'?100:Math.min(99,row.percent),row.state==='processing'?{stage:'processing'}:undefined));
}
export function nativeTransferTask(context,direction,job,update=()=>{}){
  let id,stopped=false,processing=false;
  const promise=(async()=>{
    listener??=NativeTransfer.addListener('transferChanged',()=>refreshNativeTransfers().catch(()=>{}));
    await listener;
    const queued=await NativeTransfer.enqueue({...context,direction,job});id=queued.id;
    if(stopped){await NativeTransfer.cancel({...context,id});throw new DOMException('一時停止しました。','AbortError');}
    return new Promise((resolve,reject)=>{waiting.set(id,{context,resolve,reject,update:row=>{processing=row.state==='processing';update(row);}});refreshNativeTransfers().catch(reject);});
  })();
  function abort(){stopped=true;if(id){NativeTransfer.cancel({...context,id}).catch(()=>{});const task=waiting.get(id);waiting.delete(id);task?.reject(new DOMException('一時停止しました。','AbortError'));}}
  return {promise,get processing(){return processing;},abort,detach:abort};
}
export function invalidateTransfers(partition){
  for(const task of waiting.values())task.reject(new DOMException('ログイン先が変更されました。','AbortError'));waiting.clear();
  if(nativeTransfersAvailable()&&partition)NativeTransfer.invalidate({partition}).catch(()=>{});
}
