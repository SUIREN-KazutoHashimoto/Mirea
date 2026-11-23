import {registerPlugin,Capacitor} from '@capacitor/core';
import {offlineVault,offlinePartition} from './offline-vault.js';

const biometric=registerPlugin('MireaBiometric'),grants=new Map(),pending=new Map(),dialogs=new Set(),refreshes=new Map();
const LOCAL_READ_MS=2600, CACHE_REFRESH_MS=10000, OFFLINE_GRANT_MS=24*3600000;
const cancelled=()=>Error('本人確認がキャンセルされました。');
const changed=()=>Error('アカウントまたは接続先が変更されました。開き直してください。');
const invalid=()=>Error('本棚の本人確認を完了できませんでした。');
let context,epoch=0;

export const configurePrivateShelves=value=>{if(context&&context!==value)clearShelfUnlocks();context=value;};
export const unlockRequiredShelf=id=>{const shelf=context?.getShelf?.(id);if(!shelf)throw Error('本棚の一覧を更新してから開き直してください。');return requirePrivateShelf(shelf,{force:true});};
export function clearShelfUnlocks(){
 epoch++;
 grants.clear();pending.clear();
 for(const close of [...dialogs])close(changed());
 for(const entry of refreshes.values())entry.cancel();
 refreshes.clear();
}
export const shelfUnlockValue=()=>[...grants.values()].filter(g=>g.scope.current()&&g.token&&g.expiresAt>Date.now()).map(g=>g.token).join(',');
const bytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const base64=value=>btoa(String.fromCharCode(...new Uint8Array(value)));
async function passwordProof(password,salt){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);return base64(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:310000,salt:bytes(salt)},key,256));}
// Android signatures use ASN.1 DER; WebCrypto expects fixed-width r || s.
export function ecdsaRaw(der){let p=2;if(der[0]!==48||der[1]>=128)throw Error('Invalid signature');const out=new Uint8Array(64);for(let n=0;n<2;n++){if(der[p++]!==2)throw Error('Invalid signature');let size=der[p++];if(size===33&&der[p]===0){p++;size--;}if(size>32||size<1||p+size>der.length)throw Error('Invalid signature');out.set(der.subarray(p,p+size),n*32+32-size);p+=size;}if(p!==der.length)throw Error('Invalid signature');return out;}

function newScope(){
 const owner=context,session=owner?.getSession(),origin=owner?.getEndpoint(),revision=epoch;
 const userId=session?.user?.id,token=session?.token,offlineOnly=token==='';
 // Remembered Web/PWA cold starts legitimately have no bearer. The scope
 // remains local-only and cannot survive reconnect as an online identity.
 if(!userId||typeof token!=='string'||offlineOnly&&!owner.isOffline())throw changed();
 return {owner,userId,token,origin,current:()=>{const latest=owner.getSession();return owner===context&&revision===epoch&&owner.getEndpoint()===origin&&
   latest?.user?.id===userId&&latest.token===token&&(!offlineOnly||owner.isOffline());}};
}
const validSaved=value=>value&&typeof value.salt==='string'&&/^[A-Za-z0-9+/]{22}==$/.test(value.salt)&&
  typeof value.proof==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value.proof) ? value : null;
const deviceKeySaved=value=>value&&typeof value.keyId==='string'&&value.keyId.length>0&&typeof value.publicKey==='string'&&value.publicKey.length>0;
function readSaved(partition){
 return new Promise(resolve=>{
  const timer=setTimeout(()=>resolve(null),LOCAL_READ_MS);
  Promise.resolve().then(async()=>validSaved(await(await offlineVault()).unseal(partition,'private-password')))
   .then(value=>{clearTimeout(timer);resolve(value);},()=>{clearTimeout(timer);resolve(null);});
 });
}

function refreshOfflineRecord(scope,partition,shelfId,password,native){
 // This work is never on the grant/online dialog critical path. It is tied
 // to the accepted current session and superseded by a later successful unlock.
 refreshes.get(partition)?.cancel();
 let timer;
 const controller=new AbortController(), entry={password,cancel(){clearTimeout(timer);this.password='';controller.abort();}};
 refreshes.set(partition,entry);password='';
 const current=()=>scope.current()&&refreshes.get(partition)===entry&&!controller.signal.aborted;
 timer=setTimeout(()=>{entry.cancel();if(refreshes.get(partition)===entry)refreshes.delete(partition);},CACHE_REFRESH_MS);
 void Promise.resolve().then(async()=>{
  if(!current())return;
  const salt=base64(crypto.getRandomValues(new Uint8Array(16))),record={salt,proof:await passwordProof(entry.password,salt)};
  if(!current())return;
  if(native)try{
   const key=await biometric.publicKey({origin:scope.origin||location.origin,userId:scope.userId});
   if(!current())return;
   if(deviceKeySaved(key)){
    await scope.owner.api('/shelves/'+shelfId+'/biometric/enroll',{method:'POST',body:{password:entry.password,publicKey:key.publicKey},signal:controller.signal});
    record.publicKey=key.publicKey;record.keyId=key.keyId;
   }
  }catch{/* An online grant does not depend on device enrollment. */}
  entry.password='';
  if(!current())return;
  const vault=await offlineVault();
  if(current())await vault.seal(partition,'private-password',record,{current,signal:controller.signal});
 }).catch(()=>{/* An online grant remains valid even when storage/crypto is unavailable. */})
   .finally(()=>{clearTimeout(timer);entry.cancel();if(refreshes.get(partition)===entry)refreshes.delete(partition);});
}

export function requirePrivateShelf(shelf,options={}){
 if(!shelf?.private)return Promise.resolve();
 let scope;try{scope=newScope();}catch(error){return Promise.reject(error);}
 const key=JSON.stringify([scope.origin,scope.userId,scope.token,shelf.id]);
 if(pending.has(key))return pending.get(key);
 const task=checkPrivateShelf(shelf,scope,options).finally(()=>{if(pending.get(key)===task)pending.delete(key);});
 pending.set(key,task);return task;
}
async function checkPrivateShelf(shelf,scope,{force=false}={}){
 const {api,isOffline,dialog}=scope.owner,partition=offlinePartition(scope.origin,scope.userId);
 const grant=grants.get(shelf.id);
 if(!force&&grant?.scope.current()&&grant.expiresAt>Date.now()&&(isOffline()||grant.token))return;
 const native=Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('MireaBiometric');
 let savedPromise;
 const saved=()=>{
  if(!savedPromise){
   const task=readSaved(partition).then(value=>{if(!value&&savedPromise===task)savedPromise=null;return value;});
   savedPromise=task;
  }
  return savedPromise;
 };
 return new Promise((resolve,reject)=>{
  let ended=false,busy=false,interacted=false,savedBio=null;
  const node=dialog('プライベート本棚を開く','<form class="modal-body private-shelf-auth"><p>本人のMireaパスワードで確認してください。</p><label>パスワード<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label><p class="form-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button secondary private-biometric" hidden>生体認証で開く</button><button class="button primary" type="submit">開く</button></div><p class="muted private-biometric-help" hidden>生体認証を利用するには、一度パスワードで開いて端末を登録してください。</p></form>');
  const form=node.querySelector('form'),error=node.querySelector('.form-error'),bio=node.querySelector('.private-biometric'),help=node.querySelector('.private-biometric-help');
  const active=()=>!ended&&node.isConnected&&node.open!==false&&scope.current();
  function requireActive(){if(!active())throw changed();}
  function close(rejection){
   if(ended)return;
   ended=true;dialogs.delete(close);form.elements.password.value='';
   if(node.open!==false&&node.isConnected)node.close();
   if(rejection)reject(rejection);else resolve();
  }
  function finish(value,online){
   requireActive();
   if(!value||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||
    (online&&(value.shelfId!==shelf.id||typeof value.token!=='string'||!(/^[A-Za-z0-9_-]{43}$/.test(value.token))))||
    (!online&&(!isOffline()||value.token!=='')))throw invalid();
   grants.delete(shelf.id);grants.set(shelf.id,{token:value.token,expiresAt:value.expiresAt,scope});
   while(grants.size>20)grants.delete(grants.keys().next().value);
   close();
  }
  function offlineFinish(){finish({token:'',expiresAt:Date.now()+OFFLINE_GRANT_MS},false);}
  async function action(work){
   if(busy||!active())return;
   busy=true;error.hidden=true;const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
   try{await work();}
   catch(e){if(active()){error.textContent=e.message;error.hidden=false;form.elements.password.focus();}else close(cancelled());}
   finally{busy=false;if(active())buttons.forEach(b=>b.disabled=false);}
  }
  node.addEventListener('close',()=>close(cancelled()),{once:true});dialogs.add(close);
  form.elements.password.addEventListener('input',()=>{interacted=true;});
  form.onsubmit=e=>{
   e.preventDefault();interacted=true;
   return action(async()=>{
    const password=form.elements.password.value;form.elements.password.value='';
    if(isOffline()){
     const record=await saved();requireActive();
     if(!isOffline())throw invalid();
     if(!record)throw Error('オンラインで一度この本棚を開いてください。');
     if(await passwordProof(password,record.salt)!==record.proof)throw Error('パスワードが違います。');
     offlineFinish();
    }else{
     const value=await api('/shelves/'+shelf.id+'/unlock',{method:'POST',body:{password}});
     finish(value,true);
     refreshOfflineRecord(scope,partition,shelf.id,password,native);
    }
   });
  };
  bio.hidden=true;help.hidden=true;
  bio.onclick=()=>action(async()=>{
   const record=savedBio;if(!deviceKeySaved(record))throw invalid();
   const local=isOffline();let challenge;
   if(local)challenge=base64(crypto.getRandomValues(new Uint8Array(32)));else challenge=(await api('/shelves/'+shelf.id+'/biometric/challenge',{method:'POST',body:{keyId:record.keyId}})).challenge;
   requireActive();if(typeof challenge!=='string'||!challenge)throw invalid();
   const result=await biometric.sign({origin:scope.origin||location.origin,userId:scope.userId,challenge});requireActive();
   const key=await crypto.subtle.importKey('spki',bytes(record.publicKey),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
   if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,ecdsaRaw(bytes(result.signature)),new TextEncoder().encode(challenge)))throw Error('端末の生体認証情報が変更されています。パスワードで登録し直してください。');
   requireActive();
   if(local)offlineFinish();
   else finish(await api('/shelves/'+shelf.id+'/biometric/unlock',{method:'POST',body:{challenge,signature:result.signature}}),true);
  });
  form.elements.password.focus();
  if(native)void saved().then(record=>{
   if(!active())return;
   if(!deviceKeySaved(record)){help.hidden=false;return;}
   savedBio=record;bio.hidden=false;
   // A slow local read must not interrupt explicit password entry.
   if(!interacted&&!busy)queueMicrotask(()=>{if(active()&&!interacted&&!busy)bio.click();});
  });
 });
}
