import {assertAssetChanges,assertSeriesChanges} from './name-integrity.js';
import {createHash} from 'node:crypto';
import {transaction} from './database.js';
import {httpError} from './security.js';
const uuid={type:'string',format:'uuid'},revision={type:'integer',minimum:1};
const ids={type:'array',items:uuid,minItems:1,maxItems:1000,uniqueItems:true};
export function registerSeriesActions(app,{db,authenticate,membership,removeAssetFiles,uploads}){
  const auth={onRequest:async req=>authenticate(req)};
  function find(id,actor){const row=db.prepare('SELECT * FROM series WHERE id=?').get(id);if(!row)throw httpError(404,'シリーズが見つかりません。');membership(row.shelf_id,actor,['owner','editor']);return row;}
  function plan(roots,actor){
    const selected=roots.map(id=>find(id,actor));
    if(new Set(selected.map(s=>s.shelf_id)).size!==1)throw httpError(422,'同じ本棚のシリーズを選んでください。');
    const rows=db.prepare(`WITH RECURSIVE branch(id) AS(SELECT value FROM json_each(?) UNION SELECT s.id FROM series s JOIN branch b ON s.parent_id=b.id)
      SELECT s.* FROM series s JOIN branch b ON b.id=s.id ORDER BY s.id`).all(JSON.stringify(roots));
    const keys=JSON.stringify(rows.map(s=>s.id));
    const assets=db.prepare('SELECT i.* FROM items i JOIN series_items si ON si.asset_id=i.id WHERE si.series_id IN (SELECT value FROM json_each(?)) ORDER BY i.id').all(keys);
    const pending=db.prepare('SELECT id,state FROM upload_sessions WHERE target_series_id IN (SELECT value FROM json_each(?)) ORDER BY id').all(keys);
    const hash=createHash('sha256').update(JSON.stringify([rows.map(s=>[s.id,s.revision,s.parent_id,s.title]),assets.map(i=>i.id),pending])).digest('hex');
    return {selected,rows,assets,pending,hash,keys};
  }
  const summary=p=>({seriesCount:p.rows.length,assetCount:p.assets.length,pendingCount:p.pending.filter(u=>u.state!=='complete').length,previewHash:p.hash});
  app.get('/api/v1/series/:id/delete-preview',auth,async req=>summary(plan([req.params.id],req.user.id)));
  app.post('/api/v1/series/bulk/preview',{...auth,schema:{body:{type:'object',additionalProperties:false,required:['ids'],properties:{ids}}}},async req=>summary(plan(req.body.ids,req.user.id)));
  async function remove(roots,req,deep,hash){
    let p;
    transaction(db,()=>{
      p=plan(roots,req.user.id);
      if(deep&&(!hash||hash!==p.hash))throw httpError(409,'削除対象が変わりました。件数を確認し直してください。');
      if(!deep){
        const selectedIds=new Set(p.selected.map(row=>row.id)),allSeries=db.prepare('SELECT id,parent_id FROM series WHERE shelf_id=?').all(p.selected[0].shelf_id);assertSeriesChanges(db,p.selected[0].shelf_id,allSeries.filter(row=>selectedIds.has(row.id)||selectedIds.has(row.parent_id)).map(row=>selectedIds.has(row.id)?{id:row.id,remove:true}:{id:row.id,parentId:null}));
        const selected=JSON.stringify(p.selected.map(row=>row.id));const detached=db.prepare('SELECT i.id,i.shelf_id shelfId FROM items i JOIN series_items si ON si.asset_id=i.id WHERE si.series_id IN (SELECT value FROM json_each(?))').all(selected);
        assertAssetChanges(db,p.selected[0].shelf_id,detached.map(row=>({id:row.id,parentId:null})));
        for(const row of p.selected){
          const collision=db.prepare('SELECT 1 FROM series child JOIN series root ON root.shelf_id=child.shelf_id AND root.parent_id IS NULL AND root.title=child.title AND root.id!=child.id WHERE child.parent_id=?').get(row.id);
          if(collision)throw httpError(409,'子シリーズを最上位へ移すと名前が重複します。名前または移動先を変更してください。');
        }
      }
      if(deep){
        for(const upload of p.pending)db.prepare("UPDATE upload_sessions SET state='cancelled' WHERE id=? AND state!='complete'").run(upload.id);
        for(const item of p.assets)db.prepare('DELETE FROM items WHERE id=?').run(item.id);
        // Children first: FK SET NULL must not temporarily collide at the root.
        const remaining=new Set(p.rows.map(s=>s.id));
        while(remaining.size){const leaves=p.rows.filter(s=>remaining.has(s.id)&&!p.rows.some(c=>remaining.has(c.id)&&c.parent_id===s.id));if(!leaves.length)throw httpError(409,'シリーズ構造を確認できません。');for(const row of leaves){db.prepare('DELETE FROM series WHERE id=?').run(row.id);remaining.delete(row.id);}}
      }else for(const row of p.selected)db.prepare('DELETE FROM series WHERE id=?').run(row.id);
      for(const row of p.selected)if(row.parent_id)db.prepare('UPDATE series SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(),row.parent_id);
    });
    if(deep){await uploads.cancelForDeletion(p.pending.map(u=>u.id));for(const item of p.assets)await removeAssetFiles(item);}
    return summary(p);
  }
  app.delete('/api/v1/series/:id',{...auth,schema:{body:{type:'object',additionalProperties:false,required:['revision'],properties:{revision,deleteContents:{type:'boolean'},onlyIfEmpty:{type:'boolean'},previewHash:{type:'string',pattern:'^[a-f0-9]{64}$'}}}}},async(req,reply)=>{
    const row=find(req.params.id,req.user.id);if(row.revision!==req.body.revision)throw httpError(409,'シリーズが更新されています。最新の内容を読み直してください。');
    if(req.body.onlyIfEmpty){const p=plan([row.id],req.user.id);if(p.assets.length||p.rows.length>1||p.pending.some(u=>['processing','uploading'].includes(u.state)))throw httpError(409,'使用中のシリーズは削除しません。');}
    await remove([row.id],req,req.body.deleteContents,req.body.previewHash);return reply.code(204).send();
  });
  app.post('/api/v1/series/bulk',{...auth,bodyLimit:128*1024,schema:{body:{type:'object',additionalProperties:false,required:['ids','action','previewHash'],properties:{ids,action:{enum:['move','delete']},parentId:{anyOf:[uuid,{type:'null'}]},deleteContents:{type:'boolean'},previewHash:{type:'string',pattern:'^[a-f0-9]{64}$'}}}}},async req=>{
    if(req.body.action==='delete')return remove(req.body.ids,req,req.body.deleteContents,req.body.previewHash);
    return transaction(db,()=>{
      const p=plan(req.body.ids,req.user.id);if(p.hash!==req.body.previewHash)throw httpError(409,'対象が変わりました。選び直してください。');
      const parent=req.body.parentId??null;if(parent){const destination=find(parent,req.user.id);if(destination.shelf_id!==p.selected[0].shelf_id||p.rows.some(s=>s.id===parent))throw httpError(422,'同じ本棚の配下ではないシリーズを選んでください。');}
      const selectedIds=new Set(p.selected.map(s=>s.id)),tree=new Map(p.rows.map(s=>[s.id,s]));
      const roots=p.selected.filter(row=>{let parent=tree.get(row.parent_id);while(parent){if(selectedIds.has(parent.id))return false;parent=tree.get(parent.parent_id);}return true;});
      const all=db.prepare('SELECT id,parent_id,title FROM series WHERE shelf_id=?').all(p.selected[0].shelf_id);
      for(const row of all)if(roots.some(r=>r.id===row.id))row.parent_id=parent;
      assertSeriesChanges(db,p.selected[0].shelf_id,all.map(row=>({id:row.id,parentId:row.parent_id,title:row.title})));
      const byId=new Map(all.map(s=>[s.id,s]));for(const row of all){let s=row,depth=0;while(s){if(++depth>16)throw httpError(422,'入れ子は16階層までです。');s=byId.get(s.parent_id);}}
      for(const row of roots)db.prepare('UPDATE series SET parent_id=? WHERE id=?').run(parent,row.id);
      for(const id of new Set([parent,...roots.map(r=>r.parent_id)].filter(Boolean)))db.prepare('UPDATE series SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(),id);
      return {moved:roots.length};
    });
  });
}
