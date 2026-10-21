import { DOWNLOAD_PATH,encryptedRangeResponse } from './download-core.js';
import {validShellManifest} from './offline-shell.js';
import { openDownloadDb } from './download-db.js';

// Only allowlisted build assets enter Cache Storage. API/media responses never
// do; encrypted media remains in IndexedDB and keys are supplied per live tab.
const revoked=new Set();
const SHELL='mirea-shell-v1-';
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const response=await fetch('/offline-assets.json',{cache:'reload'});if(!response.ok)throw new Error('Offline shell unavailable');
  const manifest=await response.json();
  if(!validShellManifest(manifest))throw new Error('Invalid offline shell');
  const cache=await caches.open(SHELL+manifest.version);
  await cache.addAll(manifest.files);await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const names=(await caches.keys()).filter(name=>name.startsWith(SHELL));
  // Keep one previous hashed build for already-open tabs.
  for(const name of names.slice(0,-2))await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('message',event=>{
  if(event.data?.type==='mirea-download-lock' && event.source?.id){
    revoked.add(`${event.source.id}|${event.data.id}`);
  }
});
async function grantFromClient(clientId,id){
  if(!clientId)return null;
  const client=await self.clients.get(clientId);if(!client || new URL(client.url).origin!==self.location.origin)return null;
  return new Promise(resolve=>{
    const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();resolve(null);},10000);
    channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data);};
    client.postMessage({type:'mirea-download-grant',id},[channel.port2]);
  });
}
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);if(url.origin!==self.location.origin)return;
  if(!url.pathname.startsWith(DOWNLOAD_PATH)){
    if(event.request.method!=='GET'||url.search||url.pathname.startsWith('/api/'))return;
    if(event.request.mode==='navigate'||url.pathname.startsWith('/assets/')||url.pathname.startsWith('/pdf-assets/')||url.pathname==='/favicon.svg'||url.pathname.startsWith('/brand/')){
      event.respondWith((async()=>{
        try{return await fetch(event.request);}
        catch{
          const path=event.request.mode==='navigate'?'/index.html':url.pathname;
          for(const name of (await caches.keys()).filter(name=>name.startsWith(SHELL)).reverse()){
            const hit=await(await caches.open(name)).match(path);if(hit)return hit;
          }
          return new Response('オフライン用画面がありません。オンラインで一度ダウンロードしてください。',{status:503});
        }
      })());
    }
    return;
  }
  event.respondWith((async()=>{
    const match=/^\/__mirea_download__\/([0-9a-f-]{36})\/(\d{1,3})$/.exec(url.pathname);
    if(!match || !['GET','HEAD'].includes(event.request.method))return new Response(null,{status:404});
    const id=match[1],locked=()=>revoked.has(`${event.clientId}|${id}`);
    const grant=locked()?null:await grantFromClient(event.clientId,id);
    if(!grant)return new Response('オフライン視聴期限が切れています。オンラインで開き直してください。',{status:403,headers:{'Cache-Control':'no-store'}});
    try{
      const store=await openDownloadDb();
      const wall=Date.now(),start=performance.now(),expires=grant.expiresAt;
      return encryptedRangeResponse(event.request,grant,Number(match[2]),store.getChunk,{revoked:()=>locked()||Date.now()<wall-1000,now:()=>Math.max(Date.now(),wall+performance.now()-start)});
    }catch{return new Response('保存データを読み込めません。',{status:409,headers:{'Cache-Control':'no-store'}});}
  })());
});
