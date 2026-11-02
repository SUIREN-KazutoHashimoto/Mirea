import {httpError} from './security.js';
import {transaction} from './database.js';
// One durable, account-wide extra transfer, released at server acceptance.
export function pruneManualUploads(db,now=Date.now()){
 db.prepare(`DELETE FROM manual_upload_starts WHERE NOT EXISTS(
 SELECT 1 FROM upload_queue q LEFT JOIN upload_sessions u ON u.id=q.upload_id
 WHERE q.id=manual_upload_starts.queue_id AND q.user_id=manual_upload_starts.user_id
 AND (q.upload_id IS NULL AND q.expires_at>? AND manual_upload_starts.expires_at>?
 OR u.state='uploading' AND u.expires_at>?))`).run(now,now,now);
}
export function manualUploadSlot(db,userId){
 pruneManualUploads(db);
 const row=db.prepare('SELECT m.*,q.upload_id FROM manual_upload_starts m JOIN upload_queue q ON q.id=m.queue_id WHERE m.user_id=?').get(userId);
 return row?{transferId:row.queue_id,expiresAt:row.expires_at,state:row.upload_id?'uploading':'requested'}:null;
}
export function requireUploadSlot(db,userId,limit,queueId){
 const slot=manualUploadSlot(db,userId);
 if(queueId&&slot?.transferId===queueId)return;
 const count=db.prepare(`SELECT COUNT(*) n FROM upload_sessions u WHERE u.user_id=? AND u.state='uploading' AND u.expires_at>?
 AND NOT EXISTS(SELECT 1 FROM upload_queue q JOIN manual_upload_starts m ON m.queue_id=q.id WHERE q.upload_id=u.id AND m.user_id=u.user_id)`).get(userId,Date.now()).n;
 if(count>=limit)throw httpError(429,'同時送信数の上限です。キューで待機して自動的に再開します。');
}
export function registerManualUploads(app,{db,authenticate,membership,maintenance}){
 const auth={onRequest:async req=>authenticate(req)};
 app.get('/api/v1/transfers/manual-upload',auth,async req=>({slot:manualUploadSlot(db,req.user.id)}));
 app.post('/api/v1/transfers/upload-queue/:id/start',{...auth,schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}}}},async(req,reply)=>{
  if(maintenance.locked)throw httpError(409,'保守処理中です。');
  const slot=transaction(db,()=>{
   const row=db.prepare('SELECT * FROM upload_queue WHERE id=? AND user_id=?').get(req.params.id,req.user.id);
   if(!row)throw httpError(404,'送信待ちのアセットが見つかりません。');
   membership(row.shelf_id,req.user.id,['owner','editor']);
   if(row.upload_id||row.expires_at<=Date.now())throw httpError(409,'送信待ちの項目を選んでください。');
   const active=manualUploadSlot(db,req.user.id);
   if(active&&active.transferId!==row.id)throw httpError(409,'手動開始の追加枠は使用中です。1アカウントにつき同時に1件までです。');
   if(!active)db.prepare('INSERT INTO manual_upload_starts(user_id,queue_id,requested_at,expires_at) VALUES(?,?,?,?)').run(req.user.id,row.id,Date.now(),Date.now()+90000);
   return manualUploadSlot(db,req.user.id);
  });
  return reply.code(202).send({slot});
 });
}
