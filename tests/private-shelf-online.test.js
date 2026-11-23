import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async fn=>{for(let n=0;n<150;n++){if(fn())return;await sleep(10);}assert.fail('timed out waiting for fixture');};
const shelf={id:'private-synthetic',private:true};
const good=()=>({token:'a'.repeat(43),shelfId:shelf.id,expiresAt:Date.now()+60000});
const session=(id='account',token='opaque-session')=>({user:{id},token});
const b64=value=>Buffer.from(value).toString('base64');
const fakeUi=()=>{
 const pw=new EventTarget();pw.value='';pw.focus=()=>{};
 const bio={hidden:true,disabled:false,click(){return this.onclick?.();}},error={hidden:true,textContent:''},help={hidden:true};
 const form={elements:{password:pw},querySelectorAll:()=>[bio,{disabled:false}]};
 const node=new EventTarget();node.open=true;node.isConnected=true;
 node.close=()=>{if(node.open){node.open=false;node.dispatchEvent(new Event('close'));}};
 node.querySelector=k=>({form,'.form-error':error,'.private-biometric':bio,'.private-biometric-help':help})[k];
 return {node,form,error,bio,pw,submit(pass){pw.value=pass;pw.dispatchEvent(new Event('input'));return form.onsubmit(new Event('submit'));}};
};
async function fixture(t,{android=false,offline=false}={}){
 const h={vaultReads:0,unseals:0,apps:[],dialogs:[],bio:{},session:session(),offline,api:async()=>good(),unseal:async()=>null,seal:async()=>{}};
 const globalName='__mireaPrivateShelfFixture';
 globalThis[globalName]=h;
 const token=crypto.randomUUID(), stubs={
  '@capacitor/core':"export const registerPlugin=()=>h.bio;export const Capacitor={getPlatform:()=>h.android?'android':'web',isPluginAvailable:()=>h.android};",
  './offline-vault.js':"export const offlinePartition=(origin,user)=>origin+'|'+user;export const offlineVault=async()=>{h.vaultReads++;return {unseal:(...args)=>{h.unseals++;return h.unseal(...args);},seal:(...args)=>h.seal(...args)};};"
 };
 h.android=android;
 const hook=registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('?case='+token)&&stubs[specifier])return {url:'data:text/javascript,'+encodeURIComponent('const h=globalThis.'+globalName+';'+stubs[specifier]+'\n//'+token),shortCircuit:true};return next(specifier,context);}});
 let m;try{m=await import('../web/src/private-shelves.js?case='+token);}finally{hook.deregister();}
 const c={getSession:()=>h.session,getEndpoint:()=>h.origin??'https://local.example.invalid',
  isOffline:()=>h.offline,api:(p,o)=>{h.apps.push(p);return h.api(p,o);},
  dialog:()=>{const d=fakeUi();h.dialogs.push(d);return d.node;}};
 m.configurePrivateShelves(c);
 t.after(()=>{m.clearShelfUnlocks();delete globalThis[globalName];});
 return {m,h};
}
async function stored(password) {
 const salt=new Uint8Array(16).fill(1);
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
 const proof=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:310000,salt},key,256);
 return {salt:b64(salt),proof:b64(proof)};
}
function rawToDer(raw){
 const integer=bytes=>{let v=Buffer.from(bytes);while(v.length>1&&v[0]===0)v=v.subarray(1);if(v[0]&128)v=Buffer.concat([Buffer.from([0]),v]);return Buffer.concat([Buffer.from([2,v.length]),v]);};
 const v=Buffer.from(raw),fields=Buffer.concat([integer(v.subarray(0,32)),integer(v.subarray(32))]);
 return Buffer.concat([Buffer.from([48,fields.length]),fields]);
}

test('online password modal and server grant do not await decrypt, PBKDF2, or failing local writes',async t=>{
 const {m,h}=await fixture(t), cached=deferred(), called=deferred();
 h.unseal=()=>cached.promise;h.seal=()=>{called.resolve();return Promise.reject(Error('quota'));};
 const p=m.requirePrivateShelf(shelf);assert.equal(h.dialogs.length,1);assert.equal(h.unseals,0);
 await h.dialogs[0].submit('synthetic');await p;assert.equal(m.shelfUnlockValue(),good().token);
 await called.promise;assert.equal(m.shelfUnlockValue(),good().token);
 assert.deepEqual(h.apps,['/shelves/'+shelf.id+'/unlock']);cached.resolve(null);
});
test('slow Android vault never blocks the dialog or interrupts explicit password input',async t=>{
 const {m,h}=await fixture(t,{android:true}), cached=deferred(), requested=deferred(), server=deferred();
 h.unseal=()=>{requested.resolve();return cached.promise;};
 h.api=(url)=>url.endsWith('/unlock')?server.promise:Promise.reject(Error('unexpected'));
 h.bio.publicKey=async()=>{throw Error('No enrolment available');};
 const p=m.requirePrivateShelf(shelf);const ui=h.dialogs[0];assert(ui);
 await requested.promise;const submit=ui.submit('synthetic');
 cached.resolve({...await stored('synthetic'),keyId:'key',publicKey:'public'});
 await waitFor(()=>!ui.bio.hidden);
 assert.equal(h.apps.length,1);assert.equal(h.apps[0],'/shelves/'+shelf.id+'/unlock');
 server.resolve(good());await submit;await p;assert.equal(m.shelfUnlockValue(),good().token);
});
test('logout/replacement or canceled dialog rejects late server success and never begins enrollment',async t=>{
 for(const mode of ['replacement','cancel']){
  const {m,h}=await fixture(t), server=deferred();h.api=()=>server.promise;
  const p=m.requirePrivateShelf(shelf), rejection=assert.rejects(p), ui=h.dialogs[0], submit=ui.submit('synthetic');
  if(mode==='replacement'){m.clearShelfUnlocks();h.session=session('replacement','new-session');}else ui.node.close();
  server.resolve(good());await submit;await rejection;assert.equal(m.shelfUnlockValue(),'');assert.equal(h.vaultReads,0);
 }
});
test('online denial must not become an offline unlock or persist an offline proof',async t=>{
 const {m,h}=await fixture(t), server=deferred();h.api=()=>server.promise;let sealed=0;
 h.unseal=async()=>stored('synthetic');h.seal=()=>{sealed++;};
 const p=m.requirePrivateShelf(shelf), rejection=assert.rejects(p), ui=h.dialogs[0], submit=ui.submit('synthetic');
 h.offline=true;server.reject(Error('Denied by server'));await submit;
 assert.equal(ui.error.hidden,false);assert.equal(ui.error.textContent,'Denied by server');assert.equal(m.shelfUnlockValue(),'');assert.equal(sealed,0);assert.equal(h.unseals,0);
 ui.node.close();await rejection;
});
test('true offline transition requires local proof, never emits token, and does not satisfy online',async t=>{
 const {m,h}=await fixture(t,{offline:true});h.unseal=async()=>stored('correct');
 const p=m.requirePrivateShelf(shelf), ui=h.dialogs[0];
 await ui.submit('wrong');assert.equal(ui.error.hidden,false);assert.equal(ui.node.open,true);
 await ui.submit('correct');await p;assert.deepEqual(h.apps,[]);assert.equal(m.shelfUnlockValue(),'');
 h.offline=false;const online=m.requirePrivateShelf(shelf);assert.equal(h.dialogs.length,2);
 await h.dialogs[1].submit('correct');await online;assert.equal(m.shelfUnlockValue(),good().token);
});
test('remembered cold-start Web/PWA is genuinely offline with empty token; online empty identity is denied',async t=>{
 const {m,h}=await fixture(t,{offline:true});h.session={...session('remembered',''),offline:true};
 h.unseal=async()=>stored('correct');
 const p=m.requirePrivateShelf(shelf), ui=h.dialogs[0];assert(ui);
 await ui.submit('correct');await p;
 assert.equal(m.shelfUnlockValue(),'');assert.deepEqual(h.apps,[]);
 await m.requirePrivateShelf(shelf);assert.equal(h.dialogs.length,1);
 h.offline=false;h.session={...h.session,offline:false};
 await assert.rejects(m.requirePrivateShelf(shelf));assert.equal(h.dialogs.length,1);assert.deepEqual(h.apps,[]);
 h.session=session('remembered','online-bearer');
 const online=m.requirePrivateShelf(shelf);assert.equal(h.dialogs.length,2);
 await h.dialogs[1].submit('correct');await online;assert.equal(m.shelfUnlockValue(),good().token);
});
test('Android uses existing device signature and server challenge, then checks a real grant',async t=>{
 const {m,h}=await fixture(t,{android:true}), keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const pub=b64(await crypto.subtle.exportKey('spki',keys.publicKey));
 h.unseal=async()=>({...await stored('synthetic'),keyId:'existing-key',publicKey:pub});
 h.bio.sign=async({challenge})=>{
  const raw=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,new TextEncoder().encode(challenge));
  return {signature:b64(rawToDer(raw))};
 };
 h.api=async(path,options)=>{
  if(path.endsWith('/challenge')){assert.equal(options.body.keyId,'existing-key');return {challenge:'server-generated-challenge'};}
  assert(path.endsWith('/biometric/unlock'));assert.equal(options.body.challenge,'server-generated-challenge');assert(options.body.signature);
  return good();
 };
 await m.requirePrivateShelf(shelf);
 assert.deepEqual(h.apps.map(p=>p.split('/').at(-1)),['challenge','unlock']);assert.equal(m.shelfUnlockValue(),good().token);
});
test('IndexedDB versionchange reopens instead of retaining stale connection',async t=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'indexedDB'), opens=[];
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(){
  const r={result:{close(){this.closed=true;},transaction(){assert(!this.closed);}}};opens.push(r);queueMicrotask(()=>r.onsuccess());return r;
 }}});
 t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'indexedDB',descriptor);else delete globalThis.indexedDB;});
 const {openDownloadDb}=await import('../web/src/download-db.js?case='+crypto.randomUUID());
 const first=await openDownloadDb();assert.equal(await openDownloadDb(),first);
 opens[0].result.onversionchange();const second=await openDownloadDb();
 assert.notEqual(first,second);assert.equal(opens[0].result.closed,true);
 opens[0].result.onclose();assert.equal(await openDownloadDb(),second);
 assert.equal(opens.length,2);
});
