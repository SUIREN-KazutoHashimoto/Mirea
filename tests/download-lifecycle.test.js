import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
async function fixture(t){
 const names=['window','location','navigator','isSecureContext','indexedDB','__downloadLifecycleFixture'],saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 const window=new EventTarget(),serviceWorker=new EventTarget();serviceWorker.controller={postMessage(){}};serviceWorker.ready=Promise.resolve();serviceWorker.register=async()=>({});
 const manifest={id:crypto.randomUUID(),assetId:crypto.randomUUID(),version:1,algorithm:'AES-256-GCM',chunkSize:1048576,title:'Synthetic',kind:'pdf',pageCount:1,files:[{index:0,number:1,size:3,chunks:1,mime:'application/pdf'}]};
 const h={revision:1,session:{user:{id:'synthetic'},token:'a'.repeat(43)},rows:new Map(),saves:0,removes:[],manifest,request:deferred(),requested:deferred()};
 h.store={getPackage:async key=>h.rows.get(key),savePackage:async(key,partition,value)=>{h.saves++;h.rows.set(key,{manifest:value,assetId:value.assetId});return h.rows.get(key);},remove:async key=>{h.removes.push(key);h.rows.delete(key);}};
 const values={window,location:{origin:'https://mirea.example.invalid'},navigator:{serviceWorker,storage:{}},isSecureContext:true,indexedDB:{},__downloadLifecycleFixture:h};for(const [name,value] of Object.entries(values))Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
 const stubs={
  './api.js':"export const getSession=()=>h.session,getEndpoint=()=>'',sessionRevision=()=>h.revision,isOfflineSession=()=>false;export async function api(){h.requested.resolve();return h.request.promise;}export const authenticatedBlob=()=>{};",
  './download-db.js':"export const openDownloadDb=async()=>h.store;",
  './native-player-bridge.js':"export const NativePlayer={},nativePlayerAvailable=()=>false;",
  './update-busy.js':"export const beginUpdateActivity=()=>()=>{};",
  './progress.js':"export const rememberDownloadProgress=()=>{};",
  './offline-vault.js':"export const offlineVault=async()=>({revoke:async()=>{}});",
  './native-transfers.js':"export const nativeTransfersAvailable=()=>false,NativeTransfer={},nativeTransferTask=()=>{};",
  './transfer-manager.js':"export function trackTransfer({work}){return {promise:Promise.resolve().then(()=>work(()=>{}))};}",
  './private-shelves.js':"export const shelfUnlockValue=()=>'';",
  './offline-catalog.js':"export const offlineCatalog=()=>{};"
 };
 const id=crypto.randomUUID(),hook=registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/downloads.js?test='+id)&&stubs[specifier])return {url:'data:text/javascript,'+encodeURIComponent('const h=globalThis.__downloadLifecycleFixture;'+stubs[specifier]+'//'+id),shortCircuit:true};return next(specifier,context);},load(url,context,next){const result=next(url,context);if(url.endsWith('/downloads.js?test='+id))return {...result,source:String(result.source).replace('import.meta.env.DEV','false')};return result;}});
 let downloads;try{downloads=await import('../web/src/downloads.js?test='+id);}finally{hook.deregister();}
 t.after(()=>{downloads.closeDownloads();for(const name of names){const value=saved.get(name);if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}});
 return {h,downloads,item:{id:manifest.assetId,title:'Synthetic',kind:'pdf'}};
}

test('removing a download cancels an in-flight manifest before any package exists and blocks late resurrection',async t=>{
 const {h,downloads,item}=await fixture(t),pending=downloads.downloadToDevice(item),stopped=assert.rejects(pending,{name:'AbortError'});await h.requested.promise;
 const removing=downloads.removeDownload(item.id);await assert.rejects(downloads.downloadToDevice(item),/削除中/);
 // Simulate a response completing even after cancellation reached fetch.
 h.request.resolve({manifest:h.manifest});await stopped;await removing;
 assert.equal(h.saves,0);assert.equal(h.rows.size,0);assert.equal(h.removes.length,1);
});

test('a queued download cannot adopt the account selected before its work microtask starts',async t=>{
 const {h,downloads,item}=await fixture(t),pending=downloads.downloadToDevice(item);h.session={user:{id:'other'},token:'b'.repeat(43)};h.revision++;
 await assert.rejects(pending,/ログイン先が変更/);assert.equal(h.saves,0);
});
