import test from 'node:test';
import assert from 'node:assert/strict';
import {createBookPreloader} from '../web/src/book-preload.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('next image book shares prepared manifest and opening page once without a second fetch',async()=>{
 let requests=0;const pages=[{number:1,size:4,url:'/page'}],preload=createBookPreloader({pages:async()=>({pages}),blob:async()=>{requests++;return new Blob(['page']);}});
 preload.preload({id:'book',kind:'image-book'});await tick();preload.preload({id:'book',kind:'image-book'});assert.equal(requests,1);const value=preload.take('book');assert.deepEqual(value.pages,pages);assert.equal(await value.firstPage.text(),'page');assert.equal(preload.take('book'),null);preload.dispose();
});
test('next book prefetch discards late data after viewer scope changes and respects memory budget',async()=>{
 let active=true,release,loads=0;const preload=createBookPreloader({current:()=>active,pages:()=>new Promise(resolve=>release=resolve),blob:async()=>{loads++;return new Blob(['page']);},maxBytes:3});
 preload.preload({id:'large',kind:'image-book'});release({pages:[{size:4,url:'/large'}]});await tick();assert.equal(loads,0);assert.equal(preload.take('large').firstPage,null);
 preload.preload({id:'late',kind:'image-book'});active=false;release({pages:[{size:1,url:'/small'}]});await tick();assert.equal(preload.take('late'),null);assert.equal(loads,0);preload.dispose();
});
