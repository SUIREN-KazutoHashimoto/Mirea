import { getSession,getEndpoint,sessionRevision,isOfflineSession,api,authenticatedBlob } from './api.js';
import { openDownloadDb } from './download-db.js';
import { DOWNLOAD_PATH,validateManifest,importDownloadKey,ciphertextHash } from './download-core.js';
import { NativePlayer,nativePlayerAvailable } from './native-player-bridge.js';
import { beginUpdateActivity } from './update-busy.js';
import {rememberDownloadProgress} from './progress.js';
import {offlineVault} from './offline-vault.js';
import {nativeTransfersAvailable,NativeTransfer,nativeTransferTask} from './native-transfers.js';
import {trackTransfer} from './transfer-manager.js';
import {shelfUnlockValue} from './private-shelves.js';
import {transferRetryDelay,abortableDelay} from './transfer-retry.js';
import {offlineCatalog} from './offline-catalog.js';
import {syncAiContent} from './ai-offline.js';
import {commitDownload,createDownloadResetGuard,clearNativeTransfers} from './download-commit.js';

let nativeImport;const downloadReset=createDownloadResetGuard(),removing=new Set();
export function syncNativeDownloads(){
  if(!nativeTransfersAvailable()||!getSession()?.token)return Promise.resolve();
  const ctx=context();if(!current(ctx))return Promise.resolve();
  if(nativeImport)return nativeImport;
  nativeImport=(async()=>{
    const args={origin:ctx.endpoint,token:ctx.token,userId:ctx.userId},store=await openDownloadDb();
    const completed=await NativeTransfer.completed(args);
    for(const incoming of completed.manifests??[]){
      if(!current(ctx))return;const manifest=validateManifest(incoming),key=packageKey(ctx,manifest.assetId);if(removing.has(key))continue;const existing=await store.getPackage(key);
      const nativeReady=Boolean(nativePlayerAvailable()&&['audio','video'].includes(manifest.kind)&&completed.nativeReadyIds?.includes(manifest.id)&&(await NativePlayer.cacheBegin({...args,manifest})).ready);
      if(nativeReady)await store.savePackage(key,ctx.partition,manifest);
      else if(existing?.manifest.id!==manifest.id||existing.state!=='ready'||existing.nativeReady){
        await ensureDownloadWorker();await store.savePackage(key,ctx.partition,manifest);
        for(const file of manifest.files)for(let part=0;part<file.chunks;part++){
          if(!current(ctx))return;
          if(removing.has(key))throw new DOMException('保存データを削除しています。','AbortError');
          const old=await store.getChunk(manifest.id,file.index,part),length=Math.min(manifest.chunkSize,file.size-part*manifest.chunkSize)+28;
          if(old?.bytes.byteLength===length&&await ciphertextHash(old.bytes)===old.sha256)continue;
          const chunk=await NativeTransfer.readChunk({...args,id:manifest.id,file:file.index,part}),bytes=Uint8Array.from(atob(chunk.bytes),c=>c.charCodeAt(0)).buffer;
          if(bytes.byteLength!==length||await ciphertextHash(bytes)!==chunk.sha256)throw Error('バックグラウンド転送の保存データを検証できません。');
          if(!current(ctx))return;if(removing.has(key))throw new DOMException('保存データを削除しています。','AbortError');await store.putChunk(key,manifest.id,file.index,part,bytes,chunk.sha256);
        }
      }
      await commitDownload({valid:()=>current(ctx)&&!removing.has(key),authorize:async()=>{
        const grant=await NativeTransfer.lease({...args,id:manifest.id});if(!current(ctx))throw Error('ログイン先が変更されました。');
        if(grant.manifest?.id!==manifest.id||grant.manifest?.assetId!==manifest.assetId)throw Error('保存情報が一致しません。');
        const vault=await offlineVault();await vault.saveLease(ctx.partition,grant,ctx.userId);grant.key='';
        if(grant.cover&&['image/jpeg','image/png','image/webp'].includes(grant.cover.mime)&&typeof grant.cover.bytes==='string'&&grant.cover.bytes.length<=2796204)await vault.seal(ctx.partition,'cover:'+manifest.assetId,grant.cover);
      },commit:()=>nativeReady?store.completeNative(key,manifest.id):store.complete(key,manifest.id),cleanup:ready=>cleanupReplacedDownload(ctx,existing,ready)});
      if(current(ctx)){await NativeTransfer.remove({...args,id:manifest.id});if(!isOfflineSession()){saveThumbnail(ctx,manifest.assetId);void syncAiContent({origin:ctx.endpoint,userId:ctx.userId,token:ctx.token},manifest.assetId,api,()=>current(ctx)).catch(()=>{});}}
    }
    if(current(ctx)&&(completed.manifests?.length??0)>0)window.dispatchEvent(new Event('mirea:downloads-imported'));
  })().finally(()=>{nativeImport=null;});return nativeImport;
}
const grants=new Map(),tasks=new Set();let workerReady;
const scriptPath=()=>import.meta.env.DEV?'/src/download-sw.js':'/download-sw.js';
const readyWithin=promise=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('暗号化キャッシュの準備がタイムアウトしました。再読み込みして再試行してください。')),10000);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
function context(){
  const session=getSession();if(!session)throw new Error('ログインしてください。');
  const endpoint=getEndpoint(),partition=`${endpoint || location.origin}|${session.user.id}`;
  return {endpoint,partition,userId:session.user.id,token:session.token,revision:sessionRevision(),downloadRevision:downloadReset.revision(partition)};
}
const current=ctx=>downloadReset.valid(ctx.partition,ctx.downloadRevision)&&getSession()?.user.id===ctx.userId && sessionRevision()===ctx.revision && getEndpoint()===ctx.endpoint;
const packageKey=(ctx,id)=>`${ctx.partition}|${id}`;
async function cleanupReplacedDownload(ctx,previous,ready){
  if(!previous||previous.manifest.id===ready.manifest.id||ready.retired?.some(row=>row.id===previous.manifest.id))return;
  await cleanupRetiredDownload(ctx,{id:previous.manifest.id,assetId:previous.assetId});
}
async function cleanupRetiredDownload(ctx,previous){
  if(!current(ctx))return;
  if(nativePlayerAvailable()){
    const partition=await ciphertextHash(new TextEncoder().encode(ctx.partition));
    await NativePlayer.cacheRetire({partition,id:previous.id});
  }
  await(await offlineVault()).revoke(ctx.partition,previous.id);
}
function lock(id){
  const grant=grants.get(id);if(!grant)return;
  grants.delete(id);grant.key=null;grant.release?.().catch(()=>{});navigator.serviceWorker?.controller?.postMessage({type:'mirea-download-lock',id});
}
export function closeDownloads(){
  for(const controller of tasks)controller.abort();tasks.clear();
  for(const [id,grant] of [...grants]){lock(id);grant.onLock?.();}
}
export function downloadsNativeState(active){if(!active){for(const [id,grant]of [...grants]){lock(id);grant.onLock?.('background');}}}
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
// A list read must never wait for a multi-gigabyte native ciphertext import.
export async function listDownloads(){const ctx=context(),store=await openDownloadDb();for(const row of await store.collectExpired(ctx.partition))await cleanupRetiredDownload(ctx,row).catch(()=>{});const rows=await store.list(ctx.partition);syncNativeDownloads().catch(()=>{});return current(ctx)?rows:[];}
export async function downloadedThumbnail(assetId){
  const ctx=context(),store=await openDownloadDb(),row=await store.getPackage(packageKey(ctx,assetId));
  if(row?.state!=='ready')return null;
  const vault=await offlineVault(),lease=await vault.lease(ctx.partition,row.manifest.id).catch(()=>null);if(!lease)return null;lease.key='';
  const latest=await(await offlineCatalog()).storedCover(ctx.partition,assetId);if(latest&&current(ctx))return latest;
  const cover=await vault.unseal(ctx.partition,'cover:'+assetId);
  if(!cover||!current(ctx)||!['image/jpeg','image/png','image/webp'].includes(cover.mime)||typeof cover.bytes!=='string'||cover.bytes.length>2796204)return null;
  return new Blob([Uint8Array.from(atob(cover.bytes),c=>c.charCodeAt(0))],{type:cover.mime});
}
async function saveThumbnail(ctx,assetId){
  try{
    const blob=await authenticatedBlob(`/api/v1/items/${assetId}/thumbnail`,AbortSignal.timeout(10000));if(!current(ctx)||blob.size>2097152||!['image/jpeg','image/png','image/webp'].includes(blob.type))return;
    const bytes=new Uint8Array(await blob.arrayBuffer()),pieces=[];
    for(let n=0;n<bytes.length;n+=8192)pieces.push(String.fromCharCode(...bytes.subarray(n,n+8192)));
    await(await offlineVault()).seal(ctx.partition,'cover:'+assetId,{mime:blob.type,bytes:btoa(pieces.join(''))});bytes.fill(0);
  }catch{/* A missing cover must not make a complete encrypted book unusable. */}
}
export async function clearAccountDownloads(){
  const ctx=context(),finish=downloadReset.begin(ctx.partition);closeDownloads();
  try{
    // Invalidate any old importer before awaiting it, then stop native writers
    // and erase their completion records before deleting the published copies.
    await nativeImport?.catch(()=>{});
    await Promise.allSettled([...downloading].filter(([key])=>key.startsWith(ctx.partition+'|')).map(([,task])=>task.promise));
    const partition=await ciphertextHash(new TextEncoder().encode(ctx.partition));
    if(nativeTransfersAvailable())await clearNativeTransfers(NativeTransfer,partition);
    if(nativePlayerAvailable()){await NativePlayer.stop();await NativePlayer.cacheClear({partition});await NativePlayer.leaseClear({partition});}
    if(!globalThis.indexedDB)return;const store=await openDownloadDb();await(await offlineVault()).forget(ctx.endpoint,ctx.userId);await store.removePartition(ctx.partition);
  }finally{finish();}
}
export async function removeDownload(assetId){
  const ctx=context(),identity=packageKey(ctx,assetId);
  if(removing.has(identity))throw new Error('この作品の保存データを削除中です。少し待ってください。');
  removing.add(identity);const pending=downloading.get(identity);pending?.controller.abort();
  try{
  // A manifest request can still be in flight before there is a package row.
  // Stop that writer and wait for its finalization before deleting storage.
  await pending?.promise.catch(()=>{});
  if(nativeTransfersAvailable())await NativeTransfer.removeAsset({origin:ctx.endpoint,token:ctx.token,userId:ctx.userId,assetId});
  await nativeImport?.catch(()=>{});
  const store=await openDownloadDb();
  for(const [id,grant] of [...grants])if(grant.context.partition===ctx.partition&&grant.manifest.assetId===assetId){lock(id);grant.onLock?.();}
  const row=await store.getPackage(packageKey(ctx,assetId)),records=[row,row?.pending,...(row?.retired??[]).map(old=>({manifest:{id:old.id}}))].filter(Boolean);
  if(nativePlayerAvailable()&&row&&current(ctx)){
    if((await NativePlayer.status()).item?.id===assetId)await NativePlayer.stop();
    const partition=await ciphertextHash(new TextEncoder().encode(ctx.partition));
    for(const record of records){await NativePlayer.cacheRemove({partition,id:record.manifest.id});await NativePlayer.leaseRevoke({partition,id:record.manifest.id});}
  }
  const vault=await offlineVault();for(const record of records)await vault.revoke(ctx.partition,record.manifest.id);
  await store.remove(identity);
  }finally{removing.delete(identity);}
}
const downloading=new Map();
export function downloadToDevice(item,onProgress=()=>{},externalSignal,quality){
  const ctx=context(),identity=packageKey(ctx,item.id);
  if(!current(ctx))return Promise.reject(new Error('保存データを削除中です。少し待ってからダウンロードしてください。'));
  if(removing.has(identity))return Promise.reject(new Error('この作品の保存データを削除中です。少し待ってからダウンロードしてください。'));
  if(downloading.has(identity))return Promise.reject(new Error('この作品は転送中です。「転送状況」を確認してください。'));
  const controller=new AbortController(),signal=externalSignal?AbortSignal.any([controller.signal,externalSignal]):controller.signal;
  const row=trackTransfer({direction:'download',title:item.title,notifications:!nativeTransfersAvailable(),cancel:()=>controller.abort(),work:update=>performDownload(ctx,item,value=>{onProgress(value);update({percent:value.total?value.received/value.total*100:0,message:value.message||'暗号化データを保存中'});},signal,quality)});
  const promise=row.promise.finally(()=>{if(downloading.get(identity)?.promise===promise)downloading.delete(identity);});downloading.set(identity,{promise,controller});return promise;
}
async function performDownload(ctx,item,onProgress=()=>{},externalSignal,quality){
  const controller=new AbortController(),releaseUpdate=beginUpdateActivity();tasks.add(controller);
  const signal=externalSignal?AbortSignal.any([controller.signal,externalSignal]):controller.signal;
  try{
    signal.throwIfAborted();if(!current(ctx))throw new Error('ログイン先が変更されました。');
    if(nativeTransfersAvailable()){
      const nativeContext={origin:ctx.endpoint,token:ctx.token,userId:ctx.userId,shelfUnlock:shelfUnlockValue()},task=nativeTransferTask(nativeContext,'download',{assetId:item.id,title:item.title,...(quality?{quality}:{})},row=>onProgress({received:row.received,total:row.total||item.size,message:row.state==='queued'?'順番待ち':'暗号化データを保存中'}));
      const stop=()=>task.abort();signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
      try{
        const result=await task.promise;signal.throwIfAborted();if(!current(ctx))throw new Error('ログイン先が変更されました。');
        await syncNativeDownloads();const store=await openDownloadDb(),key=packageKey(ctx,item.id);let ready=await store.getPackage(key);
        // Another import may have taken its completion snapshot before this task.
        if(ready?.manifest.id!==result.manifest?.id){await syncNativeDownloads();ready=await store.getPackage(key);}
        signal.throwIfAborted();if(!current(ctx))throw new Error('ログイン先が変更されました。');
        if(ready?.manifest.id!==result.manifest?.id||ready.state!=='ready')throw new Error('保存内容の確認が完了していません。もう一度ダウンロードを再開してください。');
        return ready;
      }
      finally{signal.removeEventListener('abort',stop);}
    }
    await ensureDownloadWorker();await navigator.storage?.persist?.().catch(()=>false);signal.throwIfAborted();
    const result=await api(`/items/${item.id}/download`,{method:'POST',signal,...(quality?{body:{quality}}:{})});
    signal.throwIfAborted();
    if(!current(ctx))throw new Error('ログイン先が変更されました。');
    const manifest=validateManifest(result.manifest);
    if(manifest.assetId!==item.id)throw new Error('アセットが一致しません。');
    const total=manifest.files.reduce((n,file)=>n+file.size,0),parts=manifest.files.reduce((n,file)=>n+file.chunks,0);
    const store=await openDownloadDb(),key=packageKey(ctx,item.id),existing=await store.getPackage(key);
    const estimate=await navigator.storage?.estimate?.().catch(()=>null);
    if(existing?.manifest.id!==manifest.id&&existing?.pending?.manifest.id!==manifest.id&&estimate?.quota&&estimate.quota-(estimate.usage??0)<total+parts*28+10*1024*1024)throw new Error('端末の空き容量が不足しています。不要なダウンロードを削除してください。');
    const candidate=await store.savePackage(key,ctx.partition,manifest);
    let received=0;
    for(const file of manifest.files)for(let part=0;part<file.chunks;part++){
      signal.throwIfAborted();if(!current(ctx))throw new Error('ログイン先が変更されました。');
      const length=Math.min(manifest.chunkSize,file.size-part*manifest.chunkSize),cached=await store.getChunk(manifest.id,file.index,part);
      if(cached?.bytes.byteLength===length+28 && await ciphertextHash(cached.bytes)===cached.sha256){received+=length;onProgress({received,total});continue;}
      for(let attempt=0;;attempt++){
        try{
          const response=await fetch(`${ctx.endpoint}/api/v1/downloads/${manifest.id}/files/${file.index}/parts/${part}`,{headers:{Authorization:`Bearer ${ctx.token}`},signal:AbortSignal.any([signal,AbortSignal.timeout(60000)]),cache:'no-store'});
          if(!response.ok)throw Object.assign(new Error((await response.json().catch(()=>({}))).error || 'ダウンロードに失敗しました。'),{status:response.status,retryAfter:response.headers.get('Retry-After')});
          const bytes=await response.arrayBuffer(),sha256=response.headers.get('X-Chunk-SHA256');
          if(bytes.byteLength!==length+28 || !sha256 || await ciphertextHash(bytes)!==sha256)throw Object.assign(new Error('分割データを検証できません。'),{code:'DOWNLOAD_INTEGRITY_FAILED'});
          signal.throwIfAborted();if(!current(ctx))throw new Error('ログイン先が変更されました。');
          await store.putChunk(key,manifest.id,file.index,part,bytes,sha256);break;
        }catch(error){
          signal.throwIfAborted();if(!current(ctx))throw new Error('ログイン先が変更されました。');
          const wait=transferRetryDelay(error,attempt);if(wait===null)throw error;
          onProgress({received,total,message:'接続を待っています。受信済みの続きから自動再開します。'});
          await abortableDelay(wait,signal);
        }
      }
      received+=length;onProgress({received,total});
    }
    const nativeReady=nativePlayerAvailable()&&['video','audio'].includes(item.kind);
    const complete=await commitDownload({signal,valid:()=>current(ctx),authorize:async()=>{
      const lease=await authorizeDownload(ctx,candidate);
      if(nativeReady)await prepareNativeRecord(ctx,store,candidate,()=>current(ctx)&&!signal.aborted,()=>{},lease);
      return lease;
    },commit:()=>nativeReady?store.completeNative(key,manifest.id):store.complete(key,manifest.id),cleanup:ready=>cleanupReplacedDownload(ctx,existing,ready)});
    await saveThumbnail(ctx,item.id);
    if(current(ctx))void syncAiContent({origin:ctx.endpoint,userId:ctx.userId,token:ctx.token},item.id,api,()=>current(ctx)).catch(()=>{});
    try{const snapshot=await api(`/items/${item.id}/progress`);if(current(ctx))rememberDownloadProgress(item,snapshot);}catch{/* The exact cached baseline is kept until the next online sync. */}
    return complete;
  }finally{tasks.delete(controller);releaseUpdate();}
}

const denied=error=>[400,401,403,404,409,410,422].includes(error.status);
export async function authorizeDownload(ctx,record){
  const vault=await offlineVault();let grant;
  try{
    if(isOfflineSession())throw new Error('オフラインです。');
    grant=await api(`/downloads/${record.manifest.id}/open`,{method:'POST',signal:AbortSignal.timeout(2500)});
    if(!current(ctx))throw Object.assign(new Error('ログイン先が変更されました。'),{status:401});
    if(grant.manifest?.id!==record.manifest.id||grant.manifest?.assetId!==record.assetId)throw Object.assign(new Error('保存情報が一致しません。'),{status:409});
    await vault.saveLease(ctx.partition,grant,ctx.userId);
  }catch(error){
    if(denied(error)){
      await vault.revoke(ctx.partition,record.manifest.id);
      for(const [id,active] of [...grants])if(active.context.partition===ctx.partition&&active.manifest.id===record.manifest.id){lock(id);active.onLock?.();}
      if(nativePlayerAvailable())await NativePlayer.leaseRevoke({partition:await ciphertextHash(new TextEncoder().encode(ctx.partition)),id:record.manifest.id});
      throw error;
    }
    // Failed connections never extend a previously authenticated lease.
    grant=await vault.lease(ctx.partition,record.manifest.id);
    if(!current(ctx))throw new Error('閲覧セッションは終了しました。');
    if(!grant)throw new Error('オフライン視聴期限（最終接続から7日）が切れています。オンラインで接続してください。');
    return grant;
  }
  grant.key='';return {...await vault.lease(ctx.partition,record.manifest.id),online:true};
}
let syncing;const syncTimes=new Map();
export function syncDownloads({items=[],force=false,refreshCovers=false}={}){
  if(syncing)return syncing;
  syncing=(async()=>{
    const ctx=context(),store=await openDownloadDb();
    if(isOfflineSession()||!force&&Date.now()-(syncTimes.get(ctx.partition)??0)<300000)return;
    for(const row of await store.list(ctx.partition)){
      if(!current(ctx))return;
      if(row.state!=='ready')continue;
      try{
        const lease=await authorizeDownload(ctx,row);
        // A failed reachability check never starts hundreds of lease/cover
        // requests. Opening an individual asset still authorizes independently.
        if(!lease.online)return;
        if(refreshCovers||!await downloadedThumbnail(row.assetId))await saveThumbnail(ctx,row.assetId);
        try{const snapshot=await api(`/items/${row.assetId}/progress`);if(current(ctx))rememberDownloadProgress({id:row.assetId},snapshot);}catch{/* Pending revisions must never be overwritten. */}
        if(nativePlayerAvailable()&&['audio','video'].includes(row.manifest.kind)){
          if(lease.online)await NativePlayer.leaseSave({origin:ctx.endpoint,token:ctx.token,userId:ctx.userId,shelfUnlock:shelfUnlockValue(),id:row.manifest.id});lease.key='';
        }
      }catch(error){
        const item=items.find(item=>item.id===row.assetId&&!item.pending);
        if(error.status===409&&item)await downloadToDevice(item,()=>{},undefined,row.manifest.files[0].quality);
        else if(!denied(error))throw error;
      }
      await new Promise(resolve=>setTimeout(resolve,400));
    }
    if(current(ctx))syncTimes.set(ctx.partition,Date.now());
  })().finally(()=>{syncing=null;});return syncing;
}
export async function openDownloaded(item,onLock=()=>{},replacementRetry=false){
  const ctx=context();let store;
  try{store=await openDownloadDb();}catch{return null;} // Normal online viewing does not require IndexedDB.
  const record=await store.getPackage(packageKey(ctx,item.id));
  if(!record || record.state!=='ready')return null;
  await ensureDownloadWorker();let id,disposed=false,expiryTimer;
  const scheduleExpiry=expires=>{clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>{if(!disposed){if(id)lock(id);onLock();}},Math.max(0,expires-Date.now()));};
  async function authorize(){
    const response=await authorizeDownload(ctx,record);
    const manifest=validateManifest(response.manifest);
    if(manifest.id!==record.manifest.id || manifest.assetId!==item.id || manifest.kind!==item.kind)throw new Error('保存情報が一致しません。再ダウンロードしてください。');
    const key=await importDownloadKey(response.key);response.key='';
    if(disposed || !current(ctx))throw new Error('閲覧セッションは終了しました。');
    const readerId=crypto.randomUUID(),packageId=packageKey(ctx,item.id);
    const release=async()=>{for(const row of await store.releaseReader(packageId,readerId))await cleanupRetiredDownload(ctx,row).catch(()=>{});};
    // Pin before exposing a URL and before releasing the previous authorization,
    // so a replacement commit in another tab cannot remove an active reader.
    await store.pinReader(packageId,manifest.id,readerId,response.localExpiresAt);
    if(disposed||!current(ctx)){await release();throw new Error('閲覧セッションは終了しました。');}
    if(id)lock(id);id=readerId;
    grants.set(id,{key,manifest,expiresAt:response.localExpiresAt,context:ctx,onLock,release});scheduleExpiry(response.localExpiresAt);
    return manifest;
  }
  let manifest;
  try{manifest=await authorize();}
  catch(error){
    // A replacement can win between reading the record and acquiring its pin.
    // Open the newly ready package instead of exposing a dead old-quality URL.
    const latest=await store.getPackage(packageKey(ctx,item.id));
    if(!replacementRetry&&current(ctx)&&latest?.state==='ready'&&latest.manifest.id!==record.manifest.id)return openDownloaded(item,onLock,true);
    throw error;
  }
  const timer=setInterval(async()=>{
    const lease=await(await offlineVault()).lease(ctx.partition,manifest.id).catch(()=>null);
    if(disposed)return;
    if(!lease||!current(ctx)){if(id)lock(id);onLock();}
    else{
      const readerId=id,active=grants.get(readerId);lease.key='';
      if(active){
        try{await store.pinReader(packageKey(ctx,item.id),manifest.id,readerId,lease.localExpiresAt);}
        catch{if(grants.get(readerId)===active){lock(readerId);onLock();}return;}
        if(disposed||grants.get(readerId)!==active){await active.release().catch(()=>{});return;}
        active.expiresAt=lease.localExpiresAt;scheduleExpiry(lease.localExpiresAt);
      }
    }
  },15000);
  return {manifest,url:index=>`${DOWNLOAD_PATH}${id}/${index}`,
    pages:manifest.files.map(file=>({...file,url:`${DOWNLOAD_PATH}${id}/${file.index}`})),
    async pageBlob(number,signal){const file=manifest.files.find(file=>file.number===number);if(!file)throw new Error('ページが見つかりません。');const response=await fetch(`${DOWNLOAD_PATH}${id}/${file.index}`,{signal,cache:'no-store'});if(!response.ok)throw new Error('保存済みページを開けません。オンラインで開き直してください。');return response.blob();},
    async reconnect(){await authorize();return `${DOWNLOAD_PATH}${id}/0`;},
    dispose(){disposed=true;clearInterval(timer);clearTimeout(expiryTimer);if(id)lock(id);}
  };
}

// Import ciphertext only; native content keys are wrapped by Android Keystore.
// No plaintext media crosses the bridge.
export async function prepareNativeDownload(item,valid=()=>true,onProgress=()=>{}){
  const ctx=context();let store;try{store=await openDownloadDb();}catch{return null;}
  const record=await store.getPackage(packageKey(ctx,item.id));if(record?.state!=='ready')return null;
  return prepareNativeRecord(ctx,store,record,valid,onProgress);
}
async function prepareNativeRecord(ctx,store,record,valid,onProgress,existingLease){
  const manifest=validateManifest(record.manifest);
  const lease=existingLease??await authorizeDownload(ctx,record);
  if(!valid()||!current(ctx))throw new Error('再生準備を取り消しました。');
  if(lease.online)await NativePlayer.leaseSave({origin:ctx.endpoint,token:ctx.token,userId:ctx.userId,shelfUnlock:shelfUnlockValue(),id:manifest.id});lease.key='';
  const prepared=await NativePlayer.cacheBegin({origin:ctx.endpoint,token:ctx.token,userId:ctx.userId,manifest});
  if(!valid()||!current(ctx))throw new Error('再生準備を取り消しました。');
  if(prepared.ready)return manifest;
  if(record.nativeReady)throw new Error('端末の保存データが見つかりません。この作品をもう一度ダウンロードしてください。');
  let received=0;
  for(const file of manifest.files)for(let part=0;part<file.chunks;part++){
    if(!valid()||!current(ctx))throw new Error('再生準備を取り消しました。');
    const cached=await store.getChunk(manifest.id,file.index,part);
    if(!cached||await ciphertextHash(cached.bytes)!==cached.sha256)throw new Error('保存データを検証できません。再ダウンロードしてください。');
    const bytes=new Uint8Array(cached.bytes),pieces=[];
    for(let n=0;n<bytes.length;n+=8192)pieces.push(String.fromCharCode(...bytes.subarray(n,n+8192)));
    await NativePlayer.cacheChunk({partition:prepared.partition,id:manifest.id,part,bytes:btoa(pieces.join('')),sha256:cached.sha256});
    onProgress(++received,file.chunks);
  }
  if(!valid()||!current(ctx))throw new Error('再生準備を取り消しました。');
  await NativePlayer.cacheComplete({partition:prepared.partition,id:manifest.id});return manifest;
}

const aiSyncAt=new Map();let aiRefresh;
export function refreshDownloadedAnalysis(catalog){
  if(aiRefresh||isOfflineSession()||!getSession()?.token)return;
  const ctx=context();if(!current(ctx))return;
  const actor={origin:ctx.endpoint,userId:ctx.userId,token:ctx.token};
  aiRefresh=(async()=>{
    const rows=await(await openDownloadDb()).list(ctx.partition),items=new Map(catalog.items.map(item=>[item.id,item])),shelves=new Map(catalog.shelves.map(s=>[s.id,s]));
    const candidates=rows.filter(row=>row.state==='ready'&&items.has(row.assetId)&&!shelves.get(items.get(row.assetId).shelfId)?.private).sort((a,b)=>(aiSyncAt.get(ctx.partition+'|'+a.assetId)??0)-(aiSyncAt.get(ctx.partition+'|'+b.assetId)??0)).slice(0,8);
    for(const row of candidates){
      if(!current(ctx)||isOfflineSession())return;const key=ctx.partition+'|'+row.assetId;if(Date.now()-(aiSyncAt.get(key)??0)<300000)continue;
      try{await syncAiContent(actor,row.assetId,api,()=>current(ctx)&&!isOfflineSession());if(current(ctx))aiSyncAt.set(key,Date.now());}
      catch{aiSyncAt.set(key,Date.now()-240000);}
      while(aiSyncAt.size>10000)aiSyncAt.delete(aiSyncAt.keys().next().value);
    }
  })().catch(()=>{}).finally(()=>{aiRefresh=null;});
}
