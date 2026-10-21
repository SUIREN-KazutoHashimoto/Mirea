import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createOfflineVault,OFFLINE_MS} from '../web/src/offline-vault.js';
import {importDownloadKey,encryptedRangeResponse} from '../web/src/download-core.js';

const fixture=()=>({id:randomUUID(),assetId:randomUUID(),version:1,algorithm:'AES-256-GCM',chunkSize:1048576,title:'Offline',kind:'pdf',pageCount:1,files:[{index:0,number:1,size:12,chunks:1,mime:'application/pdf'}]});
async function setup(){
  const rows=new Map(),packages=[];let time=1800000000000,elapsed=0;
  const store={vaultGet:async k=>rows.get(k),vaultPut:async(k,v)=>rows.set(k,structuredClone(v)),vaultInit:async(k,v)=>{if(!rows.has(k))rows.set(k,v);return rows.get(k);},vaultDelete:async k=>rows.delete(k),list:async p=>packages.filter(v=>v.partition===p)};
  const options={wall:()=>time,mono:()=>elapsed,anchorMap:new Map()},vault=await createOfflineVault(store,options),userId=randomUUID(),partition='https://mirea.test|'+userId;
  const manifest=fixture(),grant={manifest,userId,key:randomBytes(32).toString('base64'),serverTime:time,expiresAt:time+OFFLINE_MS};
  packages.push({partition,state:'ready',manifest});
  return {vault,store,rows,options,grant,manifest,userId,partition,advance:ms=>{time+=ms;elapsed+=ms;},wall:ms=>{time+=ms;},mono:ms=>{elapsed+=ms;}};
}
test('offline lease encrypts content keys and profile, isolates origins/accounts, resumes after restart and expires at exactly seven days',async()=>{
  const c=await setup();await c.vault.saveLease(c.partition,c.grant,c.userId);
  await c.vault.saveIdentity('https://mirea.test',{user:{id:c.userId,name:'Private Name',email:'private@test'},token:'bearer-not-persisted',expiresAt:c.grant.expiresAt+1000},true,{analytics:{enabled:true}});
  const serialized=JSON.stringify([...c.rows]);for(const secret of [c.grant.key,'bearer-not-persisted','Private Name','private@test'])assert.ok(!serialized.includes(secret));
  const key=c.rows.get('device|'+c.partition);assert.equal(key.extractable,false);await assert.rejects(()=>crypto.subtle.exportKey('raw',key));
  assert.equal((await c.vault.lease(c.partition,c.manifest.id)).key,c.grant.key);
  assert.equal(await c.vault.lease('https://other.test|'+c.userId,c.manifest.id),null);
  assert.equal(await c.vault.identity('https://other.test'),null);
  c.advance(OFFLINE_MS-1);
  const restarted=await createOfflineVault(c.store,{...c.options,anchorMap:new Map()});
  assert.equal((await restarted.identity('https://mirea.test')).user.id,c.userId);
  assert.ok(await restarted.lease(c.partition,c.manifest.id));
  c.advance(1);assert.equal(await restarted.lease(c.partition,c.manifest.id),null);assert.equal(await restarted.identity('https://mirea.test'),null);
});
test('clock rollback, tampering, swaps, invalid grant identity and exaggerated deadlines fail closed; monotonic expiry cannot be frozen',async()=>{
  const c=await setup();await c.vault.saveLease(c.partition,c.grant,c.userId);c.advance(10000);await c.vault.lease(c.partition,c.manifest.id);
  c.wall(-5000);await assert.rejects(()=>c.vault.lease(c.partition,c.manifest.id),/時計/);assert.equal(await c.vault.lease(c.partition,c.manifest.id),null);
  c.wall(5000);await c.vault.saveLease(c.partition,c.grant,c.userId);c.mono(OFFLINE_MS+1);assert.equal(await c.vault.lease(c.partition,c.manifest.id),null);
  for(const change of [{userId:randomUUID()},{expiresAt:c.grant.serverTime+OFFLINE_MS+1},{key:'raw-key'}])await assert.rejects(()=>c.vault.saveLease(c.partition,{...c.grant,...change},c.userId));
  await c.vault.saveLease(c.partition,c.grant,c.userId);const slot='sealed|'+c.partition+'|'+c.manifest.id,record=c.rows.get(slot);new Uint8Array(record.bytes)[0]^=1;await assert.rejects(()=>c.vault.lease(c.partition,c.manifest.id));
});
test('only new authenticated leases renew expiry; revoke/logout remove authorization without deleting ciphertext or another account',async()=>{
  const c=await setup();await c.vault.saveLease(c.partition,c.grant,c.userId);
  await c.vault.saveIdentity('https://mirea.test',{user:{id:c.userId},expiresAt:c.grant.expiresAt},true,{});
  c.advance(OFFLINE_MS-100);let lease=await c.vault.lease(c.partition,c.manifest.id);assert.equal(lease.localExpiresAt-c.options.wall(),100);
  const renewed={...c.grant,serverTime:c.options.wall(),expiresAt:c.options.wall()+OFFLINE_MS};await c.vault.saveLease(c.partition,renewed,c.userId);
  assert.equal((await c.vault.lease(c.partition,c.manifest.id)).localExpiresAt-c.options.wall(),OFFLINE_MS);
  await c.vault.revoke(c.partition,c.manifest.id);assert.equal(await c.vault.lease(c.partition,c.manifest.id),null);
  await c.vault.saveLease(c.partition,renewed,c.userId);await c.vault.setLoggedOut('https://mirea.test',true);assert.equal(await c.vault.identity('https://mirea.test'),null);
  await c.vault.forget('https://mirea.test',c.userId);await assert.rejects(()=>c.vault.lease(c.partition,c.manifest.id));
  assert.equal((await c.store.list(c.partition)).length,1,'logout preserves encrypted media');
});

test('offline shell is an exact static build allowlist, never API/media/arbitrary origin or traversal',async()=>{
  const {validShellManifest}=await import('../web/src/offline-shell.js');
  const base={version:'a'.repeat(64),files:['/index.html','/favicon.svg','/download-sw.js','/assets/index-xyz.js','/pdf-assets/cmaps/Adobe-Japan1.bcmap']};
  assert.equal(validShellManifest(base),true);
  for(const path of ['/api/v1/auth/remember','/api/v1/items/id/content','/uploads/video.mp4','//evil.test/index.html','/assets/../secret','/assets/code.js?token=secret','https://evil.test/asset.js'])assert.equal(validShellManifest({...base,files:[path]}),false,path);
});
