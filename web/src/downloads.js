import { getSession,getEndpoint,api } from './api.js';
import { openDownloadDb } from './download-db.js';
import { DOWNLOAD_PATH,validateManifest,importDownloadKey,ciphertextHash } from './download-core.js';

const grants=new Map(),tasks=new Set();let workerReady;
const scriptPath=()=>import.meta.env.DEV?'/src/download-sw.js':'/download-sw.js';
const readyWithin=promise=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('暗号化キャッシュの準備がタイムアウトしました。再読み込みして再試行してください。')),10000);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
function context(){
  const session=getSession();if(!session)throw new Error('ログインしてください。');
  const endpoint=getEndpoint(),partition=`${endpoint || location.origin}|${session.user.id}`;
  return {endpoint,partition,userId:session.user.id,token:session.token};
}
const current=ctx=>getSession()?.user.id===ctx.userId && getSession()?.token===ctx.token && getEndpoint()===ctx.endpoint;
const packageKey=(ctx,id)=>`${ctx.partition}|${id}`;
function lock(id){
  const grant=grants.get(id);if(!grant)return;
  grants.delete(id);grant.key=null;navigator.serviceWorker?.controller?.postMessage({type:'mirea-download-lock',id});
}
export function closeDownloads(){
  for(const controller of tasks)controller.abort();tasks.clear();
  for(const [id,grant] of [...grants]){lock(id);grant.onLock?.();}
}
export function downloadsNativeState(active){if(!active)closeDownloads();}
if(typeof window!=='undefined'){
  window.addEventListener('pagehide',closeDownloads);
  navigator.serviceWorker?.addEventListener('message',event=>{
    const port=event.ports?.[0];if(event.data?.type!=='mirea-download-grant' || !port)return;
    const source=event.source?.scriptURL?new URL(event.source.scriptURL):null;
    if(typeof ServiceWorker==='undefined' || !(event.source instanceof ServiceWorker) || !source || source.origin!==location.origin || source.pathname!==scriptPath()){port.postMessage(null);return;}
    const grant=grants.get(event.data.id);
    port.postMessage(grant && current(grant.context) && grant.expiresAt>Date.now()?{key:grant.key,manifest:grant.manifest,expiresAt:grant.expiresAt}:null);port.close();
  });
}
export function ensureDownloadWorker(){
  return workerReady??=(async()=>{
    if(!globalThis.isSecureContext || !crypto.subtle || !globalThis.indexedDB || !navigator.serviceWorker)throw new Error('暗号化ダウンロードにはHTTPSと対応ブラウザー／最新のAndroid WebViewが必要です。');
    const registration=await readyWithin(navigator.serviceWorker.register(scriptPath(),{type:'module',scope:'/',updateViaCache:'none'}));
    await readyWithin(navigator.serviceWorker.ready);
    if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{
      const changed=()=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',changed);resolve();};
      const timer=setTimeout(()=>{navigator.serviceWorker.removeEventListener('controllerchange',changed);reject(new Error('暗号化キャッシュの準備ができません。画面を再読み込みしてください。'));},10000);
      navigator.serviceWorker.addEventListener('controllerchange',changed);
      if(navigator.serviceWorker.controller)changed();
    });
    return registration;
  })().catch(error=>{workerReady=null;throw error;});
}
export async function listDownloads(){const ctx=context(),store=await openDownloadDb();const rows=await store.list(ctx.partition);return current(ctx)?rows:[];}
export async function clearAccountDownloads(){const ctx=context();closeDownloads();if(!globalThis.indexedDB)return;const store=await openDownloadDb();await store.removePartition(ctx.partition);}
export async function removeDownload(assetId){const ctx=context(),store=await openDownloadDb();for(const [id,grant] of [...grants])if(grant.context.partition===ctx.partition && grant.manifest.assetId===assetId){lock(id);grant.onLock?.();}await store.remove(packageKey(ctx,assetId));}
const delay=(ms,signal)=>new Promise((resolve,reject)=>{
  const abort=()=>{clearTimeout(timer);reject(new DOMException('中断しました。','AbortError'));};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});
export async function downloadToDevice(item,onProgress=()=>{},externalSignal,quality){
  const ctx=context(),controller=new AbortController();tasks.add(controller);
  const signal=externalSignal?AbortSignal.any([controller.signal,externalSignal]):controller.signal;
  try{
    await ensureDownloadWorker();signal.throwIfAborted();
    const result=await api(`/items/${item.id}/download`,{method:'POST',signal,...(quality?{body:{quality}}:{})});
    if(!current(ctx))throw new Error('ログイン先が変更されました。');
    const manifest=validateManifest(result.manifest);
    if(manifest.assetId!==item.id)throw new Error('アセットが一致しません。');
    const total=manifest.files.reduce((n,file)=>n+file.size,0),parts=manifest.files.reduce((n,file)=>n+file.chunks,0);
    const store=await openDownloadDb(),key=packageKey(ctx,item.id),existing=await store.getPackage(key);
    const estimate=await navigator.storage?.estimate?.().catch(()=>null);
    if(existing?.manifest.id!==manifest.id && estimate?.quota && estimate.quota-(estimate.usage??0)<total+parts*28+10*1024*1024)throw new Error('端末の空き容量が不足しています。不要なダウンロードを削除してください。');
    await store.savePackage(key,ctx.partition,manifest);
    let received=0;
    for(const file of manifest.files)for(let part=0;part<file.chunks;part++){
      signal.throwIfAborted();if(!current(ctx))throw new Error('ログイン先が変更されました。');
      const length=Math.min(manifest.chunkSize,file.size-part*manifest.chunkSize),cached=await store.getChunk(manifest.id,file.index,part);
      if(cached?.bytes.byteLength===length+28 && await ciphertextHash(cached.bytes)===cached.sha256){received+=length;onProgress({received,total});continue;}
      let lastError;
      for(let attempt=0;attempt<3;attempt++){
        try{
          const response=await fetch(`${ctx.endpoint}/api/v1/downloads/${manifest.id}/files/${file.index}/parts/${part}`,{headers:{Authorization:`Bearer ${ctx.token}`},signal:AbortSignal.any([signal,AbortSignal.timeout(60000)]),cache:'no-store'});
          if(!response.ok)throw Object.assign(new Error((await response.json().catch(()=>({}))).error || 'ダウンロードに失敗しました。'),{status:response.status});
          const bytes=await response.arrayBuffer(),sha256=response.headers.get('X-Chunk-SHA256');
          if(bytes.byteLength!==length+28 || !sha256 || await ciphertextHash(bytes)!==sha256)throw new Error('分割データを検証できません。');
          signal.throwIfAborted();if(!current(ctx))throw new Error('ログイン先が変更されました。');
          await store.putChunk(key,manifest.id,file.index,part,bytes,sha256);lastError=null;break;
        }catch(error){
          lastError=error;signal.throwIfAborted();if([400,401,403,404,409].includes(error.status) || error.name==='QuotaExceededError')throw error;
          if(attempt<2)await delay(1000*2**attempt,signal);
        }
      }
      if(lastError)throw lastError;received+=length;onProgress({received,total});
    }
    signal.throwIfAborted();return await store.complete(key,manifest.id);
  }finally{tasks.delete(controller);}
}

// This function always calls the server when a ready download is opened.
export async function openDownloaded(item,onLock=()=>{}){
  const ctx=context();let store;
  try{store=await openDownloadDb();}catch{return null;} // Normal online viewing does not require IndexedDB.
  const record=await store.getPackage(packageKey(ctx,item.id));
  if(!record || record.state!=='ready')return null;
  await ensureDownloadWorker();let id,disposed=false;
  async function authorize(){
    let response;
    try{response=await api(`/downloads/${record.manifest.id}/open`,{method:'POST',signal:AbortSignal.timeout(10000)});}
    catch(error){throw Object.assign(new Error(`保存済みアセットを開くにはオンラインでのアクセス権確認が必要です。${error.message}`),{status:error.status});}
    const manifest=validateManifest(response.manifest);
    if(manifest.id!==record.manifest.id || manifest.assetId!==item.id || manifest.kind!==item.kind)throw new Error('保存情報が一致しません。再ダウンロードしてください。');
    const key=await importDownloadKey(response.key);response.key='';
    if(disposed || !current(ctx))throw new Error('閲覧セッションは終了しました。');
    if(id)lock(id);id=crypto.randomUUID();
    grants.set(id,{key,manifest,expiresAt:response.expiresAt,context:ctx,onLock});
    return manifest;
  }
  const manifest=await authorize();
  return {manifest,url:index=>`${DOWNLOAD_PATH}${id}/${index}`,
    pages:manifest.files.map(file=>({...file,url:`${DOWNLOAD_PATH}${id}/${file.index}`})),
    async pageBlob(number,signal){const file=manifest.files.find(file=>file.number===number);if(!file)throw new Error('ページが見つかりません。');const response=await fetch(`${DOWNLOAD_PATH}${id}/${file.index}`,{signal,cache:'no-store'});if(!response.ok)throw new Error('保存済みページを開けません。オンラインで開き直してください。');return response.blob();},
    async reconnect(){await authorize();return `${DOWNLOAD_PATH}${id}/0`;},
    dispose(){disposed=true;if(id)lock(id);}
  };
}
