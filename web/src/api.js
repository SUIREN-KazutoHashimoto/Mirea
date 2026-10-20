import { Capacitor } from '@capacitor/core';
import { createResumableUpload } from './resumable-upload.js';

export const native = Capacitor.isNativePlatform();
let endpoint = native ? (localStorage.getItem('mirea.server') || import.meta.env.VITE_API_URL || '') : '';
let session;
try { session = JSON.parse(sessionStorage.getItem('mirea.session')); } catch { /* expired or corrupt session */ }

export const getSession = () => session;
export const getEndpoint = () => endpoint;
export function setEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('HTTPSのサーバーURLを入力してください（例：https://mirea.example.com）。');
  }
  endpoint = url.origin;
  localStorage.setItem('mirea.server', endpoint);
}
export function setSession(value) {
  session = value;
  if (value) sessionStorage.setItem('mirea.session', JSON.stringify(value));
  else sessionStorage.removeItem('mirea.session');
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
  return createResumableUpload({ endpoint, token, userId: session?.user?.id, unauthorized: () => {
    if (session?.token !== token) return;
    setSession(null);
    window.dispatchEvent(new Event('mirea:unauthorized'));
  } }, shelfId, files, title, onProgress, options);
}
