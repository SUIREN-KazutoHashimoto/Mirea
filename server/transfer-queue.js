import {transaction} from './database.js';
import {httpError} from './security.js';
export function registerTransferQueue(app,{db,authenticate,membership,maxUploadBytes}){
  app.post('/api/v1/transfers/upload-queue',{onRequest:async req=>authenticate(req),bodyLimit:1024*1024,schema:{body:{type:'object',additionalProperties:false,required:['assets'],properties:{assets:{type:'array',minItems:1,maxItems:1000,items:{type:'object',additionalProperties:false,required:['id','shelfId','title','mimeType','totalBytes'],properties:{id:{type:'string',format:'uuid'},shelfId:{type:'string',format:'uuid'},seriesId:{anyOf:[{type:'string',format:'uuid'},{type:'null'}]},title:{type:'string',minLength:1,maxLength:200},mimeType:{type:'string',minLength:1,maxLength:100},totalBytes:{type:'integer',minimum:1,maximum:maxUploadBytes}}}}}}}},async req=>{
    const now=Date.now(),ids=new Set();
    transaction(db,()=>{
      db.prepare('DELETE FROM upload_queue WHERE upload_id IS NULL AND expires_at<=?').run(now);
      const existing=db.prepare('SELECT COUNT(*) n FROM upload_queue WHERE user_id=? AND id IN (SELECT value FROM json_each(?))').get(req.user.id,JSON.stringify(req.body.assets.map(asset=>asset.id))).n;
      if(db.prepare('SELECT COUNT(*) n FROM upload_queue WHERE user_id=? AND upload_id IS NULL').get(req.user.id).n+req.body.assets.length-existing>10000)throw httpError(429,'送信待ちの登録上限です。既存の転送を完了・中止してから追加してください。');
      for(const asset of req.body.assets){
        membership(asset.shelfId,req.user.id,['owner','editor']);const title=asset.title.trim().normalize('NFC');if(!title||ids.has(asset.id))throw httpError(400,'送信待ちのアセットが不正です。');ids.add(asset.id);
        if(asset.seriesId&&!db.prepare('SELECT 1 FROM series WHERE id=? AND shelf_id=?').get(asset.seriesId,asset.shelfId))throw httpError(422,'追加先のシリーズが見つかりません。');
        const old=db.prepare('SELECT * FROM upload_queue WHERE id=?').get(asset.id);
        if(old){if(old.user_id!==req.user.id||old.shelf_id!==asset.shelfId||old.title!==title||old.total_bytes!==asset.totalBytes||old.mime_type!==asset.mimeType||old.series_id!==(asset.seriesId??null))throw httpError(409,'送信待ちの登録内容が変更されています。');continue;}
        db.prepare('INSERT INTO upload_queue VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(asset.id,req.user.id,asset.shelfId,asset.seriesId??null,title,asset.mimeType,asset.totalBytes,now,now+24*3600000);
      }
    });return {accepted:req.body.assets.length};
  });
  app.post('/api/v1/transfers/upload-queue/cancel',{onRequest:async req=>authenticate(req),bodyLimit:64*1024,schema:{body:{type:'object',additionalProperties:false,required:['ids'],properties:{ids:{type:'array',minItems:1,maxItems:1000,uniqueItems:true,items:{type:'string',format:'uuid'}}}}}},async req=>transaction(db,()=>{
    const rows=db.prepare('SELECT id,upload_id FROM upload_queue WHERE user_id=? AND id IN (SELECT value FROM json_each(?))').all(req.user.id,JSON.stringify(req.body.ids));db.prepare('DELETE FROM upload_queue WHERE user_id=? AND upload_id IS NULL AND id IN (SELECT value FROM json_each(?))').run(req.user.id,JSON.stringify(req.body.ids));return {uploads:rows.filter(row=>row.upload_id).map(row=>({clientTransferId:row.id,uploadId:row.upload_id}))};
  }));
  app.delete('/api/v1/transfers/upload-queue/:id',{onRequest:async req=>authenticate(req)},async(req,reply)=>{
    const row=db.prepare('SELECT * FROM upload_queue WHERE id=? AND user_id=?').get(req.params.id,req.user.id);if(!row)throw httpError(404,'送信待ちのアセットが見つかりません。');if(row.upload_id)throw httpError(409,'送信開始済みです。転送の内容を確認して中止してください。');db.prepare('DELETE FROM upload_queue WHERE id=? AND user_id=?').run(row.id,req.user.id);return reply.code(204).send();
  });
  app.get('/api/v1/transfers/upload-queue/:id',{onRequest:async req=>authenticate(req)},async req=>{
    const row=db.prepare('SELECT * FROM upload_queue WHERE id=? AND user_id=?').get(req.params.id,req.user.id);if(!row)throw httpError(404,'送信待ちのアセットが見つかりません。');membership(row.shelf_id,req.user.id,['owner','editor']);return {uploadId:row.upload_id};
  });
}
export function linkQueuedUpload(db,queueId,upload){
  if(!queueId)return;
  const row=db.prepare('SELECT * FROM upload_queue WHERE id=? AND user_id=?').get(queueId,upload.user_id),files=JSON.parse(upload.files_json);
  if(!row||row.shelf_id!==upload.shelf_id||row.series_id!==upload.target_series_id||row.title!==upload.title||row.mime_type!==files[0].mime||row.total_bytes!==files.reduce((n,f)=>n+f.size,0))throw httpError(409,'送信待ちの登録内容と一致しません。ファイルを選び直してください。');
  if(row.upload_id&&row.upload_id!==upload.id){const previous=db.prepare('SELECT state,expires_at FROM upload_sessions WHERE id=?').get(row.upload_id);if(previous&&!['cancelled','failed'].includes(previous.state)&&!(previous.state==='uploading'&&previous.expires_at<=Date.now()))throw httpError(409,'このアセットは送信開始済みです。');}db.prepare('DELETE FROM upload_queue WHERE upload_id=? AND id!=? AND user_id=?').run(upload.id,row.id,upload.user_id);db.prepare('UPDATE upload_queue SET upload_id=? WHERE id=?').run(upload.id,row.id);
}
