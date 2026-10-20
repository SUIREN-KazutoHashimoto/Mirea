import { invalidateNativePlayback } from './native-player-bridge.js';
import { Capacitor,registerPlugin } from '@capacitor/core';
import {createLoginStore} from './session-store.js';
import { createResumableUpload } from './resumable-upload.js';
import { beginUpdateActivity } from './update-busy.js';

export const native = Capacitor.isNativePlatform();
let savedEndpoint;try{savedEndpoint=localStorage.getItem('mirea.server');}catch{}
let endpoint = native ? (savedEndpoint || import.meta.env.VITE_API_URL || '') : '';
let session,rememberChoice=true,authRevision=0;
async function sessionRequest(path,options={}){
  let response;try{response=await fetch(`/api/v1${path}`,{...options,credentials:'same-origin',cache:'no-store',headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},body:options.body?JSON.stringify(options.body):undefined});}catch{throw new Error('サーバーに接続できません。ログイン保持は解除していません。');}
  if(!response.ok)throw Object.assign(new Error('保持されたログインを確認できません。'),{status:response.status});return response.status===204?null:response.json();
}
const loginStore=createLoginStore({native,temporary:()=>{try{return sessionStorage;}catch{return null;}},secure:registerPlugin('MireaSession'),request:sessionRequest});
export async function initializeSession(){
  const revision=++authRevision,origin=endpoint,loaded=await loginStore.load(origin);if(authRevision!==revision||origin!==endpoint)return;
  if(!loaded){session=null;return;}session=loaded.value;rememberChoice=loaded.remember;
  let current;
  try{current=await api('/auth/me');}catch(error){
    // A newer login/server selection wins over an older in-flight validation.
    // api() already clears the matching current session on a 401.
    if(authRevision!==revision||origin!==endpoint)return;
    if(error.status===401){await loginStore.clear(origin,loaded.value.token);if(authRevision===revision)session=null;return;}throw error;
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
export function setSession(value,{remember=rememberChoice}={}) {
  invalidateNativePlayback();
  const oldToken=session?.token;authRevision++;
  session = value;
  rememberChoice=remember;
  return value?loginStore.save(endpoint,value,remember):loginStore.clear(endpoint,oldToken);
}
export const absoluteUrl = path => `${endpoint}${path}`;
export const authHeaders = () => ({ Authorization: `Bearer ${session?.token ?? ''}` });

export async function api(path, options = {}) {
  if (native && !endpoint) throw new Error('接続先のサーバーURLを設定してください。');
  const token = session?.token;
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
