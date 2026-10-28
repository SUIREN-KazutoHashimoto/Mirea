import {createPublicKey,verify,createHash} from 'node:crypto';
import {newToken,hashToken,verifyPassword,httpError} from './security.js';

// A login bearer token alone cannot open a private shelf. Password checks and
// biometric challenge responses issue a separate, session/shelf-bound grant.
export function registerPrivateShelves(app,{db,authenticate,membership,rateLimit}){
 const auth={onRequest:async req=>authenticate(req)},attempts=new Map();
 function shelf(req){membership(req.params.id,req.user.id);if(!db.prepare('SELECT private FROM shelves WHERE id=?').get(req.params.id)?.private)throw httpError(409,'プライベート本棚ではありません。');}
 function throttle(req){if(rateLimit===false)return;const now=Date.now(),before=attempts.get(req.user.id),row=before?.until>now?before:{until:now+60000,count:0};if(++row.count>10)throw httpError(429,'本人確認が多すぎます。1分ほど待ってください。');attempts.set(req.user.id,row);if(attempts.size>1000)attempts.delete(attempts.keys().next().value);}
 async function password(req){throttle(req);const row=db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);if(typeof req.body?.password!=='string'||req.body.password.length>128||!await verifyPassword(req.body.password,row.password_hash))throw httpError(403,'パスワードが違います。');authenticate(req);if(db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id)?.password_hash!==row.password_hash)throw httpError(409,'パスワードが変更されました。');return row.password_hash;}
 function issue(req,hash){shelf(req);const token=newToken(),expiresAt=Math.min(req.session.expires_at,Date.now()+24*3600000);db.prepare('INSERT INTO shelf_unlocks VALUES(?,?,?,?,?)').run(hashToken(token),req.session.id,req.params.id,hash,expiresAt);return {token,shelfId:req.params.id,expiresAt};}
 app.post('/api/v1/shelves/:id/unlock',auth,async req=>{shelf(req);return issue(req,await password(req));});
 app.post('/api/v1/shelves/:id/biometric/enroll',auth,async req=>{
  shelf(req);const hash=await password(req);let key,encoded;
  try{encoded=req.body.publicKey;if(typeof encoded!=='string'||encoded.length>512)throw Error();key=createPublicKey({key:Buffer.from(encoded,'base64'),format:'der',type:'spki'});if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails.namedCurve!=='prime256v1')throw Error();}catch{throw httpError(400,'生体認証の公開鍵が不正です。');}
  const id=createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
  if(!db.prepare('SELECT 1 FROM shelf_biometric_keys WHERE id=? AND user_id=?').get(id,req.user.id)&&db.prepare('SELECT COUNT(*) n FROM shelf_biometric_keys WHERE user_id=?').get(req.user.id).n>=20)throw httpError(409,'生体認証端末の登録上限です。パスワードで開いてください。');
  db.prepare('INSERT INTO shelf_biometric_keys VALUES(?,?,?,?) ON CONFLICT(id,user_id) DO UPDATE SET public_key=excluded.public_key,password_hash=excluded.password_hash').run(id,req.user.id,encoded,hash);return {keyId:id};
 });
 app.post('/api/v1/shelves/:id/biometric/challenge',auth,async req=>{
  shelf(req);throttle(req);const key=db.prepare('SELECT k.* FROM shelf_biometric_keys k JOIN users u ON u.id=k.user_id AND u.password_hash=k.password_hash WHERE k.id=? AND k.user_id=?').get(req.body?.keyId??'',req.user.id);if(!key)throw httpError(428,'最初にパスワードで、この端末の生体認証を登録してください。');
  db.prepare('DELETE FROM shelf_challenges WHERE expires_at<=?').run(Date.now());const challenge=newToken();db.prepare('INSERT INTO shelf_challenges VALUES(?,?,?,?,?)').run(challenge,req.session.id,req.params.id,key.id,Date.now()+60000);return {challenge};
 });
 app.post('/api/v1/shelves/:id/biometric/unlock',auth,async req=>{
  shelf(req);throttle(req);const challenge=req.body?.challenge??'',row=db.prepare('SELECT * FROM shelf_challenges WHERE challenge=? AND session_id=? AND shelf_id=? AND expires_at>?').get(challenge,req.session.id,req.params.id,Date.now());
  if(row)db.prepare('DELETE FROM shelf_challenges WHERE challenge=?').run(challenge);const key=row&&db.prepare('SELECT k.* FROM shelf_biometric_keys k JOIN users u ON u.id=k.user_id AND u.password_hash=k.password_hash WHERE k.id=? AND k.user_id=?').get(row.key_id,req.user.id);
  let valid=false;try{if(key&&typeof req.body.signature==='string'&&req.body.signature.length<256)valid=verify('sha256',Buffer.from(challenge),createPublicKey({key:Buffer.from(key.public_key,'base64'),format:'der',type:'spki'}),Buffer.from(req.body.signature,'base64'));}catch{/* Fail closed. */}
  if(!valid)throw httpError(403,'生体認証を確認できません。パスワードで開き直してください。');return issue(req,key.password_hash);
 });
 function requireUnlock(req,shelfId){
  if(!shelfId||!db.prepare('SELECT private FROM shelves WHERE id=?').get(shelfId)?.private)return;
  authenticate(req);membership(shelfId,req.user.id);
  const tokens=String(req.headers['x-mirea-shelf-unlock']??'').split(',').slice(0,20);
  if(!tokens.some(token=>/^[A-Za-z0-9_-]{43}$/.test(token)&&db.prepare('SELECT 1 FROM shelf_unlocks g JOIN users u ON u.id=? AND u.password_hash=g.password_hash WHERE g.token_hash=? AND g.session_id=? AND g.shelf_id=? AND g.expires_at>?').get(req.user.id,hashToken(token),req.session.id,shelfId,Date.now())))throw Object.assign(httpError(423,'プライベート本棚を開くには本人確認が必要です。'),{shelfUnlockRequired:shelfId});
 }
 app.addHook('preHandler',async req=>{
  const path=req.url.split('?')[0];let id;
  const direct=path.match(/^\/api\/v1\/shelves\/([^/]+)\/(?:items|series|uploads)(?:\/|$)/);if(direct)id=direct[1];
  const asset=path.match(/^\/api\/v1\/items\/([^/]+)\/(playback-ticket|content|epub|pages|download|hls|renditions|preview)(?:\/|$)/);if(asset){
   // Issued playback tickets are independent of the library's current view.
   // Their own routes still validate session, expiry and current membership.
   if(req.method==='GET'||req.method==='HEAD'){if(req.query?.ticket)return;}
   id=db.prepare('SELECT shelf_id FROM items WHERE id=?').get(asset[1])?.shelf_id;
  }
  const download=path.match(/^\/api\/v1\/downloads\/([^/]+)\/open$/);if(download)id=db.prepare('SELECT i.shelf_id FROM encrypted_downloads d JOIN items i ON i.id=d.asset_id WHERE d.id=?').get(download[1])?.shelf_id;
  if(id)requireUnlock(req,id);
 });
 return {requireUnlock};
}
