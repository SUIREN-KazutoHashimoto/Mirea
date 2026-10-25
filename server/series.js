import {canonicalName} from './name-rules.js';
import {assertAssetChanges,assertSeriesChanges} from './name-integrity.js';
import {registerSeriesActions} from './series-actions.js';
import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { httpError } from './security.js';
import { publicProgress } from './progress.js';

const uuid={type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'};
const revision={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER-10000};
const metadata={title:{type:'string',minLength:1,maxLength:200},description:{type:'string',maxLength:2000}};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const publicSeries=s=>({id:s.id,shelfId:s.shelf_id,title:s.title,description:s.description,revision:s.revision,createdAt:s.created_at,updatedAt:s.updated_at,parentId:s.parent_id??null});
export function shelfSeries(db,shelfId){
  return db.prepare(`WITH RECURSIVE tree(root,id,shelf_id,depth) AS (
    SELECT id,id,shelf_id,0 FROM series WHERE shelf_id=?
    UNION ALL SELECT t.root,s.id,s.shelf_id,t.depth+1 FROM series s JOIN tree t ON s.parent_id=t.id AND s.shelf_id=t.shelf_id WHERE t.depth<16)
    SELECT s.*,COUNT(si.asset_id) asset_count,SUM(CASE WHEN t.depth=0 AND si.asset_id IS NOT NULL THEN 1 ELSE 0 END) direct_count,
    (SELECT COUNT(*) FROM series child WHERE child.parent_id=s.id AND child.shelf_id=s.shelf_id) child_count,
    (SELECT member.asset_id FROM tree branch JOIN series_items member ON member.series_id=branch.id WHERE branch.root=s.id ORDER BY branch.depth,branch.id,member.position LIMIT 1) cover_id
    FROM series s JOIN tree t ON t.root=s.id LEFT JOIN series_items si ON si.series_id=t.id WHERE s.shelf_id=? GROUP BY s.id ORDER BY s.title,s.id`)
    .all(shelfId,shelfId).map(s=>({...publicSeries(s),assetCount:s.asset_count,directAssetCount:s.direct_count,childCount:s.child_count,coverId:s.cover_id}));
}
function validateTree(rows){
  const byId=new Map(rows.map(s=>[s.id,s]));
  for(const row of rows){const seen=new Set();let next=row;
    while(next){if(seen.has(next.id))throw httpError(422,'シリーズを循環する入れ子にはできません。');seen.add(next.id);
      if(seen.size>16)throw httpError(422,'シリーズの入れ子は16階層までです。');
      if(next.parent_id&&!byId.has(next.parent_id))throw httpError(422,'同じ本棚のシリーズを親に選んでください。');
      next=byId.get(next.parent_id);
    }
  }
}
function validateNames(rows,previous=[]){
  const count=list=>{const values=new Map();for(const row of list){const key=JSON.stringify([row.parent_id??null,row.title]);values.set(key,(values.get(key)??0)+1);}return values;};
  const before=count(previous);for(const [key,n]of count(rows))if(n>1&&n>(before.get(key)??0))throw httpError(409,'同じ階層に同じ名前のシリーズがあります。');
}
export function shelfSeriesMembership(db,shelfId){
  return new Map(db.prepare(`SELECT si.*,s.title,(SELECT COUNT(*) FROM series_items other WHERE other.series_id=si.series_id AND other.position<=si.position) ordinal FROM series_items si JOIN series s ON s.id=si.series_id WHERE s.shelf_id=?`)
    .all(shelfId).map(s=>[s.asset_id,{id:s.series_id,title:s.title,position:s.ordinal,label:s.label}]));
}
export function registerSeries(app,{db,authenticate,membership,findItem,publicItem,removeAssetFiles,uploads}){
  const auth={onRequest:async req=>authenticate(req)};
  registerSeriesActions(app,{db,authenticate,membership,removeAssetFiles,uploads});
  const find=(id,userId,roles)=>{
    const row=db.prepare('SELECT * FROM series WHERE id=?').get(id);
    if(!row)throw httpError(404,'シリーズが見つかりません。');
    const role=membership(row.shelf_id,userId,roles);
    return {...row,role};
  };
  const detail=(series,userId)=>({children:shelfSeries(db,series.shelf_id).filter(s=>s.parentId===series.id),series:{...publicSeries(series),role:series.role},items:db.prepare(`SELECT i.*,si.position,si.label FROM series_items si JOIN items i ON i.id=si.asset_id WHERE si.series_id=? ORDER BY si.position`).all(series.id).map((row,index)=>({
    ...publicItem(row),series:{id:series.id,title:series.title,position:index+1,label:row.label},
    progress:publicProgress(db.prepare('SELECT * FROM asset_progress WHERE user_id=? AND asset_id=?').get(userId,row.id))
  }))});
  app.get('/api/v1/shelves/:id/series',auth,async req=>{
    membership(req.params.id,req.user.id);return {series:shelfSeries(db,req.params.id)};
  });
  app.post('/api/v1/shelves/:id/series',{...auth,bodyLimit:16384,schema:{body:object({...metadata,parentId:{anyOf:[uuid,{type:'null'}]},requestId:uuid,reuseExisting:{type:'boolean'}},['title'])}},async(req,reply)=>{
    membership(req.params.id,req.user.id,['owner','editor']);
    const title=req.body.title.trim().normalize('NFC');if(!title)throw httpError(422,'シリーズ名を入力してください。');
    const result=transaction(db,()=>{
      if(req.body.requestId){const saved=db.prepare('SELECT series_id FROM series_create_requests WHERE user_id=? AND request_id=?').get(req.user.id,req.body.requestId);
        if(saved){const existing=find(saved.series_id,req.user.id,['owner','editor']);if(existing.shelf_id!==req.params.id)throw httpError(409,'別の作成要求としてやり直してください。');return detail(existing,req.user.id);}
      }
      const parent=req.body.parentId??null;
      const collisions=db.prepare('SELECT * FROM series WHERE shelf_id=? AND parent_id IS ? ORDER BY created_at,id').all(req.params.id,parent).filter(row=>canonicalName(row.title)===title).slice(0,2);
      if(collisions.length>1)throw httpError(409,'既存の同名シリーズが複数あります。所有者が整理してから取り込んでください。');
      const collision=collisions[0];
      if(collision){if(!req.body.reuseExisting)throw httpError(409,'同じ階層に同じ名前のシリーズがあります。');return {...detail(find(collision.id,req.user.id),req.user.id),created:false};}
      const id=randomUUID(),now=Date.now();
      validateTree([...db.prepare('SELECT id,parent_id FROM series WHERE shelf_id=?').all(req.params.id),{id,parent_id:parent}]);
      db.prepare('INSERT INTO series(id,shelf_id,title,description,created_at,updated_at,parent_id) VALUES(?,?,?,?,?,?,?)').run(id,req.params.id,title,req.body.description?.trim()??'',now,now,parent);
      if(parent)db.prepare('UPDATE series SET revision=revision+1,updated_at=? WHERE id=?').run(now,parent);
      if(req.body.requestId)db.prepare('INSERT INTO series_create_requests VALUES(?,?,?)').run(req.user.id,req.body.requestId,id);
      return {...detail(find(id,req.user.id),req.user.id),created:true};
    });
    return reply.code(201).send(result);
  });
  app.get('/api/v1/series/:id',auth,async req=>detail(find(req.params.id,req.user.id),req.user.id));
  app.get('/api/v1/items/:id/series',auth,async req=>{
    const item=findItem(req.params.id,req.user.id);
    const row=db.prepare('SELECT series_id FROM series_items WHERE asset_id=?').get(item.id);
    if(!row)return {series:null,items:[],currentIndex:-1};
    const result=detail(find(row.series_id,req.user.id),req.user.id);
    return {...result,currentIndex:result.items.findIndex(i=>i.id===item.id)};
  });
  app.put('/api/v1/series/:id',{...auth,bodyLimit:256*1024,schema:{body:object({revision,...metadata,parentId:{anyOf:[uuid,{type:'null'}]},moveAssets:{type:'boolean'},children:{type:'array',maxItems:1000,uniqueItems:true,items:uuid},items:{type:'array',maxItems:1000,items:object({assetId:uuid,label:{type:'string',maxLength:80}},['assetId'])}},['revision','title','description','items'])}},async req=>{
    const series=find(req.params.id,req.user.id,['owner','editor']),input=req.body,title=input.title.trim().normalize('NFC');
    if(!title)throw httpError(422,'シリーズ名を入力してください。');
    return transaction(db,()=>{
      if(series.revision!==input.revision)throw httpError(409,'シリーズが別の画面で更新されました。最新の内容を読み直してください。');
      const seen=new Set();
      for(const entry of input.items){
        if(seen.has(entry.assetId))throw httpError(422,'同じアセットは1回だけ登録できます。');seen.add(entry.assetId);
        const item=db.prepare('SELECT shelf_id FROM items WHERE id=?').get(entry.assetId);
        if(!item || item.shelf_id!==series.shelf_id)throw httpError(422,'この本棚のアセットだけを追加できます。');
        const previous=db.prepare('SELECT series_id FROM series_items WHERE asset_id=?').get(entry.assetId);
        if(previous && previous.series_id!==series.id&&!input.moveAssets)throw httpError(409,'別のシリーズに所属しています。先にそのシリーズから外してください。');
      }
      const originalMembers=db.prepare('SELECT asset_id FROM series_items WHERE series_id=?').all(series.id);
      assertAssetChanges(db,series.shelf_id,[...originalMembers.filter(row=>!seen.has(row.asset_id)).map(row=>({id:row.asset_id,parentId:null})),...input.items.map(row=>({id:row.assetId,parentId:series.id}))]);
      const rows=db.prepare('SELECT id,parent_id,title FROM series WHERE shelf_id=?').all(series.shelf_id),original=new Map(rows.map(s=>[s.id,s.parent_id]));
      const previousRows=rows.map(row=>({...row}));
      if(input.parentId!==undefined)rows.find(s=>s.id===series.id).parent_id=input.parentId;
      if(input.children!==undefined){
        for(const id of input.children){const child=rows.find(s=>s.id===id);if(!child||id===series.id)throw httpError(422,'同じ本棚の別のシリーズを選んでください。');
          if(original.get(id)&&original.get(id)!==series.id)throw httpError(409,'別の親シリーズから外してから追加してください。');
        }
        for(const row of rows)if(original.get(row.id)===series.id&&!input.children.includes(row.id))row.parent_id=null;
        for(const id of input.children)rows.find(s=>s.id===id).parent_id=series.id;
      }
      rows.find(s=>s.id===series.id).title=title;assertSeriesChanges(db,series.shelf_id,rows.map(row=>({id:row.id,parentId:row.parent_id,title:row.title})));validateTree(rows);
      const changed=rows.filter(row=>row.parent_id!==original.get(row.id)),parents=new Set(changed.flatMap(row=>[row.parent_id,original.get(row.id)]).filter(Boolean));
      for(const row of changed)db.prepare('UPDATE series SET title=? WHERE id=?').run('mirea-move-'+row.id,row.id);
      for(const row of changed)db.prepare('UPDATE series SET parent_id=NULL WHERE id=?').run(row.id);
      for(const row of changed)if(row.parent_id)db.prepare('UPDATE series SET parent_id=? WHERE id=?').run(row.parent_id,row.id);
      for(const row of changed)db.prepare('UPDATE series SET title=? WHERE id=?').run(row.title,row.id);
      for(const id of parents)if(id!==series.id)db.prepare('UPDATE series SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(),id);
      if(input.moveAssets)for(const entry of input.items)db.prepare('DELETE FROM series_items WHERE asset_id=? AND series_id!=?').run(entry.assetId,series.id);
      db.prepare('DELETE FROM series_items WHERE series_id=?').run(series.id);
      const insert=db.prepare('INSERT INTO series_items(series_id,asset_id,position,label) VALUES(?,?,?,?)');
      input.items.forEach((entry,index)=>insert.run(series.id,entry.assetId,index+1,entry.label?.trim()??''));
      db.prepare('UPDATE series SET title=?,description=?,revision=?,updated_at=? WHERE id=?').run(title,input.description.trim(),input.revision+1,Date.now(),series.id);
      return detail(find(series.id,req.user.id),req.user.id);
    });
  });

}
