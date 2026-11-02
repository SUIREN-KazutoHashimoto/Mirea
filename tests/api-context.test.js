import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {compareVersions} from '../web/src/version-compatibility.js';
import {createOfflineVault,OFFLINE_MS,offlinePartition} from '../web/src/offline-vault.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const actor=(token,userId='synthetic-user')=>({token:token.repeat(43),user:{id:userId,name:'Synthetic',email:'qa@example.invalid'},expiresAt:Date.now()+86400000});
const response=(status=200,value={},body)=>({status,ok:status>=200&&status<300,headers:new Headers(),json:()=>body??Promise.resolve(value),blob:()=>body??Promise.resolve(new Blob(['synthetic']))});
const fixtureContexts=new WeakSet();

// Import the actual API ES module. Only its platform/storage collaborators are
// stubbed, so request, response, body and session-boundary logic all execute.
async function fixture(t,{native=true}={}){
 const names=['window','location','localStorage','sessionStorage','fetch','__mireaApiContextTest'],saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 const storage=new Map([['mirea.server','https://old.example.invalid']]),events=[],diagnostics=[],window=new EventTarget();
 window.addEventListener('mirea:server-version',event=>events.push(event.detail));window.addEventListener('mirea:unauthorized',()=>events.push('unauthorized'));
 const h={native,events,diagnostics,budgets:[],compareVersions,fetch:async()=>response(),load:async()=>null,offlineIdentity:async()=>null,vault:{setLoggedOut:async()=>{},forget:async()=>{},loggedOut:async()=>false},sessionRequest:null};
 const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 for(const [name,value]of Object.entries({window,location:{origin:'https://web.example.invalid'},localStorage,sessionStorage:localStorage,__mireaApiContextTest:h,fetch:(...args)=>h.fetch(...args)}))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
 const stubs={
  './error-diagnostics.js':"export function requestError(data,status,options={}){if(options.record!==false)h.diagnostics.push({data,status});return Object.assign(Error(data.error||'Request failed'),{status});} export function clearDiagnostics(){h.diagnostics.length=0;}",
  './client-version.js':"export default {version:'0.25.0-beta'};",
  './version-compatibility.js':"export const compareVersions=h.compareVersions;",
  './native-player-bridge.js':"export const NativePlayer={};export const nativePlayerAvailable=()=>false;export const invalidateNativePlayback=()=>{};",
  '@capacitor/core':"export const Capacitor={isNativePlatform:()=>h.native};export const registerPlugin=()=>({});",
  './offline-vault.js':"export const offlineVault=async()=>h.vault;export const offlineIdentity=(...args)=>h.offlineIdentity(...args);export const forgetOfflineIdentity=async()=>{};",
  './connection-budget.js':"export const connectionBudget=options=>{h.budgets.push(options);return {signal:undefined,dispose(){}};};",
  './session-store.js':"export function createLoginStore(options){h.sessionRequest=options.request;return {load:(...args)=>h.load(...args),save:async()=>true,clear:async()=>true};}",
  './resumable-upload.js':"export const createResumableUpload=()=>{};",
  './update-busy.js':"export const beginUpdateActivity=()=>()=>{};",
  './native-transfers.js':"export const nativeTransfersAvailable=()=>false;export const nativeUpload=()=>{};export const configureNativeTransfers=()=>{};export const invalidateTransfers=async()=>{};",
  './download-core.js':"export const ciphertextHash=async()=>'';",
  './transfer-manager.js':"export const stopTransfers=()=>{};export const clearTransferRecords=()=>{};",
  './private-shelves.js':"export const clearShelfUnlocks=()=>{};export const shelfUnlockValue=()=>'';export const unlockRequiredShelf=async()=>{};",
 };
 const id=crypto.randomUUID(),hook=registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/api.js?test='+id)&&stubs[specifier])return {url:'data:text/javascript,'+encodeURIComponent('const h=globalThis.__mireaApiContextTest;'+stubs[specifier]+'\n// '+id),shortCircuit:true};return next(specifier,context);}});
 let api;try{api=await import('../web/src/api.js?test='+id);}finally{hook.deregister();}
 if(!fixtureContexts.has(t)){fixtureContexts.add(t);t.after(()=>{for(const name of names){const descriptor=saved.get(name);if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});}
 await api.setSession(actor('a'));return {...h,h,api};
}
const aborted=promise=>assert.rejects(promise,error=>error.name==='AbortError');

test('late configuration from a previous endpoint cannot change compatibility or emit a version event',async t=>{
 const {h,api}=await fixture(t),old=deferred();h.fetch=async url=>url.startsWith('https://old.')?old.promise:response(200,{version:'0.25.0-beta'});
 const pending=api.api('/config'),assertion=aborted(pending);api.setEndpoint('https://new.example.invalid');await api.api('/config');old.resolve(response(200,{version:'99.0.0'}));await assertion;
 assert.equal(api.getEndpoint(),'https://new.example.invalid');assert.deepEqual(h.events.map(event=>event.version),['0.25.0-beta']);assert.doesNotThrow(()=>api.requireCompatibleServer());assert.equal(h.diagnostics.length,0);
});
test('account revision is rechecked after a successful or malformed configuration body finishes',async t=>{
 for(const invalid of [false,true]){
  const {h,api}=await fixture(t),body=deferred(),reading=deferred();h.fetch=async()=>({...response(),json(){reading.resolve();return body.promise;}});
  const pending=api.api('/config'),assertion=aborted(pending);await reading.promise;await api.setSession(actor('b'));
  if(invalid)body.reject(new SyntaxError('Old response was truncated'));else body.resolve({version:'99.0.0'});await assertion;
  assert.equal(api.getSession().token,'b'.repeat(43));assert.deepEqual(h.events,[]);assert.equal(h.diagnostics.length,0);
 }
});
test('stale 401 bodies and network failures never log out or record errors against the new account',async t=>{
 for(const network of [false,true]){
  const {h,api}=await fixture(t),gate=deferred(),reading=deferred();h.fetch=async()=>network?gate.promise:({...response(401),json(){reading.resolve();return gate.promise;}});
  const pending=api.api('/content'),assertion=aborted(pending);if(!network)await reading.promise;await api.setSession(actor('b'));
  if(network)gate.reject(new TypeError('Old network disconnected'));else gate.resolve({error:'Old unauthorized response'});await assertion;
  assert.equal(api.getSession().token,'b'.repeat(43));assert.deepEqual(h.events,[]);assert.equal(h.diagnostics.length,0);
 }
});
test('conditional catalog responses are accepted only for the active request context',async t=>{
 const {h,api}=await fixture(t),gate=deferred();h.fetch=()=>gate.promise;const pending=api.api('/library/catalog',{allowNotModified:true}),assertion=aborted(pending);api.setEndpoint('https://new.example.invalid');
 const unchanged={...response(304),headers:new Headers({ETag:'"synthetic"','X-Mirea-Server-Time':'1800000000000'})};gate.resolve(unchanged);await assertion;
 h.fetch=async()=>unchanged;assert.deepEqual(await api.api('/library/catalog',{allowNotModified:true}),{notModified:true,etag:'"synthetic"',serverTime:1800000000000});
});
test('authenticated blobs reject stale header, body, body failure, error body and network results',async t=>{
 for(const phase of ['headers','body','body-reject','error','network']){
  const {h,api}=await fixture(t),gate=deferred(),reading=deferred();h.fetch=async()=>{
   if(['headers','network'].includes(phase))return gate.promise;
   if(phase==='error')return {...response(401),json(){reading.resolve();return gate.promise;}};
   return {...response(),blob(){reading.resolve();return gate.promise;}};
  };
  const pending=api.authenticatedBlob('/api/v1/items/synthetic/thumbnail'),assertion=aborted(pending);if(!['headers','network'].includes(phase))await reading.promise;await api.setSession(actor('b'));
  if(['body-reject','network'].includes(phase))gate.reject(new TypeError('Old transfer interrupted'));else gate.resolve(phase==='headers'?response():phase==='error'?{error:'Old unauthorized'}:new Blob(['old private image']));await assertion;
  assert.equal(api.getSession().token,'b'.repeat(43));assert.deepEqual(h.events,[]);assert.equal(h.diagnostics.length,0);
 }
});
test('remember-cookie requests also reject old headers, success/error bodies and network failures',async t=>{
 for(const phase of ['headers','body','body-reject','error','network']){
  const {h,api}=await fixture(t),gate=deferred(),reading=deferred();h.fetch=async()=>['headers','network'].includes(phase)?gate.promise:({...response(phase==='error'?503:200),json(){reading.resolve();return gate.promise;}});
  const pending=h.sessionRequest('/auth/remember'),assertion=aborted(pending);if(!['headers','network'].includes(phase))await reading.promise;api.setEndpoint('https://new.example.invalid');
  if(['body-reject','network'].includes(phase))gate.reject(new TypeError('Old connection interrupted'));else gate.resolve(phase==='headers'?response():phase==='error'?{error:'Old server error'}:actor('a'));await assertion;assert.equal(h.diagnostics.length,0);
 }
});
test('current request errors keep their status and Retry-After, and a current 401 still clears the login',async t=>{
 const {h,api}=await fixture(t);h.fetch=async()=>({...response(429,{error:'Wait'}),headers:new Headers({'Retry-After':'5'})});await assert.rejects(api.api('/content'),error=>error.status===429&&error.retryAfter==='5');assert.equal(api.getSession().token,'a'.repeat(43));
 h.fetch=async()=>response(401,{error:'Expired'});await assert.rejects(api.api('/content'),error=>error.status===401);assert.equal(api.getSession(),null);assert.equal(h.events.at(-1),'unauthorized');
});
test('late offline identity lookup cannot mark a replacement session offline',async t=>{
 const {h,api}=await fixture(t),gate=deferred();h.offlineIdentity=()=>gate.promise;const pending=api.markSessionOffline();await api.setSession(actor('b','replacement-user'));gate.resolve({user:actor('a').user});await pending;
 assert.equal(api.getSession().token,'b'.repeat(43));assert.equal(api.isOfflineSession(),false);
});
test('startup storage and logout-marker lookups cannot clear a newer login',async t=>{
 for(const stage of ['load','logout-marker']){
  const {h,api}=await fixture(t),gate=deferred(),reading=deferred();let markerCalls=0;
  h.load=()=>{if(stage==='load'){reading.resolve();return gate.promise;}return Promise.resolve({value:actor('a'),remember:true});};
  h.vault.loggedOut=()=>{markerCalls++;reading.resolve();return gate.promise;};
  const pending=api.initializeSession();await reading.promise;await api.setSession(actor('b'));gate.resolve(stage==='load'?{value:actor('a'),remember:true}:true);await pending;
  assert.equal(api.getSession().token,'b'.repeat(43));if(stage==='load')assert.equal(markerCalls,0);assert.deepEqual(h.events,[]);
 }
});

test('startup offline fallback cannot overwrite a login or logout that completed during the lookup',async t=>{
 for(const replacement of [actor('b','replacement-user'),null]){
  const {h,api}=await fixture(t),gate=deferred(),reading=deferred();h.load=async()=>({value:actor('a'),remember:true});h.fetch=async()=>{throw new TypeError('Connection unavailable');};
  h.offlineIdentity=()=>{reading.resolve();return gate.promise;};
  const pending=api.initializeSession({signal:new AbortController().signal});await reading.promise;await api.setSession(replacement);gate.resolve({user:actor('a').user});await pending;
  assert.equal(api.getSession(),replacement);assert.equal(api.isOfflineSession(),false);
 }
});

test('late startup identity lookup from a previous server cannot restore its account',async t=>{
 const {h,api}=await fixture(t),gate=deferred(),reading=deferred(),calls=[];
 h.load=async()=>({value:actor('a'),remember:true});h.fetch=async()=>{throw new TypeError('Connection unavailable');};
 h.offlineIdentity=(...args)=>{calls.push(args);reading.resolve();return gate.promise;};
 const pending=api.initializeSession({signal:new AbortController().signal});await reading.promise;
 api.setEndpoint('https://new.example.invalid');await api.setSession(actor('b','replacement-user'));
 gate.resolve({user:actor('a').user});await pending;
 assert.deepEqual(calls,[['https://old.example.invalid','synthetic-user']]);
 assert.equal(api.getEndpoint(),'https://new.example.invalid');assert.equal(api.getSession().user.id,'replacement-user');assert.equal(api.isOfflineSession(),false);
});

test('startup and connection loss use only the authenticated account grant, valid before but not at seven days',async t=>{
 for(const native of [false,true])for(const source of ['catalog','download'])for(const expired of [false,true]){
  const {h,api}=await fixture(t,{native}),origin=api.getEndpoint(),rows=new Map(),packages=[],calls=[];
  let time=1800000000000,elapsed=0;
  const store={vaultGet:async key=>rows.get(key),vaultPut:async(key,value)=>rows.set(key,structuredClone(value)),vaultInit:async(key,value)=>{if(!rows.has(key))rows.set(key,value);return rows.get(key);},vaultDelete:async key=>rows.delete(key),list:async partition=>packages.filter(row=>row.partition===partition)};
  const vault=await createOfflineVault(store,{wall:()=>time,mono:()=>elapsed,anchorMap:new Map()});h.vault=vault;
  const current=actor('a','current-user'),other=actor('b','another-user');
  async function save(session){
   const userId=session.user.id,partition=offlinePartition(origin,userId);
   if(source==='catalog')await vault.saveCatalog(partition,{userId,serverTime:time,items:[],shelves:[],series:[]},userId);
   else{
    const manifest={id:crypto.randomUUID(),assetId:crypto.randomUUID(),version:1,algorithm:'AES-256-GCM',chunkSize:1048576,title:'Synthetic',kind:'pdf',pageCount:1,files:[{index:0,number:1,size:12,chunks:1,mime:'application/pdf'}]};
    packages.push({partition,state:'ready',manifest});await vault.saveLease(partition,{manifest,userId,key:Buffer.alloc(32,7).toString('base64'),serverTime:time,expiresAt:time+OFFLINE_MS},userId);
   }
   await vault.saveIdentity(origin,session,true,{});
  }
  await save(current);elapsed=OFFLINE_MS-(expired?0:1);time+=elapsed;
  await save(other); // The newest remembered identity is a different, unexpired account.
  assert.equal((await vault.identity(origin)).user.id,other.user.id);
  h.offlineIdentity=(...args)=>{calls.push(args);return vault.identity(...args);};
  h.load=async()=>({value:current,remember:true});h.fetch=async()=>{throw new TypeError('Connection unavailable');};
  await api.setSession(current);await api.markSessionOffline();
  assert.equal(api.isOfflineSession(),!expired);assert.equal(api.getSession().user.id,current.user.id);
  await api.setSession(current);
  const pending=api.initializeSession({signal:new AbortController().signal});
  if(expired)await assert.rejects(pending);else await pending;
  assert.equal(api.getSession().user.id,current.user.id);assert.equal(api.isOfflineSession(),!expired);
  assert.deepEqual(calls,[[origin,current.user.id],[origin,current.user.id]],`${native?'native':'web'} ${source}: never borrow another account's fresh grant`);
  if(native&&!expired){
   api.setEndpoint('https://new.example.invalid');await api.setSession(current);
   await assert.rejects(api.initializeSession({signal:new AbortController().signal}));
   assert.deepEqual(calls.at(-1),['https://new.example.invalid',current.user.id]);assert.equal(api.isOfflineSession(),false);
  }
 }
});

test('startup uses a short fallback deadline only when usable offline data exists',async t=>{
 for(const cached of [false,true]){
  const {h,api}=await fixture(t);h.offlineIdentity=async()=>cached?{user:actor('a').user}:null;h.load=async()=>({value:actor('a'),remember:true});h.fetch=async()=>response(200,{user:actor('a').user});
  await api.initializeSession();assert.deepEqual(h.budgets,[{ms:cached?1200:10000}]);assert.equal(api.getSession().token,actor('a').token);
 }
});
