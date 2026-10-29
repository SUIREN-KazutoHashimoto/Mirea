import {randomUUID,createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {thumbnailWebp} from './thumbnail-webp.js';
import {mkdir,writeFile,rename,unlink,lstat,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {transaction} from './database.js';
import {httpError} from './security.js';

const uuid={type:'string',pattern:'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'};
const properties={assetIds:{type:'array',items:uuid,minItems:1,maxItems:1000,uniqueItems:true},seriesId:uuid};
// A repeated-group base64 regex exhausts V8's regexp stack on valid multi-MiB
// covers. Scan once with constant stack space, preserving strict alphabet and
// padding rules. The request schema and decoded byte limit still bound size.
export function validThumbnailBase64(value){
  if(typeof value!=='string'||!value.length||value.length%4!==0)return false;
  let end=value.length;if(value[end-1]==='=')end--;if(value[end-1]==='=')end--;
  for(let i=0;i<end;i++){
    const c=value.charCodeAt(i);
    if(!(c>=65&&c<=90||c>=97&&c<=122||c>=48&&c<=57||c===43||c===47))return false;
  }
  return true;
}
export function customThumbnail(db,thumbnailDir,id){
  const row=db.prepare('SELECT image_id FROM thumbnail_overrides WHERE asset_id=?').get(id);
  return row?join(thumbnailDir,'custom',row.image_id+'.jpg'):null;
}

const regenerating=new Map();
export function customThumbnailRevision(row){
  const hash=createHash('sha256').update(row.image_id+':'+row.updated_at).digest('hex');
  return [hash.slice(0,8),hash.slice(8,12),hash.slice(12,16),hash.slice(16,20),hash.slice(20,32)].join('-');
}
export async function ensureCustomThumbnail(db,thumbnailDir,media,assetId,{force=false,authorize=()=>{}}={}){
  const row=db.prepare('SELECT image_id,updated_at FROM thumbnail_overrides WHERE asset_id=?').get(assetId);if(!row)return null;
  if(!/^[0-9a-f-]{36}$/.test(row.image_id))throw Error('Invalid custom thumbnail identity');
  const root=join(thumbnailDir,'custom'),base=join(root,row.image_id),jpeg=base+'.jpg',webp=base+'.webp';
  const regular=async path=>{const info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(info&&(!info.isFile()||info.isSymbolicLink()))throw Error('Unsafe thumbnail file');return info;};
  if(!force&&await regular(jpeg)&&await regular(webp))return jpeg;
  if(!regenerating.has(base)){
    const work=(async()=>{
      let source=base+'.input';if(!await regular(source)){
        // Preserve an old derivative separately if its original was already lost.
        source=base+'.legacy-input';if(!await regular(source)){if(!await regular(jpeg))throw httpError(409,'カスタムサムネイルの原本がありません。画像を再アップロードしてください。');await copyFile(jpeg,source,constants.COPYFILE_EXCL);}
      }
      const stamp=randomUUID(),tempJpeg=base+'.'+stamp+'.part.jpg',tempWebp=base+'.'+stamp+'.part.webp';
      try{
        authorize();await media.validateImage(source);await media.thumbnail(source,'image/webp',tempJpeg);
        await thumbnailWebp(source,{destination:tempWebp,force:true});
        authorize();if(!db.prepare('SELECT 1 FROM thumbnail_overrides WHERE asset_id=? AND image_id=?').get(assetId,row.image_id))throw httpError(409,'サムネイル設定が変更されたため、再生成を中止しました。');
        await rename(tempJpeg,jpeg);await rename(tempWebp,webp);
        db.prepare('UPDATE thumbnail_overrides SET updated_at=MAX(updated_at+1,?) WHERE image_id=?').run(Date.now(),row.image_id);
        return jpeg;
      }finally{await Promise.allSettled([unlink(tempJpeg),unlink(tempWebp)]);}
    })();regenerating.set(base,work);work.finally(()=>regenerating.delete(base)).catch(()=>{});
  }
  return regenerating.get(base);
}

// Immutable shared images make a whole-series change atomic. Generated covers
// remain intact; regenerating a thumbnail never overwrites a user's override.
export async function registerCustomThumbnails(app,{db,thumbnailDir,media,authenticate,findItem,membership}){
  const directory=join(thumbnailDir,'custom');
  const schema=image=>({body:{type:'object',additionalProperties:false,properties:{...properties,...(image?{image:{type:'object',additionalProperties:false,required:['mime','base64'],properties:{mime:{enum:['image/jpeg','image/png','image/webp']},base64:{type:'string',minLength:4,maxLength:6990508}}}}:{})},required:image?['image']:[],oneOf:[{required:['assetIds'],not:{required:['seriesId']}},{required:['seriesId'],not:{required:['assetIds']}}]}});
  const auth={preHandler:async req=>authenticate(req),config:{rateLimit:{max:20,timeWindow:'1 minute'}}};
  function targets(req){
    if(req.body.assetIds)return req.body.assetIds.map(id=>findItem(id,req.user.id,['owner','editor']).id);
    const series=db.prepare('SELECT * FROM series WHERE id=?').get(req.body.seriesId);
    if(!series)throw httpError(404,'シリーズが見つかりません。');membership(series.shelf_id,req.user.id,['owner','editor']);
    const ids=db.prepare(`WITH RECURSIVE descendants(id) AS(SELECT ? UNION SELECT s.id FROM series s JOIN descendants d ON s.parent_id=d.id)
      SELECT si.asset_id AS id FROM series_items si JOIN descendants d ON d.id=si.series_id JOIN items i ON i.id=si.asset_id WHERE i.shelf_id=? ORDER BY si.asset_id`).all(series.id,series.shelf_id).map(r=>r.id);
    if(!ids.length)throw httpError(400,'シリーズにアセットがありません。');
    if(ids.length>1000)throw httpError(400,'一度に変更できるのは1000アセットまでです。');
    return ids;
  }
  async function collect(images){
    for(const id of new Set(images))if(!db.prepare('SELECT 1 FROM thumbnail_overrides WHERE image_id=?').get(id))await Promise.all(['.jpg','.webp'].map(ext=>unlink(join(directory,id+ext)).catch(error=>{if(error.code!=='ENOENT')throw error;}))).catch(error=>{if(error.code!=='ENOENT')app.log.error({err:error},'Unused custom cover requires cleanup');});
  }
  function change(req,imageId){
    authenticate(req);return transaction(db,()=>{
      const ids=targets(req),old=ids.flatMap(id=>db.prepare('SELECT image_id FROM thumbnail_overrides WHERE asset_id=?').get(id)?.image_id??[]);
      for(const id of ids)if(imageId)db.prepare('INSERT INTO thumbnail_overrides(asset_id,image_id,updated_at) VALUES(?,?,?) ON CONFLICT(asset_id) DO UPDATE SET image_id=excluded.image_id,updated_at=excluded.updated_at').run(id,imageId,Date.now());
      else db.prepare('DELETE FROM thumbnail_overrides WHERE asset_id=?').run(id);
      return {ids,old};
    });
  }
  app.post('/api/v1/thumbnails/custom',{...auth,bodyLimit:8*1024*1024,schema:schema(true)},async req=>{
    targets(req);
    const {base64}=req.body.image;
    if(!validThumbnailBase64(base64))throw httpError(400,'画像データが不正です。');
    const bytes=Buffer.from(base64,'base64');if(!bytes.length||bytes.length>5*1024*1024)throw httpError(413,'画像は5MB以下にしてください。');
    const id=randomUUID(),source=join(directory,id+'.input'),temp=join(directory,id+'.part.jpg'),final=join(directory,id+'.jpg');let committed=false;
    try{
      await mkdir(directory,{recursive:true,mode:0o700});await writeFile(source,bytes,{flag:'wx',mode:0o600});await media.validateImage(source);await media.thumbnail(source,req.body.image.mime,temp);await rename(temp,final);await thumbnailWebp(source,{destination:join(directory,id+'.webp'),force:true});
      const result=change(req,id);committed=true;await collect(result.old);return {updated:result.ids.length};
    }finally{await Promise.allSettled([unlink(temp),...(!committed?[unlink(source),unlink(final),unlink(join(directory,id+'.webp'))]:[])]);}
  });
  app.delete('/api/v1/thumbnails/custom',{...auth,schema:schema(false)},async req=>{
    const result=change(req,null);await collect(result.old);return {updated:result.ids.length};
  });
}
