import {registerPlugin,Capacitor} from '@capacitor/core';
import {offlineVault,offlinePartition} from './offline-vault.js';
const biometric=registerPlugin('MireaBiometric'),grants=new Map(),pending=new Map();let context;
export const configurePrivateShelves=value=>{context=value;};
export const unlockRequiredShelf=id=>{const shelf=context?.getShelf?.(id);if(!shelf)throw Error('本棚の一覧を更新してから開き直してください。');return requirePrivateShelf(shelf,{force:true});};
export const clearShelfUnlocks=()=>{grants.clear();pending.clear();};
export const shelfUnlockValue=()=>[...grants.values()].filter(g=>g.token&&g.expiresAt>Date.now()).map(g=>g.token).join(',');
const bytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const base64=value=>btoa(String.fromCharCode(...new Uint8Array(value)));
async function passwordProof(password,salt){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);return base64(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:310000,salt:bytes(salt)},key,256));}
// Android signatures use ASN.1 DER; WebCrypto expects fixed-width r || s.
export function ecdsaRaw(der){let p=2;if(der[0]!==48||der[1]>=128)throw Error('Invalid signature');const out=new Uint8Array(64);for(let n=0;n<2;n++){if(der[p++]!==2)throw Error('Invalid signature');let size=der[p++];if(size===33&&der[p]===0){p++;size--;}if(size>32||size<1||p+size>der.length)throw Error('Invalid signature');out.set(der.subarray(p,p+size),n*32+32-size);p+=size;}if(p!==der.length)throw Error('Invalid signature');return out;}
export function requirePrivateShelf(shelf,options={}){
 if(!shelf?.private)return Promise.resolve();const key=context.getEndpoint()+'|'+context.getSession()?.token+'|'+shelf.id;if(pending.has(key))return pending.get(key);
 const task=checkPrivateShelf(shelf,options).finally(()=>{if(pending.get(key)===task)pending.delete(key);});pending.set(key,task);return task;
}
async function checkPrivateShelf(shelf,{force=false}={}){
 if(!shelf?.private)return;const {api,getSession,getEndpoint,isOffline,dialog}=context,session=getSession(),origin=getEndpoint(),partition=offlinePartition(origin,session.user.id);
 const current=()=>getSession()?.user.id===session.user.id&&getSession()?.token===session.token&&getEndpoint()===origin;
 if(!force&&grants.get(shelf.id)?.expiresAt>Date.now()&&(isOffline()||grants.get(shelf.id)?.token))return;
 const vault=await offlineVault(),saved=await vault.unseal(partition,'private-password'),native=Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('MireaBiometric');
 return new Promise((resolve,reject)=>{
  let done=false,busy=false;
  const node=dialog('プライベート本棚を開く','<form class="modal-body private-shelf-auth"><p>本人のMireaパスワードで確認してください。</p><label>パスワード<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label><p class="form-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button secondary private-biometric" hidden>生体認証で開く</button><button class="button primary" type="submit">開く</button></div><p class="muted private-biometric-help" hidden>生体認証を利用するには、一度パスワードで開いて端末を登録してください。</p></form>');
  const form=node.querySelector('form'),error=node.querySelector('.form-error'),bio=node.querySelector('.private-biometric');
  function finish(grant){if(!current())throw Error('アカウントが変更されました。');grants.delete(shelf.id);grants.set(shelf.id,grant);while(grants.size>20)grants.delete(grants.keys().next().value);done=true;node.close();resolve();}
  async function action(work){if(busy)return;busy=true;error.hidden=true;form.querySelectorAll('button').forEach(b=>b.disabled=true);try{await work();}catch(e){error.textContent=e.message;error.hidden=false;form.elements.password.focus();}finally{busy=false;form.querySelectorAll('button').forEach(b=>b.disabled=false);}}
  form.onsubmit=e=>{e.preventDefault();action(async()=>{
   const password=form.elements.password.value;form.elements.password.value='';let grant;
   if(isOffline()){
    if(!saved||await passwordProof(password,saved.salt)!==saved.proof)throw Error(saved?'パスワードが違います。':'オンラインで一度この本棚を開いてください。');
    grant={token:'',expiresAt:Date.now()+24*3600000};
   }else{
    grant=await api('/shelves/'+shelf.id+'/unlock',{method:'POST',body:{password}});
    const salt=base64(crypto.getRandomValues(new Uint8Array(16))),record={salt,proof:await passwordProof(password,salt)};
    if(native)try{const key=await biometric.publicKey({origin:origin||location.origin,userId:session.user.id});await api('/shelves/'+shelf.id+'/biometric/enroll',{method:'POST',body:{password,publicKey:key.publicKey}});record.publicKey=key.publicKey;record.keyId=key.keyId;}catch{/* Password access remains available without a biometric sensor. */}
    if(current())await vault.seal(partition,'private-password',record);
   }
   finish(grant);
  });};
  bio.hidden=!(native&&saved?.keyId);node.querySelector('.private-biometric-help').hidden=!native||Boolean(saved?.keyId);
  bio.onclick=()=>action(async()=>{
   let challenge;if(isOffline())challenge=base64(crypto.getRandomValues(new Uint8Array(32)));else challenge=(await api('/shelves/'+shelf.id+'/biometric/challenge',{method:'POST',body:{keyId:saved.keyId}})).challenge;
   const result=await biometric.sign({origin:origin||location.origin,userId:session.user.id,challenge});if(!current())throw Error('アカウントが変更されました。');
   const key=await crypto.subtle.importKey('spki',bytes(saved.publicKey),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,ecdsaRaw(bytes(result.signature)),new TextEncoder().encode(challenge)))throw Error('端末の生体認証鍵が変更されています。パスワードで登録し直してください。');
   const grant=isOffline()?{token:'',expiresAt:Date.now()+24*3600000}:await api('/shelves/'+shelf.id+'/biometric/unlock',{method:'POST',body:{challenge,signature:result.signature}});finish(grant);
  });
  node.addEventListener('close',()=>{if(!done)reject(new Error('本人確認をキャンセルしました。'));},{once:true});
  if(native&&saved?.keyId){
   // Existing device-bound enrolment is still required; never replace the
   // server challenge/signature verification with a local boolean result.
   queueMicrotask(()=>{if(node.isConnected&&current())bio.click();});
  }else form.elements.password.focus();
 });
}
