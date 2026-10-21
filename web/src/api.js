import { NativePlayer,nativePlayerAvailable,invalidateNativePlayback } from './native-player-bridge.js';
import { Capacitor,registerPlugin } from '@capacitor/core';
import {offlineVault,offlineIdentity,forgetOfflineIdentity} from './offline-vault.js';
import {createLoginStore} from './session-store.js';
import { createResumableUpload } from './resumable-upload.js';
import { beginUpdateActivity } from './update-busy.js';

export const native = Capacitor.isNativePlatform();
let savedEndpoint;try{savedEndpoint=localStorage.getItem('mirea.server');}catch{}
let endpoint = native ? (savedEndpoint || import.meta.env.VITE_API_URL || '') : '';
let session,rememberChoice=true,authRevision=0;
export const sessionRevision=()=>authRevision;
export const isOfflineSession=()=>session?.offline===true;
export async function markSessionOffline(){if(session&&await offlineIdentity(endpoint,session.user.id))session={...session,offline:true};}
export async function rememberOfflineConfig(config){if(session&&!session.offline)try{await(await offlineVault()).saveIdentity(endpoint,session,rememberChoice,config);}catch{/* Offline storage is optional for online viewing. */}}
export async function reconnectSession(){
  if(!session)return false;
  const revision=authRevision,origin=endpoint,actor=session.user.id;
  if(session.offline&&!native){
    let restored;try{restored=await sessionRequest('/auth/remember');}catch(error){if([401,403].includes(error.status)&&authRevision===revision)await setSession(null);throw error;}
    if(authRevision!==revision||endpoint!==origin||restored.user.id!==actor)return false;
    session=restored;
  }
  const value=await api('/auth/me');if(authRevision!==revision||endpoint!==origin)return false;
  session={...session,user:value.user,offline:false};return true;
}
async function offlineLoggedOut(origin){try{return await(await offlineVault()).loggedOut(origin);}catch{return false;}}
async function sessionRequest(path,options={}){
  let response;try{response=await fetch(`/api/v1${path}`,{...options,signal:options.signal??AbortSignal.timeout(10000),credentials:'same-origin',cache:'no-store',headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},body:options.body?JSON.stringify(options.body):undefined});}catch{throw new Error('サーバーに接続できません。ログイン保持は解除していません。');}
  if(!response.ok)throw Object.assign(new Error('保持されたログインを確認できません。'),{status:response.status});return response.status===204?null:response.json();
}
const loginStore=createLoginStore({native,temporary:()=>{try{return sessionStorage;}catch{return null;}},secure:registerPlugin('MireaSession'),request:sessionRequest});
export async function initializeSession(){
  const revision=++authRevision,origin=endpoint;let loaded;
  try{loaded=await loginStore.load(origin);
    if(await offlineLoggedOut(origin)){if(loaded?.value?.token&&!native){await fetch('/api/v1/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+loaded.value.token},cache:'no-store'}).catch(()=>{});await loginStore.clear(origin,loaded.value.token);}session=null;return;}
  }catch(error){const cached=await offlineIdentity(origin);if(!cached)throw error;loaded={value:{...cached,token:'',offline:true},remember:true};}if(authRevision!==revision||origin!==endpoint)return;
  if(!loaded){session=null;await forgetOfflineIdentity(origin);return;}session=loaded.value;rememberChoice=loaded.remember;
  if(session.offline)return;
  let current;
  try{current=await api('/auth/me');}catch(error){
    // A newer login/server selection wins over an older in-flight validation.
    // api() already clears the matching current session on a 401.
    if(authRevision!==revision||origin!==endpoint)return;
    if(error.status===401){await loginStore.clear(origin,loaded.value.token);if(authRevision===revision)session=null;return;}const cached=await offlineIdentity(origin,session?.user.id);if(cached){session={...session,offline:true};return;}throw error;
  }
  if(authRevision!==revision||origin!==endpoint)return;
  if(current.user.id!==loaded.value.user.id){await setSession(null);return;}
  session={...session,user:{id:current.user.id,name:current.user.name,email:current.user.email}};
  if(loaded.legacy)await loginStore.save(origin,session,rememberChoice);
}

export const getSession = () => session;
export const getEndpoint = () => endpoint;
export function setEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('HTTPSのサーバーURLを入力してください（例：https://mirea.example.com）。');
  }
  invalidateNativePlayback();
  if(endpoint!==url.origin){session=null;authRevision++;try{sessionStorage.removeItem('mirea.session');}catch{}}
  endpoint = url.origin;
  try{localStorage.setItem('mirea.server', endpoint);}catch{}
}
export function setSession(value,{remember=rememberChoice,broadcast=true}={}) {
  invalidateNativePlayback();
  const oldToken=session?.token,oldUser=session?.user.id;authRevision++;
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
export const authHeaders = () => ({ Authorization: `Bearer ${session?.token ?? ''}` });

export async function api(path, options = {}) {
  if (native && !endpoint) throw new Error('接続先のサーバーURLを設定してください。');
  const token = session?.token;
  if(session?.offline&&!token&&!path.startsWith('/auth/login')&&!path.startsWith('/auth/register')&&path!=='/config')throw new Error('オフラインです。接続後に自動同期します。');
  let response;
  try {
    response = await fetch(absoluteUrl(`/api/v1${path}`), {
      ...options,
      headers: { ...authHeaders(), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    });
  } catch { throw new Error('サーバーに接続できません。接続先とネットワークを確認してください。'); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = Object.assign(new Error(data.error || 'リクエストに失敗しました。'), { status: response.status });
    if (response.status === 401 && session && session.token === token && !path.startsWith('/auth/login')) {
      setSession(null);
      window.dispatchEvent(new Event('mirea:unauthorized'));
    }
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export async function authenticatedBlob(path, signal) {
  const token = session?.token;
  if(session?.offline&&!token)throw new Error('オフラインです。');
  const response = await fetch(absoluteUrl(path), { headers: authHeaders(), signal, cache: 'no-store' });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && session?.token === token) {
      setSession(null);
      window.dispatchEvent(new Event('mirea:unauthorized'));
    }
    throw new Error(data.error || '画像を読み込めません。');
  }
  return response.blob();
}

export function upload(shelfId, files, title, onProgress, options) {
  const token = session?.token;
  const release = beginUpdateActivity();
  let task;
  try { task = createResumableUpload({ endpoint, token, userId: session?.user?.id, unauthorized: () => {
    if (session?.token !== token) return;
    setSession(null);
    window.dispatchEvent(new Event('mirea:unauthorized'));
  } }, shelfId, files, title, onProgress, options); }
  catch (error) { release(); throw error; }
  task.promise = task.promise.finally(release);
  return task;
}
