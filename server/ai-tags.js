import {transaction} from './database.js';
import {aiText,aiHash,normalizeAiText,validateAiTags} from './ai-validation.js';
import {httpError} from './security.js';
export function registerAiTags(app,{db,authenticate,asset,shelf,canEdit,store,ensureAvailable}){
  const auth={onRequest:async req=>authenticate(req),preHandler:async req=>authenticate(req)};
  function dictionary(req){
    const scope=req.query.scope??'shared',shelfId=req.query.shelfId;
    if(!['shared','personal'].includes(scope))throw httpError(422,'タグの範囲を選んでください。');
    if(shelfId)shelf(req,shelfId);
    const params=[req.user.id],where=['m.user_id=?','t.rejected=0'];
    if(shelfId){where.push('i.shelf_id=?');params.push(shelfId);}else where.push('s.private=0');
    if(scope==='personal'){where.push('t.user_id=?');params.push(req.user.id);}else where.push('t.user_id IS NULL');
    const rows=db.prepare(`SELECT t.normalized,MIN(t.label) label,MIN(t.category) category,COUNT(*) count,MAX(t.updated_at) updatedAt
      FROM asset_tags t JOIN items i ON i.id=t.asset_id JOIN shelves s ON s.id=i.shelf_id JOIN memberships m ON m.shelf_id=i.shelf_id
      WHERE ${where.join(' AND ')} GROUP BY t.normalized ORDER BY t.normalized LIMIT 10001`).all(...params);
    if(rows.length>10000)throw httpError(422,'本棚を選んでタグを絞り込んでください。');
    return {tags:rows,revision:aiHash(rows),scope,shelfId};
  }
  app.get('/api/v1/ai/tags',auth,async req=>dictionary(req));
  app.post('/api/v1/ai/tags/bulk',auth,async req=>{
    ensureAvailable();const body=req.body??{},ids=body.assetIds;
    if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))||!['add','remove'].includes(body.action))throw httpError(422,'タグを編集する作品と操作を選んでください。');
    const tags=validateAiTags(body.tags),personal=body.scope==='personal';
    if(!personal&&body.scope!=='shared')throw httpError(422,'タグの保存範囲を選んでください。');
    const items=[...new Set(ids)].map(id=>asset(req,id));
    for(const item of items)if(!personal&&!canEdit(item,req.user.id))throw httpError(403,'共有タグを編集できない作品が含まれています。');
    return transaction(db,()=>{
      for(const item of items){const old=store.tags(item.id,req.user.id).filter(t=>t.scope===body.scope),accepted=old.filter(t=>!t.rejected),rejected=old.filter(t=>t.rejected);
        const normalized=new Set(tags.map(t=>t.normalized));
        const next=body.action==='add'?[...accepted.filter(t=>!normalized.has(normalizeAiText(t.label))),...tags]:accepted.filter(t=>!normalized.has(normalizeAiText(t.label)));
        const hidden=body.action==='remove'?[...rejected.filter(t=>!normalized.has(normalizeAiText(t.label))),...tags]:rejected.filter(t=>!normalized.has(normalizeAiText(t.label)));
        store.setTags(item,req.user.id,{scope:body.scope,revision:store.tagRevision(item.id,req.user.id,body.scope),tags:next,rejected:hidden},true,{withinTransaction:true});
      }return {updated:items.length};
    });
  });
  app.post('/api/v1/ai/tags/rename',auth,async req=>{
    ensureAvailable();const body=req.body??{},scope=body.scope??'shared';
    if(scope==='shared'&&!body.shelfId)throw httpError(422,'共有タグを整理する本棚を選んでください。');
    req.query={scope,shelfId:body.shelfId};const current=dictionary(req);
    if(body.revision!==current.revision)throw httpError(409,'タグの一覧が更新されました。最新の件数を確認してください。');
    const from=normalizeAiText(aiText(body.from,80)),to=validateAiTags([body.to])[0];
    if(from===to.normalized&&body.from===to.label)return {updated:0};
    const params=[req.user.id,from],where=['m.user_id=?','t.normalized=?'];
    if(body.shelfId){shelf(req,body.shelfId,scope==='shared'?['owner','editor']:undefined);where.push('i.shelf_id=?');params.push(body.shelfId);}else where.push('s.private=0');
    if(scope==='personal'){where.push('t.user_id=?');params.push(req.user.id);}else where.push('t.user_id IS NULL');
    const rows=db.prepare(`SELECT DISTINCT i.* FROM items i JOIN shelves s ON s.id=i.shelf_id JOIN memberships m ON m.shelf_id=i.shelf_id JOIN asset_tags t ON t.asset_id=i.id WHERE ${where.join(' AND ')}`).all(...params);
    return transaction(db,()=>{for(const item of rows){const existing=store.tags(item.id,req.user.id).filter(t=>t.scope===scope),tags=existing.filter(t=>!t.rejected&&![from,to.normalized].includes(normalizeAiText(t.label)));tags.push(to);
      const rejected=existing.filter(t=>t.rejected&&![from,to.normalized].includes(normalizeAiText(t.label)));if(from!==to.normalized)rejected.push({label:body.from});
      store.setTags(item,req.user.id,{scope,revision:store.tagRevision(item.id,req.user.id,scope),tags,rejected},true,{withinTransaction:true});}
      return {updated:rows.length};});
  });
}
