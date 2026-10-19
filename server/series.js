import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { httpError } from './security.js';
import { publicProgress } from './progress.js';

const uuid={type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'};
const revision={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER-10000};
const metadata={title:{type:'string',minLength:1,maxLength:200},description:{type:'string',maxLength:2000}};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const publicSeries=s=>({id:s.id,shelfId:s.shelf_id,title:s.title,description:s.description,revision:s.revision,createdAt:s.created_at,updatedAt:s.updated_at});
export function shelfSeries(db,shelfId){
  return db.prepare(`SELECT s.*,COUNT(si.asset_id) asset_count,
    (SELECT asset_id FROM series_items WHERE series_id=s.id ORDER BY position LIMIT 1) cover_id
    FROM series s LEFT JOIN series_items si ON si.series_id=s.id WHERE s.shelf_id=? GROUP BY s.id ORDER BY s.title,s.id`)
    .all(shelfId).map(s=>({...publicSeries(s),assetCount:s.asset_count,coverId:s.cover_id}));
}
export function shelfSeriesMembership(db,shelfId){
  return new Map(db.prepare(`SELECT si.*,s.title,(SELECT COUNT(*) FROM series_items other WHERE other.series_id=si.series_id AND other.position<=si.position) ordinal FROM series_items si JOIN series s ON s.id=si.series_id WHERE s.shelf_id=?`)
    .all(shelfId).map(s=>[s.asset_id,{id:s.series_id,title:s.title,position:s.ordinal,label:s.label}]));
}
export function registerSeries(app,{db,authenticate,membership,findItem,publicItem}){
  const auth={onRequest:async req=>authenticate(req)};
  const find=(id,userId,roles)=>{
    const row=db.prepare('SELECT * FROM series WHERE id=?').get(id);
    if(!row)throw httpError(404,'シリーズが見つかりません。');
    const role=membership(row.shelf_id,userId,roles);
    return {...row,role};
  };
  const detail=(series,userId)=>({series:{...publicSeries(series),role:series.role},items:db.prepare(`SELECT i.*,si.position,si.label FROM series_items si JOIN items i ON i.id=si.asset_id WHERE si.series_id=? ORDER BY si.position`).all(series.id).map((row,index)=>({
    ...publicItem(row),series:{id:series.id,title:series.title,position:index+1,label:row.label},
    progress:publicProgress(db.prepare('SELECT * FROM asset_progress WHERE user_id=? AND asset_id=?').get(userId,row.id))
  }))});
  app.get('/api/v1/shelves/:id/series',auth,async req=>{
    membership(req.params.id,req.user.id);return {series:shelfSeries(db,req.params.id)};
  });
  app.post('/api/v1/shelves/:id/series',{...auth,bodyLimit:16384,schema:{body:object(metadata,['title'])}},async(req,reply)=>{
    membership(req.params.id,req.user.id,['owner','editor']);
    const title=req.body.title.trim();if(!title)throw httpError(422,'シリーズ名を入力してください。');
    const id=randomUUID(),now=Date.now();
    db.prepare('INSERT INTO series(id,shelf_id,title,description,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,req.params.id,title,req.body.description?.trim()??'',now,now);
    return reply.code(201).send(detail(find(id,req.user.id),req.user.id));
  });
  app.get('/api/v1/series/:id',auth,async req=>detail(find(req.params.id,req.user.id),req.user.id));
  app.get('/api/v1/items/:id/series',auth,async req=>{
    const item=findItem(req.params.id,req.user.id);
    const row=db.prepare('SELECT series_id FROM series_items WHERE asset_id=?').get(item.id);
    if(!row)return {series:null,items:[],currentIndex:-1};
    const result=detail(find(row.series_id,req.user.id),req.user.id);
    return {...result,currentIndex:result.items.findIndex(i=>i.id===item.id)};
  });
  app.put('/api/v1/series/:id',{...auth,bodyLimit:256*1024,schema:{body:object({revision,...metadata,items:{type:'array',maxItems:1000,items:object({assetId:uuid,label:{type:'string',maxLength:80}},['assetId'])}})}},async req=>{
    const series=find(req.params.id,req.user.id,['owner','editor']),input=req.body,title=input.title.trim();
    if(!title)throw httpError(422,'シリーズ名を入力してください。');
    return transaction(db,()=>{
      if(series.revision!==input.revision)throw httpError(409,'シリーズが別の画面で更新されました。最新の内容を読み直してください。');
      const seen=new Set();
      for(const entry of input.items){
        if(seen.has(entry.assetId))throw httpError(422,'同じアセットは1回だけ登録できます。');seen.add(entry.assetId);
        const item=db.prepare('SELECT shelf_id FROM items WHERE id=?').get(entry.assetId);
        if(!item || item.shelf_id!==series.shelf_id)throw httpError(422,'この本棚のアセットだけを追加できます。');
        const previous=db.prepare('SELECT series_id FROM series_items WHERE asset_id=?').get(entry.assetId);
        if(previous && previous.series_id!==series.id)throw httpError(409,'別のシリーズに所属しています。先にそのシリーズから外してください。');
      }
      db.prepare('DELETE FROM series_items WHERE series_id=?').run(series.id);
      const insert=db.prepare('INSERT INTO series_items(series_id,asset_id,position,label) VALUES(?,?,?,?)');
      input.items.forEach((entry,index)=>insert.run(series.id,entry.assetId,index+1,entry.label?.trim()??''));
      db.prepare('UPDATE series SET title=?,description=?,revision=?,updated_at=? WHERE id=?').run(title,input.description.trim(),input.revision+1,Date.now(),series.id);
      return detail(find(series.id,req.user.id),req.user.id);
    });
  });
  app.delete('/api/v1/series/:id',{...auth,bodyLimit:1024,schema:{body:object({revision})}},async(req,reply)=>{
    const series=find(req.params.id,req.user.id,['owner','editor']);
    transaction(db,()=>{
      if(series.revision!==req.body.revision)throw httpError(409,'シリーズが別の画面で更新されました。最新の内容を読み直してください。');
      db.prepare('DELETE FROM series WHERE id=?').run(series.id);
    });
    return reply.code(204).send();
  });
}
