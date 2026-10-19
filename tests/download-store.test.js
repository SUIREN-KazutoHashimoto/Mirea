import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IDBFactory,IDBKeyRange } from 'fake-indexeddb';
import { createDownloadStore } from '../web/src/download-db.js';

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
  const replacement={...manifest,id:randomUUID()};await c.store.savePackage(key,'account',replacement);assert.equal(await c.store.count(manifest.id),0);
  await assert.rejects(()=>c.store.putChunk(key,manifest.id,0,1,new Uint8Array(32).buffer,'late'));
  await assert.rejects(()=>c.store.complete(key,manifest.id));assert.equal((await c.store.getPackage(key)).state,'downloading');
  await c.fill(key,replacement);await c.store.remove(key);
  assert.equal(await c.store.getPackage(key),undefined);assert.equal(await c.store.count(replacement.id),0);assert.equal(await c.store.count(other.id),2);
  await assert.rejects(()=>c.store.putChunk(key,replacement.id,0,1,new Uint8Array(32).buffer,'late'));
  assert.deepEqual([...c.db.objectStoreNames],['chunks','packages'],'there is no persistent key store');
});
