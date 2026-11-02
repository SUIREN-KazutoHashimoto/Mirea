import {defaultCredentialWarning} from './bootstrap-admin.js';
import {verifyPassword, httpError} from './security.js';

export function createAdminAccess(db, options, authenticate) {
  const confirmations=new Map();
  const configured = () => options.serverAdminUserIds ?? (process.env.SERVER_ADMIN_USER_IDS ?? '').split(',').map(id=>id.trim()).filter(Boolean);
  if(configured().some(id=>!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))) throw new Error('Invalid SERVER_ADMIN_USER_IDS');
  const role = id => db.prepare('SELECT server_role FROM user_access WHERE user_id=?').get(id)?.server_role ?? (configured().includes(id)?'admin':'user');
  const enabled = id => !db.prepare('SELECT disabled FROM user_access WHERE user_id=?').get(id)?.disabled;
  const isAdmin = id => role(id)==='admin' && enabled(id) && Boolean(db.prepare('SELECT 1 FROM users WHERE id=?').get(id));
  const lastAdmin = id => isAdmin(id) && ![...new Set([...configured(),...db.prepare("SELECT user_id FROM user_access WHERE server_role='admin' AND disabled=0").all().map(row=>row.user_id)])].some(other=>other!==id && isAdmin(other));
  const requireAdmin = req => {authenticate(req);if(defaultCredentialWarning(db,req.user.id))throw httpError(403,'初期管理者のメールアドレスとパスワードを変更してください。');if(!isAdmin(req.user.id))throw httpError(403,'サーバー管理者のみ利用できます。');};
  const audit = (req,action,target=null,detail={}) => db.prepare('INSERT INTO admin_audit(actor_id,action,target_id,detail_json,created_at) VALUES(?,?,?,?,?)').run(req.user.id,action,target,JSON.stringify(detail),Date.now());
  async function reauthenticate(req) {
    requireAdmin(req);
    if(options.rateLimit!==false){
      const now=Date.now(),old=confirmations.get(req.user.id),entry=old&&old.until>now?old:{until:now+60000,count:0};
      if(entry.count>=20)throw httpError(429,'管理操作の確認が多すぎます。1分ほど待ってください。');
      entry.count++;confirmations.set(req.user.id,entry);if(confirmations.size>1000)confirmations.delete(confirmations.keys().next().value);
    }
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if(!await verifyPassword(req.body?.currentPassword??'',user.password_hash))throw httpError(403,'現在の管理者パスワードが違います。');
    requireAdmin(req);
    if(db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id)?.password_hash!==user.password_hash)throw httpError(409,'アカウント情報が変更されました。');
  }
  return {role,enabled,isAdmin,lastAdmin,requireAdmin,reauthenticate,audit};
}
