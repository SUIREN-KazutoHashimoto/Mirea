import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {transaction} from './database.js';
import {httpError} from './security.js';

const uuid={type:'string',pattern:'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'};
const properties={assetIds:{type:'array',items:uuid,minItems:1,maxItems:1000,uniqueItems:true},seriesId:uuid};
export function customThumbnail(db,thumbnailDir,id){
  const row=db.prepare('SELECT image_id FROM thumbnail_overrides WHERE asset_id=?').get(id);
  return row?join(thumbnailDir,'custom',row.image_id+'.jpg'):null;
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
    if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw httpError(400,'画像データが不正です。');
    const bytes=Buffer.from(base64,'base64');if(!bytes.length||bytes.length>5*1024*1024)throw httpError(413,'画像は5MB以下にしてください。');
    const id=randomUUID(),source=join(directory,id+'.input'),temp=join(directory,id+'.part.jpg'),final=join(directory,id+'.jpg');let committed=false;
    try{
      await mkdir(directory,{recursive:true,mode:0o700});await writeFile(source,bytes,{flag:'wx',mode:0o600});await media.validateImage(source);await media.thumbnail(source,req.body.image.mime,temp);await rename(temp,final);
      const result=change(req,id);committed=true;await collect(result.old);return {updated:result.ids.length};
    }finally{await Promise.allSettled([unlink(temp),...(!committed?[unlink(source),unlink(final)]:[])]);}
  });
  app.delete('/api/v1/thumbnails/custom',{...auth,schema:schema(false)},async req=>{
    const result=change(req,null);await collect(result.old);return {updated:result.ids.length};
  });
}
