import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
 const original=Object.getOwnPropertyDescriptor(globalThis,'__transferContextFixture');
 const h={hash:async()=> 'f'.repeat(64),listener:Promise.resolve(),queued:[],cancelled:[],invalidated:[],complete:false};
 h.bridge={addListener:()=>h.listener,enqueue:async args=>{const id='job-'+h.queued.length;h.queued.push({...args,id});return {id};},cancel:async args=>{h.cancelled.push(args);},invalidate:async args=>{h.invalidated.push(args);},status:async context=>({jobs:h.queued.filter(row=>row.origin===context.origin&&row.userId===context.userId).map(row=>({id:row.id,state:h.complete?'complete':'running',result:{id:row.id}}))})};
 Object.defineProperty(globalThis,'__transferContextFixture',{configurable:true,value:h});
 const id=crypto.randomUUID(),hook=registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/native-transfers.js?test='+id)){
  if(specifier==='@capacitor/core')return {url:'data:text/javascript,'+encodeURIComponent('const h=globalThis.__transferContextFixture;export const Capacitor={getPlatform:()=>"android",isPluginAvailable:()=>true};export const registerPlugin=()=>h.bridge;//'+id),shortCircuit:true};
  if(specifier==='./download-core.js')return {url:'data:text/javascript,'+encodeURIComponent('const h=globalThis.__transferContextFixture;export const ciphertextHash=(...args)=>h.hash(...args);//'+id),shortCircuit:true};
 }return next(specifier,context);}});
 let api;try{api=await import('../web/src/native-transfers.js?test='+id);}finally{hook.deregister();}
 t.after(()=>{if(original)Object.defineProperty(globalThis,'__transferContextFixture',original);else delete globalThis.__transferContextFixture;});
 return {h,api};
}
const a={origin:'https://mirea.example.invalid',userId:'account-a',token:'a'.repeat(43)},b={...a,userId:'account-b',token:'b'.repeat(43)};

test('delayed old-account invalidation does not reject a new-account transfer',async t=>{
 const {h,api}=await fixture(t),hash=deferred();h.hash=()=>hash.promise;api.configureNativeTransfers(()=>a);
 const old=api.nativeTransferTask(a,'download',{}),oldStopped=assert.rejects(old.promise,{name:'AbortError'});await turn();
 const invalidating=api.invalidateTransfers(a);api.configureNativeTransfers(()=>b);
 const next=api.nativeTransferTask(b,'download',{});await turn();assert.equal(h.queued.length,2);
 hash.resolve('f'.repeat(64));await invalidating;await oldStopped;h.complete=true;await api.refreshNativeTransfers();
 assert.deepEqual(await next.promise,{id:'job-1'});assert.equal(h.invalidated.length,1);
});

test('a new session of the same account waits for native invalidation before enqueueing',async t=>{
 const {h,api}=await fixture(t),nativeDone=deferred();h.bridge.invalidate=async args=>{h.invalidated.push(args);await nativeDone.promise;};api.configureNativeTransfers(()=>a);
 const invalidating=api.invalidateTransfers(a);await turn();const next=api.nativeTransferTask({...a,token:'c'.repeat(43)},'download',{});await turn();assert.equal(h.queued.length,0);
 nativeDone.resolve();await invalidating;await turn();assert.equal(h.queued.length,1);h.complete=true;await api.refreshNativeTransfers();assert.deepEqual(await next.promise,{id:'job-0'});
});

test('logout while the platform listener initializes prevents the old transfer from enqueueing',async t=>{
 const {h,api}=await fixture(t),listener=deferred();h.listener=listener.promise;api.configureNativeTransfers(()=>a);
 const old=api.nativeTransferTask(a,'download',{}),stopped=assert.rejects(old.promise,{name:'AbortError'});await api.invalidateTransfers(a);listener.resolve();await stopped;assert.equal(h.queued.length,0);
});

test('logout during native enqueue stops the late upload without deleting its retained source',async t=>{
 const {h,api}=await fixture(t),enqueued=deferred(),reply=deferred();h.bridge.enqueue=async()=>{enqueued.resolve();return reply.promise;};api.configureNativeTransfers(()=>a);
 const old=api.nativeTransferTask(a,'upload',{}),stopped=assert.rejects(old.promise,{name:'AbortError'});await enqueued.promise;await api.invalidateTransfers(a);reply.resolve({id:'late-upload'});await stopped;
 assert.equal(h.cancelled.length,1);assert.equal(h.cancelled[0].id,'late-upload');assert.equal(h.cancelled[0].cleanup,false);
});
