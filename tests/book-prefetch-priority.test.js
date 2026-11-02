import test from 'node:test';
import assert from 'node:assert/strict';
import {createImagePageCache} from '../web/src/image-page-cache.js';
import {bookScale} from '../web/src/book-viewer.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('foreground page can start while all background-prefetch slots are stalled',async()=>{
 const started=[],release=new Map();
 const cache=createImagePageCache({count:100,storage:async()=>null,load:(n,signal)=>{started.push(n);return new Promise((resolve,reject)=>{release.set(n,()=>resolve(new Blob(['page'])));signal.addEventListener('abort',()=>reject(new DOMException('Closed','AbortError')),{once:true});});}});
 cache.prefetch(1);await tick();assert.deepEqual(started,[1,2,3]);
 const controller=new AbortController(),requested=cache.get(90,controller.signal);await tick();assert.deepEqual(started,[1,2,3,90]);
 const rejected=assert.rejects(requested,{name:'AbortError'});controller.abort();await rejected;await tick();
 const next=cache.get(91);next.catch(()=>{});await tick();assert(started.includes(91));await cache.dispose();
});

test('prefetch ready count excludes memory-evicted pages when encrypted storage is unavailable',async()=>{
 const cache=createImagePageCache({count:3,memoryBytes:4,storage:async()=>null,load:async()=>new Blob(['1234'])});
 await cache.get(1);await cache.get(2);await cache.get(3);assert.equal(cache.stats().ready,1);assert.equal(cache.stats().memoryBytes,4);assert.equal(cache.stats().limited,true);await cache.dispose();
});

test('fit width uses screen dimensions even for high-resolution scan pages',()=>{
 assert.equal(bookScale(5197,7252,390,700,'width'),382/5197);
 assert.equal(bookScale(100,100,2000,2000,'width',1),1);
});
