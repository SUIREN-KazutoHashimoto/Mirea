import {hashToken,httpError} from './security.js';
const name='__Secure-mirea_session',path='/api/v1',tokenPattern=/^[A-Za-z0-9_-]{43}$/;
export function readRememberToken(req){
  const raw=req.headers.cookie;if(typeof raw!=='string'||raw.length>8192)return null;
  const values=raw.split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));
  if(values.length!==1)return null;const token=values[0].slice(name.length+1);return tokenPattern.test(token)?token:null;
}
export function clearRememberCookie(reply){reply.header('Set-Cookie',`${name}=; Path=${path}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Strict`);}
export function issueRememberCookie(reply,token,expiresAt){
  if(!tokenPattern.test(token)||!Number.isSafeInteger(expiresAt))throw new Error('Invalid remembered session');
  const seconds=Math.max(0,Math.min(2592000,Math.floor((expiresAt-Date.now())/1000)));
  reply.header('Set-Cookie',`${name}=${token}; Path=${path}; Max-Age=${seconds}; Expires=${new Date(expiresAt).toUTCString()}; Secure; HttpOnly; SameSite=Strict`);
}
export function registerRememberSessions(app,{db,authenticate,enabled,rateLimit}){
  const limit={config:{rateLimit:rateLimit===false?false:{max:30,timeWindow:'1 minute'}}};
  app.get('/api/v1/auth/remember',limit,async(req,reply)=>{
    if(req.headers['sec-fetch-site']==='cross-site')throw httpError(403,'同じサイトから操作してください。');
    const token=readRememberToken(req),row=token&&db.prepare('SELECT s.expires_at,u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hashToken(token),Date.now());
    if(!row||!enabled(row.id)){if(token)clearRememberCookie(reply);return reply.code(401).send({error:'保持されたログインは無効です。ログインしてください。'});}
    // This never renews or creates a session. The original thirty-day deadline
    // and server-side revocation still apply. Other APIs remain Bearer-only.
    return {user:{id:row.id,name:row.name,email:row.email},token,expiresAt:row.expires_at};
  });
  app.post('/api/v1/auth/remember',{...limit,onRequest:async req=>authenticate(req)},async(req,reply)=>{
    const token=req.headers.authorization.slice(7);issueRememberCookie(reply,token,req.session.expires_at);return {remembered:true};
  });
  app.delete('/api/v1/auth/remember',{...limit,schema:{body:{type:'object',additionalProperties:false,required:['token'],properties:{token:{type:'string',pattern:tokenPattern.source}}}}},async(req,reply)=>{
    if(readRememberToken(req)===req.body.token)clearRememberCookie(reply);return reply.code(204).send();
  });
}
