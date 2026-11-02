import {thumbnailWebp} from './thumbnail-webp.js';
import {rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export const PREVIEW_SPEC_VERSION=2;
export function videoThumbnailState(db,id){return db.prepare('SELECT * FROM video_thumbnail_state WHERE asset_id=?').get(id);}
export function recordVideoThumbnail(db,id,position){
  position=Number.isFinite(position)&&position>=0?position:0;
  db.prepare('INSERT INTO video_thumbnail_state(asset_id,position_seconds,updated_at) VALUES(?,?,?) ON CONFLICT(asset_id) DO UPDATE SET position_seconds=excluded.position_seconds,preview_version=0,updated_at=MAX(updated_at+1,excluded.updated_at)').run(id,position,Date.now());
  return position;
}
export function recordVideoPreview(db,id,position){
  return db.prepare('UPDATE video_thumbnail_state SET preview_position_seconds=?,preview_version=? WHERE asset_id=? AND position_seconds=?').run(position,PREVIEW_SPEC_VERSION,id,position).changes>0;
}
const pending=new WeakMap();
export async function ensureVideoThumbnailAnchor({db,item,media,uploadDir,thumbnailDir,authorize=()=>{}}){
  const saved=videoThumbnailState(db,item.id);if(saved)return saved.position_seconds;
  let jobs=pending.get(db);if(!jobs)pending.set(db,jobs=new Map());
  if(!jobs.has(item.id)){
    const work=(async()=>{const temp=join(thumbnailDir,item.id+'.'+randomUUID()+'.part.jpg');try{
      authorize();const result=await media.thumbnail(join(uploadDir,item.id),item.mime_type,temp);authorize();
      if(!db.prepare('SELECT 1 FROM items WHERE id=?').get(item.id))throw Error('Asset no longer exists');
      await rename(temp,join(thumbnailDir,item.id+'.jpg'));await thumbnailWebp(join(thumbnailDir,item.id+'.jpg'),{force:true});return recordVideoThumbnail(db,item.id,result.seekSeconds);
    }finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}})();
    jobs.set(item.id,work);work.finally(()=>jobs.delete(item.id)).catch(()=>{});
  }
  return jobs.get(item.id);
}
