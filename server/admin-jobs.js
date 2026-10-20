import {randomUUID} from 'node:crypto';
import {mkdir,rename,stat,unlink,open} from 'node:fs/promises';
import {join} from 'node:path';
import {httpError} from './security.js';
import {transaction} from './database.js';
import {IMAGE_BOOK_MIME,imageExtension,removeItemDirectory} from './media.js';
import {EPUB_MIME} from './ebook-types.js';
import {videoMetadata} from './video-stream.js';
import {adminBody} from './admin.js';

export async function registerAdminJobs(app,context) {
  const {db,adminAccess:a,media,videoTranscoder,uploadDir,booksDir,thumbnailDir,previewDir,videoDir,originalDir,dataDir,uploads,maintenance}=context;
  const root=join(dataDir,'admin-work');await mkdir(root,{recursive:true,mode:0o700});
  let tail=Promise.resolve(),closing=false;const pending=new Map();
  const get=id=>db.prepare('SELECT * FROM admin_jobs WHERE id=?').get(id);
  const safe=row=>({id:row.id,kind:row.kind,assetId:row.asset_id,state:row.state,progress:JSON.parse(row.progress_json),error:row.error,createdAt:row.created_at,updatedAt:row.updated_at});
  const report=(id,value)=>db.prepare('UPDATE admin_jobs SET progress_json=?,updated_at=? WHERE id=?').run(JSON.stringify(value),Date.now(),id);
  function schedule(id){
    if(pending.has(id)||closing)return;
    const job=tail.then(async()=>{
      const row=get(id);if(!row||row.state!=='queued')return;
      const item=db.prepare('SELECT * FROM items WHERE id=?').get(row.asset_id);
      const authorize=()=>{if(!db.prepare('SELECT 1 FROM items WHERE id=?').get(row.asset_id)||!a.isAdmin(row.requested_by))throw httpError(403,'アセットが削除されたか、実行者の管理権限が解除されました。');};
      db.prepare("UPDATE admin_jobs SET state='running',updated_at=? WHERE id=?").run(Date.now(),id);
      const work=join(root,id);
      const generationReferenced=()=>Boolean(row.asset_id&&(videoMetadata(db,row.asset_id)?.generation===id||db.prepare('SELECT 1 FROM video_generations WHERE item_id=? AND generation=?').get(row.asset_id,id)));
      let published=row.kind==='transcode'&&generationReferenced();
      try{
        authorize();await removeItemDirectory(root,id);await mkdir(work,{mode:0o700});
        report(id,{stage:row.kind,percent:0});
        if(row.kind==='transcode'){
          // The DB promotion can commit just before a crash prevents marking
          // this job complete. Never delete/re-encode its now-live generation.
          if(published){
            const committed=videoMetadata(db,item.id,id);
            if(!committed)throw new Error('Committed generation metadata is missing');
            for(const rendition of committed.renditions){
              if((await stat(join(videoDir,item.id,id,rendition.quality+'.mp4'))).size!==rendition.size)throw new Error('Committed generation size mismatch');
              for(const name of rendition.files)if(!(await stat(join(videoDir,item.id,id,name))).size)throw new Error('Committed generation file missing');
            }
            db.prepare("UPDATE admin_jobs SET state='complete',error=NULL,progress_json=?,updated_at=? WHERE id=?").run(JSON.stringify({stage:'complete',percent:100,recovered:true}),Date.now(),id);return;
          }
          // A crash before the DB promotion may have left an orphan directory.
          await removeItemDirectory(join(videoDir,item.id),id);
          let source=join(uploadDir,item.id),sourceKind='canonical';
          if((await stat(join(originalDir,item.id)).catch(()=>null))?.isFile()){source=join(originalDir,item.id);sourceKind='original';}
          const metadata=await videoTranscoder.convert(source,join(work,'video'),{authorize,report:value=>report(id,{...value,source:sourceKind})});
          for(const name of metadata.renditions.flatMap(r=>[r.quality+'.mp4',...r.files])){
            const h=await open(join(work,'video',name),'r+');try{await h.sync();}finally{await h.close();}
          }
          authorize();await mkdir(join(videoDir,item.id),{recursive:true,mode:0o700});
          await rename(join(work,'video'),join(videoDir,item.id,id));
          authorize();
          transaction(db,()=>{
            const previous=videoMetadata(db,item.id);
            if(previous)db.prepare('INSERT OR IGNORE INTO video_generations VALUES(?,?,?,?)').run(item.id,previous.generation??'base',JSON.stringify(previous),Date.now());
            db.prepare("INSERT OR IGNORE INTO playback_generations SELECT token_hash,? FROM playback_tickets WHERE item_id=?").run(previous?.generation??'base',item.id);
            metadata.generation=id;
            db.prepare('INSERT INTO video_assets VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET metadata_json=excluded.metadata_json').run(item.id,JSON.stringify(metadata),sourceKind==='original'?1:0);
            db.prepare('INSERT INTO video_generations VALUES(?,?,?,?)').run(item.id,id,JSON.stringify(metadata),Date.now());
          });published=true;
        }else{
          const first=item.mime_type===IMAGE_BOOK_MIME?db.prepare('SELECT mime_type FROM image_pages WHERE item_id=? AND page_number=1').get(item.id):null;
          const source=first?join(booksDir,item.id,'1.'+imageExtension(first.mime_type)):join(uploadDir,item.id);
          const temporary=join(work,row.kind==='preview'?'preview.mp4':'thumbnail.jpg');
          if(row.kind==='preview')await media.preview(source,temporary,item.mime_type);
          else await media.thumbnail(source,item.mime_type,temporary,item.mime_type===EPUB_MIME?join(work,'book.json'):undefined);
          if(!(await stat(temporary)).size)throw new Error('Empty generated media');
          if(row.kind==='thumbnail')await media.validateImage(temporary);
          authorize();await rename(temporary,join(row.kind==='preview'?previewDir:thumbnailDir,item.id+(row.kind==='preview'?'.mp4':'.jpg')));
          if(row.kind==='thumbnail')db.prepare('UPDATE items SET thumbnail_ready=1 WHERE id=?').run(item.id);
        }
        db.prepare("UPDATE admin_jobs SET state='complete',progress_json=?,error=NULL,updated_at=? WHERE id=?").run(JSON.stringify({stage:'complete',percent:100}),Date.now(),id);
      }catch(error){
        if(error.code==='SERVER_CLOSING'){db.prepare("UPDATE admin_jobs SET state='queued',updated_at=? WHERE id=?").run(Date.now(),id);return;}
        db.prepare("UPDATE admin_jobs SET state='failed',error=?,updated_at=? WHERE id=?").run(error.statusCode?error.message:'再生成に失敗しました。既存データは保持されています。容量やメディア設定を確認してください。',Date.now(),id);
        app.log.error({err:error,jobId:id},'Admin media generation failed');
      }finally{
        await removeItemDirectory(root,id);
        if(row.kind==='transcode'&&!published&&row.asset_id&&!generationReferenced())await removeItemDirectory(join(videoDir,row.asset_id),id);
      }
    }).catch(error=>app.log.error({err:error},'Admin job cleanup failed'));
    tail=job;pending.set(id,job);job.finally(()=>pending.delete(id));
  }
  db.prepare("UPDATE admin_jobs SET state='queued' WHERE state='running' AND kind IN ('thumbnail','preview','transcode')").run();
  for(const row of db.prepare("SELECT id FROM admin_jobs WHERE state='queued' AND kind IN ('thumbnail','preview','transcode')").all())schedule(row.id);
  app.addHook('onClose',async()=>{closing=true;await tail;});
  const auth={onRequest:async req=>a.requireAdmin(req)};
  app.get('/api/v1/admin/jobs',auth,async()=>({
    jobs:db.prepare("SELECT * FROM admin_jobs ORDER BY created_at DESC LIMIT 100").all().map(safe),
    uploads:db.prepare('SELECT id,title,state,error,processing_json,created_at FROM upload_sessions ORDER BY created_at DESC LIMIT 100').all().map(row=>({id:row.id,title:row.title,state:row.state,error:row.error,processing:JSON.parse(row.processing_json),createdAt:row.created_at})),
    previews:context.videoPreviews.inspect(),thumbnails:context.ensureThumbnail.inspect(),processors:media.inspect?.()??[]
  }));
  app.get('/api/v1/admin/assets',{...auth,schema:{querystring:{type:'object',additionalProperties:false,properties:{q:{type:'string',maxLength:100},after:{type:'string',maxLength:36}}}}},async req=>({assets:db.prepare('SELECT i.id,i.title,i.mime_type AS mimeType,s.name AS shelf FROM items i JOIN shelves s ON s.id=i.shelf_id WHERE i.id>? AND instr(lower(i.title),lower(?))>0 ORDER BY i.id LIMIT 100').all(req.query.after??'',req.query.q??'')}));
  app.post('/api/v1/admin/assets/:id/regenerate',{...auth,schema:{body:adminBody({kind:{enum:['thumbnail','preview','transcode']}})}},async(req,reply)=>{
    await a.reauthenticate(req);if(maintenance.locked)throw httpError(409,'保守処理中です。');
    const item=db.prepare('SELECT * FROM items WHERE id=?').get(req.params.id);if(!item)throw httpError(404,'アセットが見つかりません。');
    if(req.body.kind!=='thumbnail'&&!item.mime_type.startsWith('video/'))throw httpError(400,'プレビュー・配信画質の再生成は動画のみです。');
    if(db.prepare("SELECT 1 FROM admin_jobs WHERE asset_id=? AND state IN ('queued','running')").get(item.id))throw httpError(409,'このアセットは処理中です。');
    if(pending.size>=20)throw httpError(429,'再生成キューが混雑しています。');
    const id=randomUUID(),now=Date.now();db.prepare("INSERT INTO admin_jobs(id,kind,asset_id,state,requested_by,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?)").run(id,req.body.kind,item.id,req.user.id,now,now);a.audit(req,'media.regenerate',item.id,{jobId:id,kind:req.body.kind});schedule(id);
    return reply.code(202).send({job:safe(get(id))});
  });
  app.post('/api/v1/admin/uploads/:id/retry',{...auth,schema:{body:adminBody()}},async(req,reply)=>{await a.reauthenticate(req);await uploads.adminRetry(req.params.id,req.user.id,req.session.id);a.audit(req,'upload.retry',req.params.id);return reply.code(202).send({accepted:true});});
  return {get busy(){return pending.size>0;}};
}
