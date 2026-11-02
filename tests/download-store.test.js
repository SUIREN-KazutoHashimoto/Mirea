import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IDBFactory,IDBKeyRange } from 'fake-indexeddb';
import { createDownloadStore } from '../web/src/download-db.js';
import { commitDownload,createDownloadResetGuard,clearNativeTransfers } from '../web/src/download-commit.js';

globalThis.IDBKeyRange=IDBKeyRange;
async function setup(t){
  const factory=new IDBFactory(),name=randomUUID();
  async function connect(){return new Promise((resolve,reject)=>{
    const r=factory.open(name,1);r.onupgradeneeded=()=>{r.result.createObjectStore('packages',{keyPath:'key'}).createIndex('partition','partition');r.result.createObjectStore('chunks',{keyPath:'key'}).createIndex('downloadId','downloadId');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });}
  const c={db:await connect(),connect};t.after(()=>c.db.close());c.store=createDownloadStore(c.db);
  c.manifest=()=>({id:randomUUID(),assetId:randomUUID(),version:1,algorithm:'AES-256-GCM',chunkSize:1048576,title:'Encrypted',kind:'video',pageCount:1,files:[{index:0,number:1,size:1048580,chunks:2,mime:'video/mp4'}]});
  c.fill=async(key,m)=>{for(let part=0;part<2;part++)await c.store.putChunk(key,m.id,0,part,new Uint8Array(part?32:1048604).buffer,`hash${part}`);};
  return c;
}
test('IndexedDB keeps only ciphertext/allowlisted metadata, isolates accounts and persists ready state across reopen',async t=>{
  const c=await setup(t),manifest=c.manifest(),key=`server|user-A|${manifest.assetId}`;
  await c.store.savePackage(key,'server|user-A',{...manifest,contentKey:'must-not-persist',key:'raw-key-must-not-persist',files:manifest.files.map(f=>({...f,key:'file-key-must-not-persist'}))});
  await c.fill(key,manifest);await c.store.complete(key,manifest.id);
  const serialized=JSON.stringify(await c.store.list('server|user-A'));
  for(const text of ['must-not-persist','contentKey','CryptoKey'])assert.ok(!serialized.includes(text),text);
  assert.deepEqual(await c.store.list('server|user-B'),[]);assert.deepEqual(await c.store.list('other-server|user-A'),[]);
  c.db.close();c.db=await c.connect();c.store=createDownloadStore(c.db);
  assert.equal((await c.store.getPackage(key)).state,'ready');assert.equal((await c.store.getChunk(manifest.id,0,1)).bytes.byteLength,32);
});
test('incomplete packages cannot become ready; resume preserves chunks; deletion/replacement blocks late writes and orphan plaintext/key stores',async t=>{
  const c=await setup(t),manifest=c.manifest(),key='my-package';
  await c.store.savePackage(key,'account',manifest);await c.store.putChunk(key,manifest.id,0,0,new Uint8Array(1048604).buffer,'hash');
  await assert.rejects(()=>c.store.complete(key,manifest.id));assert.equal((await c.store.getPackage(key)).state,'downloading');
  await c.store.savePackage(key,'account',manifest);assert.equal(await c.store.count(manifest.id),1,'resume never clears accepted ciphertext');
  await c.store.putChunk(key,manifest.id,0,1,new Uint8Array(32).buffer,'hash');await c.store.complete(key,manifest.id);
  await c.store.savePackage(key,'account',manifest);assert.equal((await c.store.getPackage(key)).state,'ready','late resume cannot downgrade ready');
  const other=c.manifest();await c.store.savePackage('other','account-B',other);await c.fill('other',other);
  const replacement={...manifest,id:randomUUID()};await c.store.savePackage(key,'account',replacement);assert.equal(await c.store.count(manifest.id),2);
  await assert.rejects(()=>c.store.putChunk(key,manifest.id,0,1,new Uint8Array(32).buffer,'late'));
  await assert.rejects(()=>c.store.complete(key,manifest.id));assert.equal((await c.store.getPackage(key)).state,'ready');
  await c.fill(key,replacement);await c.store.remove(key);
  assert.equal(await c.store.getPackage(key),undefined);assert.equal(await c.store.count(replacement.id),0);assert.equal(await c.store.count(manifest.id),0);assert.equal(await c.store.count(other.id),2);
  await assert.rejects(()=>c.store.putChunk(key,replacement.id,0,1,new Uint8Array(32).buffer,'late'));
  assert.deepEqual([...c.db.objectStoreNames],['chunks','packages'],'there is no persistent key store');
});
test('account deletion purges only its partition and ciphertext, including incomplete downloads',async t=>{
  const c=await setup(t),a=c.manifest(),b=c.manifest(),other=c.manifest();
  for(const [key,partition,m] of [['a','server|user',a],['b','server|user',b],['other','other-server|user',other]]){
    await c.store.savePackage(key,partition,m);await c.fill(key,m);
  }
  await c.store.removePartition('server|user');
  assert.deepEqual(await c.store.list('server|user'),[]);
  assert.equal(await c.store.count(a.id),0);assert.equal(await c.store.count(b.id),0);
  assert.equal((await c.store.list('other-server|user')).length,1);assert.equal(await c.store.count(other.id),2);
  await assert.rejects(()=>c.store.putChunk('a',a.id,0,0,new ArrayBuffer(8),'late'));
});
test('native timed-media references replace duplicate browser ciphertext without changing other packages or storing keys',async t=>{
 const c=await setup(t),manifest=c.manifest(),key='native-reference',other=c.manifest();
 await c.store.savePackage(key,'account',manifest);await c.fill(key,manifest);await c.store.savePackage('other','other-account',other);await c.fill('other',other);
 const row=await c.store.completeNative(key,manifest.id);assert.equal(row.nativeReady,true);assert.equal(row.state,'ready');assert.equal(await c.store.count(manifest.id),0);assert.equal(await c.store.count(other.id),2);
 await assert.rejects(()=>c.store.completeNative(key,randomUUID()));
 const book={...c.manifest(),kind:'pdf',files:manifest.files.map(f=>({...f,mime:'application/pdf'}))};await c.store.savePackage('book','account',book);await assert.rejects(()=>c.store.completeNative('book',book.id));assert.equal((await c.store.getPackage('book')).state,'downloading');
});

test('replacement is resumable without hiding the ready download and swaps only after complete ciphertext',async t=>{
 const c=await setup(t),old=c.manifest(),key='replace',next={...old,id:randomUUID()};
 await c.store.savePackage(key,'account',old);await c.fill(key,old);await c.store.complete(key,old.id);
 const pending=await c.store.savePackage(key,'account',next);assert.equal(pending.manifest.id,next.id);assert.equal(pending.state,'downloading');
 await c.store.putChunk(key,next.id,0,0,new Uint8Array(1048604).buffer,'first');
 await assert.rejects(()=>c.store.complete(key,next.id));
 assert.equal((await c.store.getPackage(key)).manifest.id,old.id);assert.equal((await c.store.list('account'))[0].state,'ready');assert.equal(await c.store.count(old.id),2);
 // An interrupted attempt is left staged; a later browser session resumes it.
 c.db.close();c.db=await c.connect();c.store=createDownloadStore(c.db);
 assert.equal((await c.store.savePackage(key,'account',next)).manifest.id,next.id);assert.equal(await c.store.count(next.id),1);
 await c.store.putChunk(key,next.id,0,1,new Uint8Array(32).buffer,'last');await c.store.complete(key,next.id);
 const ready=await c.store.getPackage(key);assert.equal(ready.manifest.id,next.id);assert.equal(ready.state,'ready');assert.equal(ready.pending,undefined);assert.equal(await c.store.count(old.id),0);assert.equal(await c.store.count(next.id),2);
 await assert.rejects(()=>c.store.putChunk(key,old.id,0,0,new ArrayBuffer(8),'late'));
});

test('changing a staged quality removes only partial data and blocks cross-account replacement and late completion',async t=>{
 const c=await setup(t),old=c.manifest(),key='qualities',first={...old,id:randomUUID()},second={...old,id:randomUUID()};
 await c.store.savePackage(key,'account',old);await c.fill(key,old);await c.store.complete(key,old.id);
 await c.store.savePackage(key,'account',first);await c.fill(key,first);
 await assert.rejects(()=>c.store.savePackage(key,'other-account',second));assert.equal((await c.store.getPackage(key)).pending.manifest.id,first.id);
 await c.store.savePackage(key,'account',second);assert.equal(await c.store.count(first.id),0);assert.equal(await c.store.count(old.id),2);
 await assert.rejects(()=>c.store.putChunk(key,first.id,0,0,new ArrayBuffer(8),'late'));await assert.rejects(()=>c.store.complete(key,first.id));
 assert.equal((await c.store.getPackage(key)).manifest.id,old.id);
 await c.fill(key,second);await c.store.removePartition('account');assert.equal(await c.store.count(old.id),0);assert.equal(await c.store.count(second.id),0);
 await assert.rejects(()=>c.store.complete(key,second.id));await assert.rejects(()=>c.store.putChunk(key,second.id,0,0,new ArrayBuffer(8),'late'));
});

test('native replacement keeps the previous reference until commit and switching back drops only its pending candidate',async t=>{
 const c=await setup(t),old=c.manifest(),key='native-replace',next={...old,id:randomUUID()};
 await c.store.savePackage(key,'account',old);await c.store.completeNative(key,old.id);await c.store.savePackage(key,'account',next);await c.fill(key,next);
 assert.equal((await c.store.getPackage(key)).manifest.id,old.id);assert.equal((await c.store.getPackage(key)).nativeReady,true);
 await c.store.savePackage(key,'account',old);assert.equal(await c.store.count(next.id),0);assert.equal((await c.store.getPackage(key)).pending,undefined);
 await c.store.savePackage(key,'account',next);await c.store.completeNative(key,next.id);
 assert.equal((await c.store.getPackage(key)).manifest.id,next.id);assert.equal((await c.store.getPackage(key)).nativeReady,true);
});

test('lease/network failure and cancellation before publish keep previous ready ciphertext and resumable replacement',async t=>{
 const c=await setup(t),old=c.manifest(),next={...old,id:randomUUID()},key='lease-failure';
 await c.store.savePackage(key,'account',old);await c.fill(key,old);await c.store.complete(key,old.id);
 await c.store.savePackage(key,'account',next);await c.fill(key,next);
 let commits=0,cleanups=0;const commit=()=>{commits++;return c.store.complete(key,next.id);},cleanup=async()=>{cleanups++;};
 await assert.rejects(()=>commitDownload({authorize:async()=>{throw Error('lease persistence failed');},commit,cleanup}),/lease persistence/);
 const controller=new AbortController();await assert.rejects(()=>commitDownload({signal:controller.signal,authorize:async()=>{controller.abort();return {key:'wrapped-later'};},commit,cleanup}),{name:'AbortError'});
 let current=true;await assert.rejects(()=>commitDownload({valid:()=>current,authorize:async()=>{current=false;return {key:'another-account'};},commit,cleanup}),/ログイン先/);
 assert.equal(commits,0);assert.equal(cleanups,0);assert.equal((await c.store.getPackage(key)).manifest.id,old.id);assert.equal(await c.store.count(old.id),2);assert.equal(await c.store.count(next.id),2);
 const grant={key:'transient-only'};const ready=await commitDownload({authorize:async()=>grant,commit,cleanup:async()=>{assert.equal((await c.store.getPackage(key)).manifest.id,next.id);assert.equal(await c.store.count(next.id),2);cleanups++;}});
 assert.equal(ready.manifest.id,next.id);assert.equal(grant.key,'');assert.equal(commits,1);assert.equal(cleanups,1);assert.equal(await c.store.count(old.id),0);
});

test('failed commit never removes previous native cache; cleanup failure cannot roll back a published package',async t=>{
 const c=await setup(t),old=c.manifest(),next={...old,id:randomUUID()},key='native-lease-order';
 await c.store.savePackage(key,'account',old);await c.store.completeNative(key,old.id);await c.store.savePackage(key,'account',next);
 let cleaned=false;
 await assert.rejects(()=>commitDownload({authorize:async()=>({key:'lease'}),commit:()=>c.store.complete(key,next.id),cleanup:async()=>{cleaned=true;}}));
 assert.equal(cleaned,false);assert.equal((await c.store.getPackage(key)).manifest.id,old.id);
 const ready=await commitDownload({authorize:async()=>({key:'lease'}),commit:()=>c.store.completeNative(key,next.id),cleanup:async()=>{cleaned=true;throw Error('cleanup retry needed');}});
 assert.equal(cleaned,true);assert.equal(ready.nativeReady,true);assert.equal((await c.store.getPackage(key)).manifest.id,next.id);
});

test('readers across tabs keep the old ciphertext through replacement until the last reader releases it',async t=>{
 const c=await setup(t),old=c.manifest(),next={...old,id:randomUUID()},key='reading',db2=await c.connect(),tab2=createDownloadStore(db2);t.after(()=>db2.close());
 await c.store.savePackage(key,'account',old);await c.fill(key,old);await c.store.complete(key,old.id);
 await c.store.pinReader(key,old.id,'tab-one',Date.now()+60000);await tab2.pinReader(key,old.id,'tab-two',Date.now()+60000);
 await c.store.savePackage(key,'account',next);await c.fill(key,next);const ready=await c.store.complete(key,next.id);
 assert.equal(ready.manifest.id,next.id);assert.deepEqual(ready.retired,[{id:old.id,assetId:old.assetId}]);assert.equal((await tab2.getChunk(old.id,0,1)).bytes.byteLength,32,'an ongoing range reader can request its next old-quality chunk');
 assert.deepEqual(await c.store.releaseReader(key,'tab-one'),[]);assert.equal(await c.store.count(old.id),2);
 assert.deepEqual(await tab2.releaseReader(key,'tab-two'),[{id:old.id,assetId:old.assetId}]);assert.equal(await c.store.count(old.id),0);assert.equal(await c.store.count(next.id),2);
 await assert.rejects(()=>c.store.pinReader(key,old.id,'late-reader',Date.now()+60000));assert.equal((await c.store.getPackage(key)).manifest.id,next.id);
});

test('crashed readers are bounded by authorization expiry and account deletion overrides all reader pins',async t=>{
 const c=await setup(t);let now=1800000000000;c.store=createDownloadStore(c.db,{now:()=>now});
 const old=c.manifest(),next={...old,id:randomUUID()},key='crashed';
 await c.store.savePackage(key,'account',old);await c.fill(key,old);await c.store.complete(key,old.id);
 await c.store.pinReader(key,old.id,'crashed-tab',now+100*86400000);
 assert.equal((await c.store.getPackage(key)).readers['crashed-tab'].expiresAt,now+7*86400000,'a supplied deadline cannot retain data forever');
 await c.store.savePackage(key,'account',next);await c.fill(key,next);await c.store.complete(key,next.id);
 now+=7*86400000;assert.deepEqual(await c.store.collectExpired('account'),[{id:old.id,assetId:old.assetId}]);assert.equal(await c.store.count(old.id),0);assert.equal(await c.store.count(next.id),2);
 await assert.rejects(()=>c.store.pinReader(key,next.id,'expired',now));
 await c.store.pinReader(key,next.id,'active-tab',now+60000);const latest={...old,id:randomUUID()};await c.store.savePackage(key,'account',latest);await c.fill(key,latest);await c.store.complete(key,latest.id);
 await c.store.removePartition('account');assert.equal(await c.store.count(next.id),0);assert.equal(await c.store.count(latest.id),0);assert.deepEqual(await c.store.releaseReader(key,'active-tab'),[]);
});

test('same-ID native promotion and selecting an old quality cannot delete ciphertext still used by a reader',async t=>{
 const c=await setup(t),old=c.manifest(),next={...old,id:randomUUID()},key='promoting';
 await c.store.savePackage(key,'account',old);await c.fill(key,old);await c.store.complete(key,old.id);await c.store.pinReader(key,old.id,'reader',Date.now()+60000);
 await c.store.completeNative(key,old.id);assert.equal(await c.store.count(old.id),2);
 await c.store.savePackage(key,'account',next);await c.fill(key,next);await c.store.complete(key,next.id);
 await c.store.savePackage(key,'account',old);await c.store.complete(key,old.id);
 assert.equal((await c.store.getPackage(key)).retired,undefined);await c.store.releaseReader(key,'reader');assert.equal(await c.store.count(old.id),2,'the old quality is now the active package again');
 await c.store.pinReader(key,old.id,'native-migration',Date.now()+60000);await c.store.completeNative(key,old.id);await c.store.releaseReader(key,'native-migration');assert.equal(await c.store.count(old.id),0);
});

test('abandoning a candidate that reuses a retired quality never erases that quality while a reader is active',async t=>{
 const c=await setup(t),a=c.manifest(),b={...a,id:randomUUID()},d={...a,id:randomUUID()},key='retired-candidate';
 await c.store.savePackage(key,'account',a);await c.fill(key,a);await c.store.complete(key,a.id);await c.store.pinReader(key,a.id,'old-reader',Date.now()+60000);
 await c.store.savePackage(key,'account',b);await c.fill(key,b);await c.store.complete(key,b.id);
 await c.store.savePackage(key,'account',a);await c.store.savePackage(key,'account',d);
 assert.equal((await c.store.getPackage(key)).manifest.id,b.id);assert.equal((await c.store.getChunk(a.id,0,1)).bytes.byteLength,32);
 await c.fill(key,d);await c.store.complete(key,d.id);assert.equal(await c.store.count(a.id),2);assert.equal(await c.store.count(b.id),0);
 await c.store.releaseReader(key,'old-reader');assert.equal(await c.store.count(a.id),0);assert.equal(await c.store.count(d.id),2);
});

test('account clear invalidates a pending native import even after clearing ends and cannot republish removed data',async t=>{
 const c=await setup(t),guard=createDownloadResetGuard(),partition='server|account',other='server|other',m=c.manifest(),key='clearing';await c.store.savePackage(key,partition,m);await c.fill(key,m);
 const revision=guard.revision(partition);let finishAuthorization;const gate=new Promise(resolve=>finishAuthorization=resolve);
 const importing=commitDownload({valid:()=>guard.valid(partition,revision),authorize:async()=>{await gate;return {key:'fixture-only'};},commit:()=>c.store.completeNative(key,m.id)});
 const finishClear=guard.begin(partition);assert.equal(guard.valid(partition,guard.revision(partition)),false);assert.equal(guard.valid(other,guard.revision(other)),true);
 finishAuthorization();await assert.rejects(importing,/ログイン先/);await c.store.removePartition(partition);finishClear();
 assert.equal(guard.valid(partition,revision),false);assert.equal(guard.valid(partition,guard.revision(partition)),true);assert.deepEqual(await c.store.list(partition),[]);assert.equal(await c.store.count(m.id),0);await assert.rejects(()=>c.store.completeNative(key,m.id));
});

test('an older APK without native download clearing produces an explicit update error, never a false success',async()=>{
 await assert.rejects(()=>clearNativeTransfers({clearDownloads:async()=>{throw Object.assign(Error('not implemented'),{code:'UNIMPLEMENTED'});}},'a'.repeat(64)),{code:'NATIVE_DOWNLOAD_UPDATE_REQUIRED'});
 await assert.rejects(()=>clearNativeTransfers({},'a'.repeat(64)),{code:'NATIVE_DOWNLOAD_UPDATE_REQUIRED'});
 const failure=Error('worker is still stopping');await assert.rejects(()=>clearNativeTransfers({clearDownloads:async()=>{throw failure;}},'a'.repeat(64)),error=>error===failure);
 let cleared;await clearNativeTransfers({clearDownloads:async value=>{cleared=value.partition;}},'a'.repeat(64));assert.equal(cleared,'a'.repeat(64));
});
