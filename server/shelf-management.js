import {verifyPassword,httpError} from './security.js';
import {transaction} from './database.js';
export function registerShelfManagement(app,{db,authenticate,membership,maintenance,removeFiles,cleanupUploads,adminAccess,rateLimit}){
  const auth={onRequest:async req=>{authenticate(req);membership(req.params.id,req.user.id,['owner']);},config:{rateLimit:rateLimit===false?false:{max:10,timeWindow:'1 minute'}}};
  const string=(maxLength)=>({type:'string',minLength:1,maxLength});
  app.patch('/api/v1/shelves/:id',{...auth,schema:{body:{type:'object',additionalProperties:false,required:['name'],properties:{name:string(100)}}}},async req=>{
    const name=req.body.name.trim();if(!name)throw httpError(400,'本棚の名前を入力してください。');
    membership(req.params.id,req.user.id,['owner']);db.prepare('UPDATE shelves SET name=? WHERE id=?').run(name,req.params.id);
    return {id:req.params.id,name};
  });
  app.delete('/api/v1/shelves/:id',{...auth,schema:{body:{type:'object',additionalProperties:false,required:['currentPassword','confirmName','acknowledgeDelete'],properties:{currentPassword:string(128),confirmName:string(100),acknowledgeDelete:{const:true}}}}},async(req,reply)=>{
    const user=db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
    if(!await verifyPassword(req.body.currentPassword,user.password_hash))throw httpError(403,'現在のパスワードが違います。');
    authenticate(req);membership(req.params.id,req.user.id,['owner']);
    const unlock=await maintenance.acquire(req);
    try{
      authenticate(req);membership(req.params.id,req.user.id,['owner']);
      if(db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id)?.password_hash!==user.password_hash)throw httpError(409,'アカウント情報が変更されました。');
      const shelf=db.prepare('SELECT name FROM shelves WHERE id=?').get(req.params.id);
      if(req.body.confirmName!==shelf.name)throw httpError(400,'確認用の本棚名が一致しません。');
      if(db.prepare("SELECT 1 FROM upload_sessions WHERE shelf_id=? AND (state='processing' OR state='uploading' AND expires_at>?)").get(req.params.id,Date.now()))throw httpError(409,'アップロードの完了またはキャンセルを待ってください。');
      const items=db.prepare('SELECT * FROM items WHERE shelf_id=?').all(req.params.id),uploads=db.prepare('SELECT id FROM upload_sessions WHERE shelf_id=?').all(req.params.id).map(r=>r.id);
      transaction(db,()=>{membership(req.params.id,req.user.id,['owner']);db.prepare('DELETE FROM shelves WHERE id=?').run(req.params.id);adminAccess.audit(req,'shelf.delete',req.params.id,{assets:items.length});});
      let cleanupPending=0;for(const item of items){const results=await removeFiles(item);cleanupPending+=results.filter(r=>r.status==='rejected'&&r.reason.code!=='ENOENT').length;}
      await cleanupUploads(uploads);
      return reply.send({deleted:true,cleanupPending});
    }finally{unlock();}
  });
}
