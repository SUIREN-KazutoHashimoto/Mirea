import { copyFile, open, rename, stat, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { transaction } from './database.js';
import {attachUploadSeries} from './upload-series.js';

// Publication commit is the sole boundary permitting removal of verified source
// chunks. Failed/cancelled/restarted jobs follow the same durable queue as video.
export async function publishAudio(context,upload,authorize) {
  const {db,audioTranscoder,media,uploadDir,stagingDir,thumbnailDir,originalDir,publicItem}=context;
  const {id,shelf_id:shelfId,user_id:userId,title}=upload,first=JSON.parse(upload.files_json)[0];
  if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Invalid audio job ID');
  const stage=join(stagingDir,id),work=join(stage,'audio'),canonical=join(uploadDir,id);
  const thumbnail=join(thumbnailDir,`${id}.jpg`),original=join(originalDir,id);
  try{
    await rm(work,{recursive:true,force:true});
    const metadata=await audioTranscoder.convert(join(stage,'raw-1'),work,{authorize,report:value=>
      db.prepare('UPDATE upload_sessions SET processing_json=? WHERE id=?').run(JSON.stringify(value),id)});
    await media.validateImage(join(work,'thumbnail.jpg'));
    authorize();
    await Promise.all([canonical,thumbnail,original].map(path=>unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;})));
    await rename(join(work,'audio.m4a'),canonical);
    await rename(join(work,'thumbnail.jpg'),thumbnail);
    if(upload.retain_original)await copyFile(join(stage,'raw-1'),original);
    if((await stat(canonical)).size!==metadata.size || upload.retain_original && (await stat(original)).size!==first.size)throw new Error('Published audio size mismatch');
    for(const path of [canonical,thumbnail,...(upload.retain_original?[original]:[])]){
      const handle=await open(path,'r+');try{await handle.sync();}finally{await handle.close();}
    }
    if(process.platform!=='win32')for(const path of [uploadDir,thumbnailDir,originalDir]){
      const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}
    }
    authorize();metadata.originalFilename=first.filename;
    transaction(db,()=>{
      db.prepare(`INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count,thumbnail_ready)
        VALUES(?,?,?,?,'audio/mp4',?,?,?,1,1)`).run(id,shelfId,title,first.filename.replace(/\.[^.]+$/,'')+'.m4a',metadata.size,userId,Date.now());
      db.prepare('INSERT INTO audio_assets VALUES(?,?,?)').run(id,JSON.stringify(metadata),upload.retain_original?1:0);
      attachUploadSeries(db,upload);
      db.prepare("UPDATE upload_sessions SET state='complete',error=NULL,processing_json=? WHERE id=?").run(JSON.stringify({stage:'complete',percent:100}),id);
    });
    return publicItem(db.prepare('SELECT * FROM items WHERE id=?').get(id));
  }catch(error){
    if(!db.prepare('SELECT 1 FROM items WHERE id=?').get(id))await Promise.allSettled([canonical,thumbnail,original].map(path=>unlink(path)));
    throw error;
  }
}
