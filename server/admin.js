import {randomUUID} from 'node:crypto';
import {hashPassword,httpError} from './security.js';
import {transaction} from './database.js';

export const adminPassword={type:'string',minLength:1,maxLength:128};
export const adminBody=(properties={},required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties:{currentPassword:adminPassword,...properties},required:['currentPassword',...required]});
const email={type:'string',maxLength:254,minLength:3,pattern:'^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'};
const name={type:'string',minLength:1,maxLength:80};
const password={type:'string',minLength:12,maxLength:128};
const uuid={type:'string',pattern:'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'};

export function registerAdmin(app,{db,adminAccess:a,uploads,rateLimit}) {
  const auth={onRequest:async req=>a.requireAdmin(req),config:{rateLimit:rateLimit===false?false:{max:30,timeWindow:'1 minute'}}};
  const publicUser=user=>({id:user.id,name:user.name,email:user.email,createdAt:user.created_at,serverRole:a.role(user.id),disabled:!a.enabled(user.id),lastServerAdmin:a.lastAdmin(user.id)});
  app.get('/api/v1/admin/access',{onRequest:async req=>{try{a.requireAdmin(req);}catch(error){if(error.statusCode!==403)throw error;}}},async req=>({isServerAdmin:a.isAdmin(req.user.id)}));
  app.get('/api/v1/admin/overview',auth,async()=>({
    accounts:db.prepare('SELECT COUNT(*) n FROM users').get().n,
    shelves:db.prepare('SELECT COUNT(*) n FROM shelves').get().n,
    assets:db.prepare('SELECT mime_type AS mimeType,COUNT(*) AS count,SUM(size) AS canonicalBytes FROM items GROUP BY mime_type').all(),
    uploads:db.prepare('SELECT state,COUNT(*) AS count FROM upload_sessions GROUP BY state').all(),
    jobs:db.prepare('SELECT kind,state,COUNT(*) AS count FROM admin_jobs GROUP BY kind,state').all(),
    // Operational counts only: personal telemetry is accessible solely through
    // its owner endpoint, or the existing thresholded global aggregate API.
    schema:db.prepare('SELECT version FROM schema_version').get().version
  }));
  app.get('/api/v1/admin/users',{...auth,schema:{querystring:{type:'object',additionalProperties:false,properties:{q:{type:'string',maxLength:100},after:uuid}}}},async req=>{
    const q='%'+(req.query.q??'').replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')+'%';
    const rows=db.prepare("SELECT id,name,email,created_at FROM users WHERE id>? AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') ORDER BY id LIMIT 101").all(req.query.after??'',q,q);
    return {users:rows.slice(0,100).map(publicUser),nextCursor:rows.length>100?rows[99].id:null};
  });
  app.post('/api/v1/admin/users',{...auth,schema:{body:adminBody({name,email,password,serverRole:{enum:['user','admin']}},['name','email','password','serverRole'])}},async(req,reply)=>{
    await a.reauthenticate(req);const display=req.body.name.trim(),address=req.body.email.trim().toLowerCase();
    if(!display)throw httpError(400,'表示名を入力してください。');
    const hash=await hashPassword(req.body.password);a.requireAdmin(req);
    const id=randomUUID();
    transaction(db,()=>{
      if(db.prepare('SELECT 1 FROM users WHERE email=?').get(address))throw httpError(409,'このメールアドレスは登録済みです。');
      db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id,address,display,hash,Date.now());
      db.prepare('INSERT INTO user_access VALUES(?,?,0)').run(id,req.body.serverRole);
      a.audit(req,'account.create',id,{serverRole:req.body.serverRole});
    });return reply.code(201).send({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id))});
  });
  app.patch('/api/v1/admin/users/:id',{...auth,schema:{body:adminBody({name,email,serverRole:{enum:['user','admin']},disabled:{type:'boolean'}},[])}},async(req,reply)=>{
    await a.reauthenticate(req);
    transaction(db,()=>{
      const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);if(!user)throw httpError(404,'アカウントが見つかりません。');
      const role=req.body.serverRole??a.role(user.id),disabled=req.body.disabled??!a.enabled(user.id),display=(req.body.name??user.name).trim(),address=(req.body.email??user.email).trim().toLowerCase();
      if(!display)throw httpError(400,'表示名を入力してください。');
      if(a.lastAdmin(user.id) && (role!=='admin'||disabled))throw httpError(409,'最後の有効なサーバー管理者を解除・停止できません。');
      if(disabled && db.prepare("SELECT 1 FROM upload_sessions WHERE user_id=? AND state='processing'").get(user.id))throw httpError(409,'このアカウントのメディア処理が完了してから停止してください。');
      if(db.prepare('SELECT 1 FROM users WHERE email=? AND id!=?').get(address,user.id))throw httpError(409,'このメールアドレスは登録済みです。');
      db.prepare('UPDATE users SET name=?,email=? WHERE id=?').run(display,address,user.id);
      db.prepare('INSERT INTO user_access VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET server_role=excluded.server_role,disabled=excluded.disabled').run(user.id,role,disabled?1:0);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      a.audit(req,'account.update',user.id,{serverRole:role,disabled});
    });return reply.code(204).send();
  });
  app.delete('/api/v1/admin/users/:id',{...auth,schema:{body:adminBody({confirmEmail:email})}},async(req,reply)=>{
    await a.reauthenticate(req);
    const ids=transaction(db,()=>{
      const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);if(!user)throw httpError(404,'アカウントが見つかりません。');
      if(user.email!==req.body.confirmEmail.trim().toLowerCase())throw httpError(400,'確認メールアドレスが一致しません。');
      if(a.lastAdmin(user.id))throw httpError(409,'最後のサーバー管理者を削除できません。');
      const shelves=db.prepare("SELECT s.id,(SELECT COUNT(*) FROM items i WHERE i.shelf_id=s.id) AS assets,(SELECT COUNT(*) FROM memberships m WHERE m.shelf_id=s.id) AS members FROM shelves s JOIN memberships m ON m.shelf_id=s.id WHERE m.user_id=? AND m.role='owner'").all(user.id);
      if(shelves.some(s=>s.assets||s.members>1))throw httpError(409,'先に本棚の所有者を変更してください。共有アセットは削除しません。');
      if(db.prepare("SELECT 1 FROM upload_sessions WHERE user_id=? AND (state='processing' OR state='uploading' AND expires_at>?)").get(user.id,Date.now()))throw httpError(409,'アップロードの完了または取消を待ってください。');
      const ids=db.prepare('SELECT id FROM upload_sessions WHERE user_id=?').all(user.id).map(row=>row.id);
      db.prepare('DELETE FROM analytics_views WHERE user_id=?').run(user.id);
      for(const shelf of shelves)db.prepare('DELETE FROM shelves WHERE id=?').run(shelf.id);
      db.prepare('DELETE FROM users WHERE id=?').run(user.id);a.audit(req,'account.delete',user.id);return ids;
    });await uploads.cleanupUploads(ids);return reply.code(204).send();
  });
  app.get('/api/v1/admin/shelves',auth,async()=>({shelves:db.prepare('SELECT s.id,s.name,(SELECT COUNT(*) FROM items i WHERE i.shelf_id=s.id) AS assetCount FROM shelves s ORDER BY s.created_at DESC LIMIT 500').all()}));
  app.get('/api/v1/admin/shelves/:id/members',auth,async req=>({members:db.prepare('SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.shelf_id=? ORDER BY m.role,u.name').all(req.params.id)}));
  app.put('/api/v1/admin/shelves/:id/members/:userId',{...auth,schema:{body:adminBody({role:{enum:['owner','editor','viewer','remove']}})}},async(req,reply)=>{
    await a.reauthenticate(req);transaction(db,()=>{
      if(!db.prepare('SELECT 1 FROM shelves WHERE id=?').get(req.params.id)||!db.prepare('SELECT 1 FROM users WHERE id=?').get(req.params.userId))throw httpError(404,'本棚またはアカウントが見つかりません。');
      const previous=db.prepare('SELECT role FROM memberships WHERE shelf_id=? AND user_id=?').get(req.params.id,req.params.userId)?.role;
      if(previous==='owner' && req.body.role!=='owner')throw httpError(409,'別のメンバーを所有者に変更してから解除してください。');
      if(req.body.role==='owner')db.prepare("UPDATE memberships SET role='editor' WHERE shelf_id=? AND role='owner'").run(req.params.id);
      if(req.body.role==='remove')db.prepare('DELETE FROM memberships WHERE shelf_id=? AND user_id=?').run(req.params.id,req.params.userId);
      else db.prepare('INSERT INTO memberships VALUES(?,?,?) ON CONFLICT(shelf_id,user_id) DO UPDATE SET role=excluded.role').run(req.params.id,req.params.userId,req.body.role);
      a.audit(req,'shelf.permission',req.params.id,{userId:req.params.userId,role:req.body.role});
    });return reply.code(204).send();
  });
  app.get('/api/v1/admin/audit',auth,async()=>({entries:db.prepare('SELECT id,actor_id AS actorId,action,target_id AS targetId,detail_json AS detail,created_at AS createdAt FROM admin_audit ORDER BY id DESC LIMIT 100').all()}));
}
