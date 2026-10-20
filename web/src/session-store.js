const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
export function validSession(value,now=Date.now()){
  if(!value||!tokenPattern.test(value.token??'')||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||typeof value.user?.id!=='string'||typeof value.user?.name!=='string'||typeof value.user?.email!=='string')return null;
  return {token:value.token,expiresAt:value.expiresAt,user:{id:value.user.id,name:value.user.name,email:value.user.email}};
}
// Browser credentials live only in an HttpOnly cookie; native credentials are
// encrypted by the Android Keystore bridge. sessionStorage is temporary only.
export function createLoginStore({native,temporary,secure,request}){
  let tail=Promise.resolve();
  const key=origin=>'mirea.session:'+(origin||'web');
  const removeTemporary=origin=>{try{temporary()?.removeItem(key(origin));temporary()?.removeItem('mirea.session');}catch{}};
  const writeTemporary=(origin,value)=>{try{temporary()?.setItem(key(origin),JSON.stringify({origin,remember:false,session:value}));}catch{}};
  const enqueue=work=>{const task=tail.catch(()=>{}).then(work);tail=task;return task;};
  async function forgetPersistent(origin,token){
    if(native){if(origin)await secure.clear({origin});}
    else if(token)await request('/auth/remember',{method:'DELETE',body:{token}});
  }
  return {
    async load(origin){
      let raw;try{raw=JSON.parse(temporary()?.getItem(key(origin))??temporary()?.getItem('mirea.session')??'null');}catch{}
      if(raw){const value=validSession(raw.session??raw);if(value&&(raw.origin===undefined||raw.origin===origin))return {value,remember:raw.remember!==false,legacy:raw.session===undefined};removeTemporary(origin);}
      if(native){
        if(!origin)return null;const loaded=await secure.load({origin});let value;try{value=validSession(JSON.parse(loaded.session??'null'));}catch{}
        if(!value){if(loaded.session)await secure.clear({origin});return null;}return {value,remember:true};
      }
      try{const value=validSession(await request('/auth/remember'));return value?{value,remember:true}:null;}catch(error){if(error.status===401)return null;throw error;}
    },
    save(origin,input,remember=true){return enqueue(async()=>{
      const value=validSession(input);if(!value)throw new Error('ログイン情報が無効です。');
      try{
        if(!remember){await forgetPersistent(origin,value.token);removeTemporary(origin);writeTemporary(origin,value);return true;}
        if(native)await secure.save({origin,session:JSON.stringify(value)});
        else{
          await request('/auth/remember',{method:'POST',headers:{Authorization:'Bearer '+value.token}});
          const restored=await request('/auth/remember');if(restored.token!==value.token)throw new Error('Cookieを保持できません。');
        }
        removeTemporary(origin);return true;
      }catch{writeTemporary(origin,value);return false;}
    });},
    clear(origin,token){removeTemporary(origin);return enqueue(async()=>{try{await forgetPersistent(origin,token);return true;}catch{return false;}finally{removeTemporary(origin);}});}
  };
}
