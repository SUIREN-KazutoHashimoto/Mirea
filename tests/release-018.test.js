import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createImagePageCache} from '../web/src/image-page-cache.js';
import {planUploads,validateUploadPlan,createUploadBatch} from '../web/src/upload-batch.js';
import {collectionEntries} from '../web/src/library-collection.js';
import {createJobPool} from '../server/job-pool.js';
const tick=()=>new Promise(r=>setImmediate(r));
const wait=async predicate=>{for(let n=0;n<500&&!predicate();n++)await new Promise(r=>setTimeout(r,10));assert(predicate());};
test('1000 file boundary applies to documents and image pages without changing per-asset byte limits',()=>{
 const config={maxUploadBytes:100000,maxBookPages:1000,maxImageBytes:100};
 for(const ext of ['pdf','png']){const files=Array.from({length:1000},(_,n)=>new File(['x'],n+'.'+ext));assert.equal(validateUploadPlan(planUploads(files),config),'');assert.throws(()=>planUploads([...files,new File(['x'],'extra.'+ext)]),/1000/);}
 assert(validateUploadPlan(planUploads([new File(['xx'],'large.pdf')]),{...config,maxUploadBytes:1}));
});
test('accepted transfers drain their whole batch while completion monitors remain blocked',async()=>{
 const jobs=planUploads(Array.from({length:20},(_,n)=>new File(['x'],n+'.pdf')));let finish,started=0;const held=new Promise(r=>{finish=r;});
 const batch=createUploadBatch(jobs,{concurrency:3,start:()=>({transferred:Promise.resolve({id:String(++started)}),promise:held,abort(){}})});
 const sent=await batch.transferred;assert.equal(started,20);assert(sent.rows.every(r=>r.state==='processing'));let complete=false;batch.promise.then(()=>{complete=true;});await tick();assert.equal(complete,false);finish({accepted:true});await batch.promise;
});
test('pending rows are shown only in their real series; large nested catalogs aggregate once',()=>{
 const series=Array.from({length:1000},(_,n)=>({id:'s'+n,title:'Series '+n,parentId:n%10?'s'+(n-n%10):null}));
 const items=Array.from({length:10000},(_,n)=>({id:'i'+n,title:'Item '+n,series:{id:'s'+(n%1000),position:n},pending:n===0}));
 const rows=collectionEntries(items,series);assert.equal(rows.length,100);assert(rows.every(r=>r.type==='series'));assert.equal(rows.find(r=>r.id==='s0').assetCount,100);assert(!rows.find(r=>r.id==='s0').cover.pending);
 assert(collectionEntries(items,series,{parentId:'s0'}).some(r=>r.type==='asset'&&r.item.id==='i0'));
});
test('transfer priority defers new processing jobs, then resumes without losing the queue',async()=>{
 const pool=createJobPool(()=>2),starts=[];pool.prioritizeTransfers(60);const jobs=Array.from({length:6},(_,n)=>pool.run(async()=>{starts.push(n);await tick();},n));await tick();assert.equal(starts.length,0);assert.equal(pool.queued,6);await Promise.all(jobs);await tick();assert.deepEqual(starts,[0,1,2,3,4,5]);assert.equal(pool.running,0);
});
test('image prefetch stores encrypted session pages, bounds memory, loads all pages and deletes on close',async()=>{
 const previous={indexedDB:globalThis.indexedDB,IDBKeyRange:globalThis.IDBKeyRange};Object.assign(globalThis,{indexedDB,IDBKeyRange});let active=0,peak=0,loads=0;
 const cache=createImagePageCache({count:12,memoryBytes:20,cryptoApi:webcrypto,load:async n=>{loads++;peak=Math.max(peak,++active);await tick();active--;return new Blob(['private-page-'+n],{type:'image/png'});}});
 try{cache.prefetch(6);assert.equal(await(await cache.get(6)).text(),'private-page-6');await wait(()=>cache.stats().ready===12);assert(peak<=4);assert(cache.stats().memoryBytes<=20);assert.equal(loads,12);
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('mirea-image-prefetch-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const rows=await new Promise(resolve=>{const r=db.transaction('pages').objectStore('pages').getAll();r.onsuccess=()=>resolve(r.result);});assert.equal(rows.length,12);assert(!Buffer.concat(rows.map(r=>Buffer.from(r.bytes))).includes(Buffer.from('private-page')));
 assert.equal(await(await cache.get(1)).text(),'private-page-1');assert.equal(loads,12,'evicted RAM pages decrypt from session storage, not network');await cache.dispose();const left=await new Promise(resolve=>{const r=db.transaction('pages').objectStore('pages').count();r.onsuccess=()=>resolve(r.result);});assert.equal(left,0);db.close();await assert.rejects(()=>cache.get(1),{name:'AbortError'});
 }finally{await cache.dispose();Object.assign(globalThis,previous);}
});
test('closing image prefetch aborts work and never resolves a late page',async()=>{
 const cache=createImagePageCache({count:5,storage:async()=>null,load:(_,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Closed','AbortError')),{once:true}))});const page=cache.get(1);cache.prefetch();await tick();const assertion=assert.rejects(page,{name:'AbortError'});await cache.dispose();await assertion;assert.equal(cache.stats().memoryBytes,0);
});
test('text-field layout excludes checkbox, radio and range controls and native file enumeration is off the UI thread',async()=>{
 const css=await readFile(new URL('../web/src/style.css',import.meta.url),'utf8'),forms=await readFile(new URL('../web/src/forms.css',import.meta.url),'utf8');assert(css.includes('input:where(:not([type=file]):not([type=checkbox]):not([type=radio]):not([type=range]))'));assert(forms.includes('flex:0 0 18px'));
 const plugin=await readFile(new URL('../android/app/src/main/java/com/suiren/mirea/transfer/MireaTransferPlugin.java',import.meta.url),'utf8');assert(plugin.includes('folderScan'));assert(plugin.includes('files.length()>=1000'));assert(plugin.includes('uris.size()>1000'));assert(plugin.includes('io.submit(()->{try{'));
});
