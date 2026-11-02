import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openDownloadDatabase} from '../web/src/download-db.js';
import {openAnalyticsDatabase} from '../web/src/analytics-outbox.js';
test('blocked prior-tab upgrade rejects quickly, never deletes ciphertext, and can retry after old tab closes',async()=>{
 const factory=new IDBFactory(),legacy=await new Promise((resolve,reject)=>{const r=factory.open('mirea-encrypted-downloads-v1',1);r.onupgradeneeded=()=>{r.result.createObjectStore('packages',{keyPath:'key'}).createIndex('partition','partition');r.result.createObjectStore('chunks',{keyPath:'key'}).createIndex('downloadId','downloadId');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 await new Promise((resolve,reject)=>{const tx=legacy.transaction('chunks','readwrite');tx.objectStore('chunks').put({key:'fixture',downloadId:'fixture',bytes:new Uint8Array([1,2,3])});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
 const start=performance.now();await assert.rejects(openDownloadDatabase({factory}),/ほかのMireaタブ/);assert(performance.now()-start<500);legacy.close();const store=await openDownloadDatabase({factory});
 const inspection=await new Promise((resolve,reject)=>{const r=factory.open('mirea-encrypted-downloads-v1',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const saved=await new Promise((resolve,reject)=>{const tx=inspection.transaction('chunks');const r=tx.objectStore('chunks').get('fixture');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});assert.deepEqual(saved.bytes,new Uint8Array([1,2,3]));assert(inspection.objectStoreNames.contains('vault'));await store.vaultPut('test','preserved');assert.equal(await store.vaultGet('test'),'preserved');inspection.close();
});
test('unresponsive storage is bounded and any late-opened connection closes without reading keys',async()=>{
 const request={};let closed=0,aborted=0;const factory={open:()=>request};await assert.rejects(openDownloadDatabase({factory,ms:20}),/保存データは削除していません/);request.result={close:()=>closed++};request.onsuccess();assert.equal(closed,1);request.transaction={abort:()=>aborted++};request.onupgradeneeded();assert.equal(aborted,1);
});
test('legacy analytics connection cannot block startup and pending historical events survive the later upgrade',async()=>{
 const factory=new IDBFactory(),old=await new Promise((resolve,reject)=>{const r=factory.open('mirea-analytics-v1',1);r.onupgradeneeded=()=>{const s=r.result.createObjectStore('events',{keyPath:'key'});s.createIndex('partition','partition');s.createIndex('queuedAt','queuedAt');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 await new Promise(resolve=>{const tx=old.transaction('events','readwrite');tx.objectStore('events').put({key:'retained',partition:'fixture',queuedAt:1});tx.oncomplete=resolve;});
 await assert.rejects(openAnalyticsDatabase({factory}),/古いMireaタブ/);old.close();const db=await openAnalyticsDatabase({factory});assert(db.transaction('events').objectStore('events').indexNames.contains('pending'));
 const row=await new Promise(resolve=>{const r=db.transaction('events').objectStore('events').get('retained');r.onsuccess=()=>resolve(r.result);});assert.equal(row.key,'retained');db.close();
});
