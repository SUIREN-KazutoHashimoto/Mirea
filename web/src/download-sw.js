import { DOWNLOAD_PATH,encryptedRangeResponse } from './download-core.js';
import { openDownloadDb } from './download-db.js';

// No Cache Storage and no durable keys. All non-download requests pass through.
const revoked=new Set();
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
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
  const url=new URL(event.request.url);if(url.origin!==self.location.origin || !url.pathname.startsWith(DOWNLOAD_PATH))return;
  event.respondWith((async()=>{
    const match=/^\/__mirea_download__\/([0-9a-f-]{36})\/(\d{1,3})$/.exec(url.pathname);
    if(!match || !['GET','HEAD'].includes(event.request.method))return new Response(null,{status:404});
    const id=match[1],locked=()=>revoked.has(`${event.clientId}|${id}`);
    const grant=locked()?null:await grantFromClient(event.clientId,id);
    if(!grant)return new Response('権限の確認が必要です。オンラインで開き直してください。',{status:403,headers:{'Cache-Control':'no-store'}});
    try{
      const store=await openDownloadDb();
      return encryptedRangeResponse(event.request,grant,Number(match[2]),store.getChunk,{revoked:locked});
    }catch{return new Response('保存データを読み込めません。',{status:409,headers:{'Cache-Control':'no-store'}});}
  })());
});
