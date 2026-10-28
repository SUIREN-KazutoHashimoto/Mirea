import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createLoginStore} from '../web/src/session-store.js';
import {connectionBudget} from '../web/src/connection-budget.js';
import {requestError,clearDiagnostics} from '../web/src/error-diagnostics.js';
const source=await readFile(new URL('../web/src/api.js',import.meta.url),'utf8'),origin='https://mirea.test',user={id:'owner',name:'Owner',email:'owner@test'},saved={user,token:'a'.repeat(43),expiresAt:Date.now()+86400000};
async function scenario({native=true,cached=true,online=true,status,bodyDelay=false,loggedOut=false,temporarySession=false,reconnect=false}={}){
  let clears=0,requests=0,connected=false;const storage=new Map(),window=new EventTarget();
  if(temporarySession)storage.set('mirea.session:web',JSON.stringify({origin:'',remember:false,session:saved}));
  const secure={load:async()=>({session:JSON.stringify(saved)}),clear:async()=>{clears++;},save:async()=>{}};
  const vault={loggedOut:async()=>loggedOut,setLoggedOut:async()=>{},forget:async()=>{},saveIdentity:async()=>{}};
  const fetch=async(path,{signal}={})=>{
    requests++;signal?.throwIfAborted();
    if(connected)return path.endsWith('/auth/me')?new Response(JSON.stringify({user})):new Response('{}',{status:401});
    if(status)return new Response(JSON.stringify({error:'denied'}),{status});
    const pending=()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    if(bodyDelay)return {ok:true,status:200,json:pending};
    return pending();
  };
  const context=createContext({fetch,console,AbortSignal,AbortController,setTimeout,clearTimeout,URL,Response,TextEncoder,crypto,Event,window,location:{origin},localStorage:{getItem:()=>origin,setItem:()=>{}},sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
  const exports={
    './error-diagnostics.js':{requestError,clearDiagnostics},
    './native-transfers.js':{nativeTransfersAvailable:()=>native,nativeUpload:()=>{},configureNativeTransfers:()=>{},invalidateTransfers:()=>{}},
    './download-core.js':{ciphertextHash:async()=> 'fixture-partition'},'./transfer-manager.js':{stopTransfers:()=>{},clearTransferRecords:()=>{}},
    './private-shelves.js':{clearShelfUnlocks:()=>{},shelfUnlockValue:()=>'',unlockRequiredShelf:async()=>{}},
    './native-player-bridge.js':{NativePlayer:{},nativePlayerAvailable:()=>false,invalidateNativePlayback:()=>{}},
    '@capacitor/core':{Capacitor:{isNativePlatform:()=>native},registerPlugin:()=>secure},
    './offline-vault.js':{offlineVault:async()=>vault,offlineIdentity:async()=>cached&&!loggedOut?{user,expiresAt:saved.expiresAt}:null,forgetOfflineIdentity:async()=>{}},
    './session-store.js':{createLoginStore},'./connection-budget.js':{connectionBudget},
    './resumable-upload.js':{createResumableUpload:()=>{}},'./update-busy.js':{beginUpdateActivity:()=>()=>{}}
  };
  const module=new SourceTextModule(source,{context,initializeImportMeta:meta=>{meta.env={};},importModuleDynamically:async specifier=>{assert.equal(specifier,'./downloads.js');const imported=new SyntheticModule(['syncNativeDownloads'],function(){this.setExport('syncNativeDownloads',async()=>{});},{context});await imported.link(()=>{});await imported.evaluate();return imported;}});
  await module.link(specifier=>{const values=exports[specifier];if(!values)throw Error(specifier);return new SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});});await module.evaluate();
  const budget=connectionBudget({ms:35,online}),start=performance.now();let error;
  try{await module.namespace.initializeSession({signal:budget.signal});}catch(e){error=e;}finally{budget.dispose();}
  const elapsed=performance.now()-start;if(reconnect){connected=true;await module.namespace.reconnectSession({signal:AbortSignal.timeout(300)});}
  return {session:module.namespace.getSession(),error,clears,requests,elapsed};
}
for(const native of [true,false])for(const bodyDelay of [false,true]){
  const result=await scenario({native,bodyDelay});assert.equal(result.error,undefined);assert.equal(result.session.offline,true);assert.equal(result.session.user.id,user.id);assert.equal(result.session.token,native?saved.token:'');assert.equal(result.clears,0);assert.ok(result.elapsed<600);
}
const temporary=await scenario({native:false,temporarySession:true,reconnect:true});assert.equal(temporary.session.token,saved.token);assert.equal(temporary.session.offline,false);assert.equal(temporary.clears,0);
const offline=await scenario({online:false});assert.equal(offline.requests,0);assert.equal(offline.session.offline,true);assert.ok(offline.elapsed<100);
const expired=await scenario({cached:false});assert.ok(expired.error);assert.notEqual(expired.session?.offline,true);assert.equal(expired.clears,0);
for(const native of [true,false])for(const status of [401,403]){const denied=await scenario({native,status});assert.equal(denied.session,null);assert.equal(denied.session?.offline,undefined);}
const loggedOut=await scenario({loggedOut:true});assert.equal(loggedOut.session,null);
console.log(JSON.stringify({unreachableAndStalledBody:true,browserAndNative:true,offlineImmediate:true,denialDoesNotFallback:true,expiredGrantDenied:true,temporarySessionReconnect:true,rememberedCredentialsPreserved:true}));
