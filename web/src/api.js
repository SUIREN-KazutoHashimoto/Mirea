import {requestError,clearDiagnostics} from './error-diagnostics.js';
import { NativePlayer,nativePlayerAvailable,invalidateNativePlayback } from './native-player-bridge.js';
import { Capacitor,registerPlugin } from '@capacitor/core';
import {offlineVault,offlineIdentity,forgetOfflineIdentity} from './offline-vault.js';
import {connectionBudget} from './connection-budget.js';
import {createLoginStore} from './session-store.js';
import { createResumableUpload } from './resumable-upload.js';
import { beginUpdateActivity } from './update-busy.js';
import {nativeTransfersAvailable,nativeUpload,configureNativeTransfers,invalidateTransfers} from './native-transfers.js';
import {ciphertextHash} from './download-core.js';
import {stopTransfers,clearTransferRecords} from './transfer-manager.js';
import {clearShelfUnlocks,shelfUnlockValue,unlockRequiredShelf} from './private-shelves.js';

configureNativeTransfers(()=>session?.token?{origin:endpoint,token:session.token,userId:session.user.id,shelfUnlock:shelfUnlockValue()}:null);
function invalidateTransferContext(){stopTransfers();clearTransferRecords();if(session?.user.id)ciphertextHash(new TextEncoder().encode((endpoint||location.origin)+'|'+session.user.id)).then(invalidateTransfers).catch(()=>{});}
export const native = Capacitor.isNativePlatform();
let savedEndpoint;try{savedEndpoint=localStorage.getItem('mirea.server');}catch{}
let endpoint = native ? (savedEndpoint || import.meta.env.VITE_API_URL || '') : '';
let session,rememberChoice=true,authRevision=0;
export const sessionRevision=()=>authRevision;
export const isOfflineSession=()=>session?.offline===true;
export async function markSessionOffline(){if(session&&await offlineIdentity(endpoint,session.user.id))session={...session,offline:true};}
export async function rememberOfflineConfig(config){if(session&&!session.offline)try{await(await offlineVault()).saveIdentity(endpoint,session,rememberChoice,config);}catch{/* Offline storage is optional for online viewing. */}}
export async function reconnectSession({signal}={}){
  if(!session)return false;
  const revision=authRevision,origin=endpoint,actor=session.user.id;
  if(session.offline&&!native&&!session.token){
    let restored;try{restored=await sessionRequest('/auth/remember',{signal});}catch(error){if([401,403].includes(error.status)&&authRevision===revision)await setSession(null);throw error;}
    if(authRevision!==revision||endpoint!==origin||restored.user.id!==actor)return false;
    session=restored;
  }
  const value=await api('/auth/me',{signal});if(authRevision!==revision||endpoint!==origin)return false;
  session={...session,user:value.user,offline:false};return true;
}
async function offlineLoggedOut(origin){try{return await(await offlineVault()).loggedOut(origin);}catch{return false;}}
async function sessionRequest(path,options={}){
  const context=authRevision;let response;try{response=await fetch(`/api/v1${path}`,{...options,signal:options.signal??AbortSignal.timeout(10000),credentials:'same-origin',cache:'no-store',headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},body:options.body?JSON.stringify(options.body):undefined});}catch{throw new Error('サーバーに接続できません。ログイン保持は解除していません。');}
  options.signal?.throwIfAborted();
  if(!response.ok){const data=await response.json().catch(()=>({}));throw requestError({...data,error:'保持されたログインを確認できません。'},response.status,{record:response.status>=500&&context===authRevision});}const value=response.status===204?null:await response.json();options.signal?.throwIfAborted();return value;
}
const loginStore=createLoginStore({native,temporary:()=>{try{return sessionStorage;}catch{return null;}},secure:registerPlugin('MireaSession'),request:sessionRequest});
export async function initializeSession({signal}={}){
  const budget=signal?null:connectionBudget();signal??=budget.signal;
  try {
  const revision=++authRevision,origin=endpoint;let loaded;
  try{loaded=await loginStore.load(origin,{signal});
    if(await offlineLoggedOut(origin)){if(loaded?.value?.token&&!native){await fetch('/api/v1/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+loaded.value.token},cache:'no-store',signal}).catch(()=>{});await loginStore.clear(origin,loaded.value.token,{signal});}session=null;return;}
  }catch(error){if(authRevision!==revision||origin!==endpoint)return;if([401,403].includes(error.status)){await forgetOfflineIdentity(origin);session=null;return;}const cached=await offlineIdentity(origin);if(!cached)throw error;loaded={value:{...cached,token:'',offline:true},remember:true};}if(authRevision!==revision||origin!==endpoint)return;
  if(!loaded){session=null;await forgetOfflineIdentity(origin);return;}session=loaded.value;rememberChoice=loaded.remember;
  if(session.offline)return;
  let current;
  try{current=await api('/auth/me',{signal});}catch(error){
    // A newer login/server selection wins over an older in-flight validation.
    // api() already clears the matching current session on a 401.
    if(authRevision!==revision||origin!==endpoint)return;
    if([401,403].includes(error.status)){await loginStore.clear(origin,loaded.value.token,{signal});await forgetOfflineIdentity(origin,loaded.value.user.id);if(authRevision===revision)session=null;return;}let cached=await offlineIdentity(origin,session?.user.id);if(!cached&&nativeTransfersAvailable()){await import('./downloads.js').then(m=>m.syncNativeDownloads()).catch(()=>{});cached=await offlineIdentity(origin,session?.user.id);}if(cached){session={...session,offline:true};return;}throw error;
  }
  if(authRevision!==revision||origin!==endpoint)return;
  if(current.user.id!==loaded.value.user.id){await setSession(null);return;}
  session={...session,user:{id:current.user.id,name:current.user.name,email:current.user.email}};
  if(loaded.legacy)await loginStore.save(origin,session,rememberChoice);
  } finally {budget?.dispose();}
}

export const getSession = () => session;
export const getEndpoint = () => endpoint;
export function setEndpoint(value) {
  clearShelfUnlocks();
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('HTTPSのサーバーURLを入力してください（例：https://mirea.example.com）。');
  }
  invalidateNativePlayback();invalidateTransferContext();
  if(endpoint!==url.origin){clearDiagnostics();session=null;authRevision++;try{sessionStorage.removeItem('mirea.session');}catch{}}
  endpoint = url.origin;
  try{localStorage.setItem('mirea.server', endpoint);}catch{}
}
export function setSession(value,{remember=rememberChoice,broadcast=true}={}) {
  clearShelfUnlocks();
  invalidateNativePlayback();invalidateTransferContext();
  const oldToken=session?.token,oldUser=session?.user.id;if(!value||value.user?.id!==oldUser)clearDiagnostics();authRevision++;
  session = value;
  rememberChoice=remember;
  if(broadcast)try{localStorage.setItem('mirea.auth-change',JSON.stringify({origin:endpoint||location.origin,logout:!value,nonce:crypto.randomUUID()}));}catch{}
  if(value)return Promise.all([(async()=>{try{await(await offlineVault()).setLoggedOut(endpoint,false);}catch{}})(),loginStore.save(endpoint,value,remember)]).then(results=>results[1]);
  return Promise.all([(async()=>{try{const vault=await offlineVault();await vault.setLoggedOut(endpoint,true);await vault.forget(endpoint,oldUser);}catch{}})(),loginStore.clear(endpoint,oldToken),
    nativePlayerAvailable()&&oldUser?import('./download-core.js').then(async({ciphertextHash})=>NativePlayer.leaseClear({partition:await ciphertextHash(new TextEncoder().encode(`${endpoint||location.origin}|${oldUser}`))})):null]).then(results=>results[1]);
}
if(typeof window!=='undefined')window.addEventListener('storage',event=>{
  if(event.key!=='mirea.auth-change')return;let change;try{change=JSON.parse(event.newValue);}catch{return;}
  if(change?.origin===(endpoint||location.origin)&&change.logout){setSession(null,{broadcast:false});window.dispatchEvent(new Event('mirea:unauthorized'));}
});
export const absoluteUrl = path => `${endpoint}${path}`;
export const authHeaders = () => ({ Authorization: `Bearer ${session?.token ?? ''}`,...(shelfUnlockValue()?{'X-Mirea-Shelf-Unlock':shelfUnlockValue()}:{}) });

export async function api(path, options = {}) {
  if (native && !endpoint) throw new Error('接続先のサーバーURLを設定してください。');
  const token = session?.token,context=authRevision;
  if(session?.offline&&!token&&!path.startsWith('/auth/login')&&!path.startsWith('/auth/register')&&path!=='/config')throw new Error('オフラインです。接続後に自動同期します。');
  options.signal?.throwIfAborted();
  let response;
  try {
    response = await fetch(absoluteUrl(`/api/v1${path}`), {
      ...options,
      headers: { ...authHeaders(), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    });
  } catch { options.signal?.throwIfAborted();throw requestError({error:'サーバーに接続できません。接続先とネットワークを確認してください。'},0,{network:true,record:context===authRevision}); }
  options.signal?.throwIfAborted();
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    options.signal?.throwIfAborted();
    if(response.status===423&&data.shelfUnlockRequired&&!options.shelfRetried){await unlockRequiredShelf(data.shelfUnlockRequired);if(context!==authRevision)throw Error('アカウントが変更されました。');return api(path,{...options,shelfRetried:true});}
    const error = requestError(data,response.status,{record:context===authRevision});
    if (response.status === 401 && session && session.token === token && !path.startsWith('/auth/login')) {
      setSession(null);
      window.dispatchEvent(new Event('mirea:unauthorized'));
    }
    throw error;
  }
  const result=response.status===204?null:await response.json();options.signal?.throwIfAborted();return result;
}

export async function authenticatedBlob(path, signal) {
  const token = session?.token,context=authRevision;
  if(session?.offline&&!token)throw new Error('オフラインです。');
  const response = await fetch(absoluteUrl(path), { headers: authHeaders(), signal, cache: 'no-store' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    signal?.throwIfAborted();
    if (response.status === 401 && session?.token === token) {
      setSession(null);
      window.dispatchEvent(new Event('mirea:unauthorized'));
    }
    throw requestError(data,response.status,{record:context===authRevision});
  }
  return response.blob();
}

export function upload(shelfId, files, title, onProgress, options) {
  const token = session?.token;
  const release = beginUpdateActivity();
  let task;
  try { task = nativeTransfersAvailable()&&files.every(file=>file.nativeId)?nativeUpload({origin:endpoint,token,userId:session.user.id,shelfUnlock:shelfUnlockValue()},shelfId,files,title,onProgress,options):createResumableUpload({ endpoint, token, shelfUnlock:shelfUnlockValue(),userId: session?.user?.id, isCurrent:()=>session?.token===token, unauthorized: () => {
    if (session?.token !== token) return;
    setSession(null);
    window.dispatchEvent(new Event('mirea:unauthorized'));
  } }, shelfId, files, title, onProgress, options); }
  catch (error) { release(); throw error; }
  (task.transferred??task.promise).then(release,release);
  task.promise = task.promise.finally(release);
  return task;
}
