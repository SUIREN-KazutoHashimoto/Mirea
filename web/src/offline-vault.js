import {openDownloadDb} from './download-db.js';
import {validateManifest} from './download-core.js';

export const OFFLINE_MS=7*86400000;
const encoder=new TextEncoder(),decoder=new TextDecoder(),anchors=new Map();
const originOf=origin=>origin||globalThis.location?.origin;
export const offlinePartition=(origin,userId)=>`${originOf(origin)}|${userId}`;
const slot=(partition,id)=>`sealed|${partition}|${id}`;
// A non-extractable device/origin key wraps leases and content keys. Neither
// bearer tokens nor plaintext media are persisted in the browser vault.
export async function createOfflineVault(store,{cryptoApi=crypto,wall=Date.now,mono=()=>performance.now(),anchorMap=anchors}={}){
  async function deviceKey(partition,create=false){
    const name=`device|${partition}`;let key=await store.vaultGet(name);
    if(!key&&create)key=await store.vaultInit(name,await cryptoApi.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']));
    if(!key)throw new Error('この端末のオフライン鍵がありません。オンラインで開き直してください。');return key;
  }
  async function seal(partition,id,value){
    const key=await deviceKey(partition,true),iv=cryptoApi.getRandomValues(new Uint8Array(12)),bytes=encoder.encode(JSON.stringify(value));
    try{await store.vaultPut(slot(partition,id),{iv,bytes:await cryptoApi.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(slot(partition,id))},key,bytes)});}finally{bytes.fill(0);}
  }
  async function unseal(partition,id){
    const record=await store.vaultGet(slot(partition,id));if(!record)return null;
    let plain;try{plain=new Uint8Array(await cryptoApi.subtle.decrypt({name:'AES-GCM',iv:record.iv,additionalData:encoder.encode(slot(partition,id))},await deviceKey(partition),record.bytes));return JSON.parse(decoder.decode(plain));}finally{plain?.fill(0);}
  }
  async function lease(partition,id){
    const saved=await unseal(partition,id);if(!saved)return null;
    const time=wall(),name=slot(partition,id),anchor=anchorMap.get(name);
    // Fail closed on clock rollback. Monotonic time also bounds a live page
    // while the wall clock is held back. This is not hardware DRM.
    if(time<saved.lastWall-1000||time<saved.wall-1000){await store.vaultDelete(name);throw new Error('端末の時計が変更されました。オンラインで期限を確認してください。');}
    const elapsed=Math.max(0,time-saved.wall,anchor?anchor.elapsed+mono()-anchor.mono:0);
    if(saved.grant.expiresAt<=saved.grant.serverTime+elapsed){await store.vaultDelete(name);return null;}
    saved.lastWall=Math.max(time,saved.lastWall);await seal(partition,id,saved);anchorMap.set(name,{elapsed,mono:mono()});
    return {...saved.grant,localExpiresAt:time+saved.grant.expiresAt-saved.grant.serverTime-elapsed};
  }
  return {
    async loggedOut(origin){return await store.vaultGet(`loggedout|${originOf(origin)}`)===true;},
    async setLoggedOut(origin,value){await store.vaultPut(`loggedout|${originOf(origin)}`,value);},
    async saveLease(partition,grant,userId){
      validateManifest(grant.manifest);
      if(grant.userId!==userId||!Number.isSafeInteger(grant.serverTime)||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=grant.serverTime||grant.expiresAt-grant.serverTime>OFFLINE_MS||!/^([A-Za-z0-9+/]{43}=)$/.test(grant.key))throw new Error('オフライン閲覧許可が不正です。');
      const time=wall(),safe={manifest:grant.manifest,userId,key:grant.key,serverTime:grant.serverTime,expiresAt:grant.expiresAt};
      await seal(partition,grant.manifest.id,{grant:safe,wall:time,lastWall:time});anchorMap.set(slot(partition,grant.manifest.id),{elapsed:0,mono:mono()});
    },lease,
    async revoke(partition,id){anchorMap.delete(slot(partition,id));await store.vaultDelete(slot(partition,id));},
    async saveIdentity(origin,session,remember,config){
      const partition=offlinePartition(origin,session.user.id);
      await seal(partition,'identity',{user:session.user,expiresAt:session.expiresAt,remember,config});
      await store.vaultPut(`identity|${originOf(origin)}`,session.user.id);
    },
    async identity(origin,userId){
      if(await store.vaultGet(`loggedout|${originOf(origin)}`))return null;
      const id=userId??await store.vaultGet(`identity|${originOf(origin)}`);if(!id)return null;
      const partition=offlinePartition(origin,id),identity=await unseal(partition,'identity');if(!identity||(!identity.remember&&!userId))return null;
      for(const row of await store.list(partition))if(row.state==='ready'&&await lease(partition,row.manifest.id).catch(()=>null))return identity;
      return null;
    },
    async forget(origin,userId){
      const id=userId??await store.vaultGet(`identity|${originOf(origin)}`);await store.vaultDelete(`identity|${originOf(origin)}`);
      if(id){const partition=offlinePartition(origin,id);await store.vaultDelete(`device|${partition}`);for(const key of anchorMap.keys())if(key.startsWith(`sealed|${partition}|`))anchorMap.delete(key);}
    },
    seal,unseal
  };
}
export const offlineVault=async()=>createOfflineVault(await openDownloadDb());
export async function offlineIdentity(origin,userId){try{return await(await offlineVault()).identity(origin,userId);}catch{return null;}}
export async function forgetOfflineIdentity(origin,userId){try{await(await offlineVault()).forget(origin,userId);}catch{/* Storage failure never restores a credential. */}}
