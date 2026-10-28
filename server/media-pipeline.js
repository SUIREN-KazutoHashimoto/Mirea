import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,stat,rename,unlink,link,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {transaction} from './database.js';
import {assertUploadName} from './name-integrity.js';
import {attachUploadSeries} from './upload-series.js';
import {moveStorage} from './storage-move.js';
import {removeItemDirectory} from './media.js';
import {probeVideo} from './video-transcode.js';
import {probeAudio,audioThumbnail} from './audio-transcode.js';
import {thumbnailWebp} from './thumbnail-webp.js';
import {recordVideoThumbnail,recordVideoPreview} from './video-thumbnail.js';
import {customThumbnail,ensureCustomThumbnail} from './custom-thumbnails.js';
import {httpError,matchesFileType} from './security.js';

export function mediaContentSource(db,item,{uploadDir,originalDir},{raw=false}={}){
  const source=db.prepare('SELECT * FROM media_ingest WHERE asset_id=?').get(item.id);
  return source&&(raw||!source.canonical_ready)?{path:join(originalDir,item.id),mimeType:source.source_mime,size:source.source_size,filename:source.source_filename,original:true}:
    {path:join(uploadDir,item.id),mimeType:item.mime_type,size:item.size,filename:item.filename,original:false};
}

// A published immutable source and durable tasks are independent of transfer
// parts. Each asset has ordered dependencies; different lanes run concurrently.
export async function createMediaPipeline(app,context){
 const {db,media,videoTranscoder,audioTranscoder,jobPool,originalDir,uploadDir,thumbnailDir,previewDir,videoDir,stagingDir,adminAccess}=context;
 const active=new Map(),counts=new Map();let closing=false,pumping=false;
 const ingest=id=>db.prepare('SELECT * FROM media_ingest WHERE asset_id=?').get(id);
 const task=id=>db.prepare('SELECT * FROM media_tasks WHERE id=?').get(id);
 const item=id=>db.prepare('SELECT * FROM items WHERE id=?').get(id);
 const report=(row,value)=>db.prepare('UPDATE media_tasks SET progress_json=?,updated_at=? WHERE id=?').run(JSON.stringify(value),Date.now(),row.id);
 const authorize=id=>{const asset=item(id);if(!asset)throw httpError(404,'アセットは削除されています。');if(asset.uploaded_by&&(!adminAccess.enabled(asset.uploaded_by)||!db.prepare("SELECT 1 FROM memberships WHERE shelf_id=? AND user_id=? AND role IN ('owner','editor')").get(asset.shelf_id,asset.uploaded_by)))throw httpError(403,'アップロード者の権限が変更されました。');return asset;};
 async function syncFile(path){const handle=await open(path,'r+');try{await handle.sync();}finally{await handle.close();}}
 async function syncDirectory(path){if(process.platform==='win32')return;const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
 async function canonical(source,id,jobId){
  const temporary=join(uploadDir,id+'.'+jobId+'.canonical');await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});
  try{try{await link(source,temporary);}catch(error){if(!['EXDEV','EPERM','ENOTSUP','EACCES'].includes(error.code))throw error;await copyFile(source,temporary,constants.COPYFILE_EXCL);}await syncFile(temporary);authorize(id);await rename(temporary,join(uploadDir,id));await syncDirectory(uploadDir);}
  finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 async function finish(id){
  const rows=db.prepare('SELECT state FROM media_tasks WHERE asset_id=?').all(id);if(!rows.length)return;
  const failed=rows.some(r=>r.state==='failed'),pending=rows.some(r=>r.state==='queued'||r.state==='running');
  if(!pending){if(!rows.some(r=>r.state==='cancelled'))await removeItemDirectory(stagingDir,id);await reapSources();db.prepare("UPDATE upload_sessions SET state=?,error=?,processing_json=? WHERE id=? AND state!='cancelled'").run(failed?'failed':'complete',failed?'一部の後処理に失敗しました。原本と公開済みアセットは保持されています。':null,JSON.stringify({stage:failed?'failed':'complete',percent:100}),id);}
 }
 async function reapSources(){
  for(const row of db.prepare(`SELECT * FROM media_ingest m WHERE retain_original=0 AND canonical_ready=1 AND source_removed=0
   AND NOT EXISTS(SELECT 1 FROM media_tasks t WHERE t.asset_id=m.asset_id AND t.state!='complete')
   AND NOT EXISTS(SELECT 1 FROM playback_tickets p JOIN playback_generations g ON g.token_hash=p.token_hash WHERE p.item_id=m.asset_id AND g.generation='source' AND p.expires_at>?)`).all(Date.now())){
   await unlink(join(originalDir,row.asset_id)).catch(error=>{if(error.code!=='ENOENT')throw error;});db.prepare('UPDATE media_ingest SET source_removed=1 WHERE asset_id=?').run(row.asset_id);
  }
 }
 async function execute(row){
  const source=ingest(row.asset_id);if(!source)return;const asset=authorize(row.asset_id),raw=join(originalDir,asset.id),work=join(stagingDir,asset.id,row.id);
  const check=()=>{if(task(row.id)?.state!=='running')throw httpError(409,'ジョブはキャンセルされています。');return authorize(asset.id);};await mkdir(work,{recursive:true,mode:0o700});
  try{
   if(row.kind==='thumbnail'){
    if(customThumbnail(db,thumbnailDir,asset.id)){
     await ensureCustomThumbnail(db,thumbnailDir,media,asset.id,{force:true,authorize:check});
     if(source.source_mime.startsWith('video/')&&!db.prepare('SELECT 1 FROM video_thumbnail_state WHERE asset_id=?').get(asset.id)){const duration=JSON.parse(source.metadata_json).duration;recordVideoThumbnail(db,asset.id,duration<1?0:duration*(.4+Math.random()*.2));}
    }
    else{
     const path=join(work,'thumbnail.jpg'),chosen=source.source_mime.startsWith('audio/')?await audioThumbnail(raw,path):await media.thumbnail(raw,source.source_mime,path);
     await media.validateImage(path);check();
     if(customThumbnail(db,thumbnailDir,asset.id))await ensureCustomThumbnail(db,thumbnailDir,media,asset.id,{authorize:check});
     else{await moveStorage(path,join(thumbnailDir,asset.id+'.jpg'),{authorize:check});await thumbnailWebp(join(thumbnailDir,asset.id+'.jpg'),{force:true});}
     db.prepare('UPDATE items SET thumbnail_ready=1 WHERE id=?').run(asset.id);if(source.source_mime.startsWith('video/'))recordVideoThumbnail(db,asset.id,chosen?.seekSeconds??0);
    }
   }else if(row.kind==='transcode'){
    if(source.canonical_ready){if(!(await stat(join(uploadDir,asset.id))).size)throw Error('Committed canonical file missing');return;}
    const video=source.source_mime.startsWith('video/');
    const metadata=await(video?videoTranscoder:audioTranscoder).convert(raw,work,{authorize:check,report:value=>report(row,value),thumbnail:false});check();
    let path;
    if(video){for(const name of metadata.renditions.flatMap(r=>[r.quality+'.mp4',...r.files]))await syncFile(join(work,name));await syncDirectory(work);await mkdir(join(videoDir,asset.id),{recursive:true,mode:0o700});const final=join(videoDir,asset.id,row.id);await removeItemDirectory(join(videoDir,asset.id),row.id);await moveStorage(work,final,{authorize:check});metadata.generation=row.id;metadata.originalFilename=source.source_filename;path=join(final,metadata.renditions[0].quality+'.mp4');}
    else{metadata.originalFilename=source.source_filename;path=join(work,'audio.m4a');}
    await canonical(path,asset.id,row.id);check();
    transaction(db,()=>{
     if(video){db.prepare('INSERT INTO video_assets VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET metadata_json=excluded.metadata_json,original_retained=excluded.original_retained').run(asset.id,JSON.stringify(metadata),source.retain_original);db.prepare('INSERT OR REPLACE INTO video_generations VALUES(?,?,?,?)').run(asset.id,row.id,JSON.stringify(metadata),Date.now());}
     else db.prepare('INSERT INTO audio_assets VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET metadata_json=excluded.metadata_json,original_retained=excluded.original_retained').run(asset.id,JSON.stringify(metadata),source.retain_original);
     db.prepare('UPDATE items SET mime_type=?,filename=?,size=? WHERE id=?').run(video?'video/mp4':'audio/mp4',source.source_filename.replace(/\.[^.]+$/,'')+(video?'.mp4':'.m4a'),video?metadata.renditions[0].size:metadata.size,asset.id);
     db.prepare('UPDATE media_ingest SET canonical_ready=1 WHERE asset_id=?').run(asset.id);
    });
   }else{
    const anchor=db.prepare('SELECT position_seconds FROM video_thumbnail_state WHERE asset_id=?').get(asset.id)?.position_seconds??0,path=join(work,'preview.mp4');
    await media.preview(join(uploadDir,asset.id),path,'video/mp4',{startSeconds:anchor});if(!(await stat(path)).size)throw Error('Empty generated preview');const preview=await probeVideo(path);if(preview.video.codec_name!=='h264'||preview.audio||preview.duration>10.5)throw Error('Invalid generated preview');check();
    await moveStorage(path,join(previewDir,asset.id+'.mp4'),{authorize:check});recordVideoPreview(db,asset.id,anchor);
   }
  }finally{await removeItemDirectory(join(stagingDir,asset.id),row.id);}
 }
 function pump(){
  if(closing||pumping)return;pumping=true;
  try{
   const rows=db.prepare("SELECT * FROM media_tasks WHERE state='queued' ORDER BY CASE kind WHEN 'thumbnail' THEN 0 WHEN 'transcode' THEN 1 ELSE 2 END,created_at,id").all();
   for(const row of rows){
    if(active.has(row.id)||(counts.get(row.kind)??0)>=16)continue;
    const dependency=row.kind==='transcode'?'thumbnail':row.kind==='preview'?'transcode':null;
    if(dependency){const previous=db.prepare('SELECT state FROM media_tasks WHERE asset_id=? AND kind=?').get(row.asset_id,dependency);if(!previous||['queued','running'].includes(previous.state))continue;if(row.kind==='preview'&&previous.state!=='complete'){db.prepare("UPDATE media_tasks SET state='failed',error=?,updated_at=? WHERE id=?").run('先に動画のトランスコードを再実行してください。',Date.now(),row.id);finish(row.asset_id).catch(error=>app.log.error({err:error},'Media task finalization failed'));continue;}}
    counts.set(row.kind,(counts.get(row.kind)??0)+1);const promise=jobPool.run(async()=>{
     if(closing)return;const current=task(row.id);if(!current||current.state!=='queued')return;
     db.prepare("UPDATE media_tasks SET state='running',updated_at=? WHERE id=?").run(Date.now(),row.id);
     try{await execute(row);if(task(row.id)?.state==='running')db.prepare("UPDATE media_tasks SET state='complete',error=NULL,progress_json=?,updated_at=? WHERE id=?").run(JSON.stringify({stage:'complete',percent:100}),Date.now(),row.id);}
     catch(error){if(task(row.id)?.state==='running')db.prepare('UPDATE media_tasks SET state=?,error=?,updated_at=? WHERE id=?').run(closing||error.code==='SERVER_CLOSING'?'queued':'failed',closing||error.code==='SERVER_CLOSING'?null:'後処理を完了できませんでした。原本は保持されています。',Date.now(),row.id);if(!closing&&error.code!=='SERVER_CLOSING')app.log.error({err:error,jobId:row.id},'Media pipeline failed');}
     finally{await finish(row.asset_id);}
    },row.id,row.kind).finally(()=>{active.delete(row.id);counts.set(row.kind,counts.get(row.kind)-1);pump();});active.set(row.id,promise);
   }
  }finally{pumping=false;}
 }
 db.prepare("UPDATE media_tasks SET state='queued' WHERE state='running'").run();pump();
 const timer=setInterval(()=>reapSources().catch(error=>app.log.error({err:error},'Original retention cleanup failed')),60000);timer.unref();
 app.addHook('onClose',async()=>{closing=true;clearInterval(timer);for(const row of db.prepare("SELECT id FROM media_tasks WHERE state IN ('queued','running')").all())jobPool.cancel(row.id);await Promise.allSettled([...active.values()]);db.prepare("UPDATE media_tasks SET state='queued' WHERE state='running'").run();});
 return {
  has:id=>Boolean(ingest(id)),pump,get busy(){return active.size>0;},
  async accept(upload,authorizeUpload){
   if(ingest(upload.id)){pump();return item(upload.id);}
   const first=JSON.parse(upload.files_json)[0],raw=join(stagingDir,upload.id,'raw-1'),video=first.mime.startsWith('video/');
   const handle=await open(raw,'r');try{const magic=Buffer.alloc(16);const {bytesRead}=await handle.read(magic,0,16,0);if(!matchesFileType(first.mime,magic.subarray(0,bytesRead)))throw httpError(422,'ファイル形式と内容が一致しません。');}finally{await handle.close();}
   const info=await(video?probeVideo:probeAudio)(raw);authorizeUpload();await syncFile(raw);
   if(item(upload.id))throw httpError(409,'アセットの状態が変更されました。');
   await unlink(join(originalDir,upload.id)).catch(error=>{if(error.code!=='ENOENT')throw error;});
   await moveStorage(raw,join(originalDir,upload.id),{authorize:authorizeUpload});await syncDirectory(originalDir);authorizeUpload();
   try{transaction(db,()=>{
    assertUploadName(db,upload);db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count,thumbnail_ready) VALUES(?,?,?,?,?,?,?,?,1,0)').run(upload.id,upload.shelf_id,upload.title,first.filename,video?'video/mp4':'audio/mp4',first.size,upload.user_id,upload.created_at);
    db.prepare('INSERT INTO media_ingest(asset_id,source_mime,source_filename,source_size,retain_original,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)').run(upload.id,first.mime,first.filename,first.size,upload.retain_original,JSON.stringify({duration:info.duration,width:info.width,height:info.height,videoCodec:info.video?.codec_name,audioCodec:info.audio?.codec_name}),Date.now());
    attachUploadSeries(db,upload);for(const kind of ['thumbnail','transcode',...(video?['preview']:[])])db.prepare("INSERT INTO media_tasks(id,asset_id,kind,state,created_at,updated_at) VALUES(?,?,?,'queued',?,?)").run(randomUUID(),upload.id,kind,Date.now(),Date.now());
   });}catch(error){await unlink(join(originalDir,upload.id)).catch(()=>{});throw error;}
   pump();return item(upload.id);
  },
  async ensureThumbnail(asset){if(customThumbnail(db,thumbnailDir,asset.id))return ensureCustomThumbnail(db,thumbnailDir,media,asset.id);pump();const row=db.prepare("SELECT * FROM media_tasks WHERE asset_id=? AND kind='thumbnail'").get(asset.id);if(row&&active.has(row.id))await active.get(row.id);if(customThumbnail(db,thumbnailDir,asset.id))return ensureCustomThumbnail(db,thumbnailDir,media,asset.id);const result=row?task(row.id):null;if(result?.state==='failed')throw httpError(422,'サムネイル生成に失敗しました。管理画面から再生成できます。');return join(thumbnailDir,asset.id+'.jpg');},
  retry(id){if(!ingest(id))return false;db.prepare("UPDATE media_tasks SET state='queued',error=NULL,progress_json='{}' WHERE asset_id=? AND state IN ('failed','cancelled')").run(id);db.prepare("UPDATE upload_sessions SET state='processing',error=NULL WHERE id=?").run(id);pump();return true;},
  async cancel(id){db.prepare("UPDATE media_tasks SET state='cancelled' WHERE asset_id=? AND state IN ('queued','running')").run(id);for(const row of db.prepare('SELECT id FROM media_tasks WHERE asset_id=?').all(id))jobPool.cancel(row.id);await Promise.allSettled(db.prepare('SELECT id FROM media_tasks WHERE asset_id=?').all(id).map(row=>active.get(row.id)).filter(Boolean));},
  reapSources,
 };
}
