import {randomUUID} from 'node:crypto';
import {transaction} from './database.js';
import {aiHash,AI_FEATURES} from './ai-validation.js';
import {aiFeatureApplies} from './ai-input.js';
import {httpError} from './security.js';
const requestFor=(batch,id)=>{const h=aiHash({batch,id});return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
export function createAiBatches({db,enqueue,enabledUser,available=()=>true}){
  let closing=false,task;
  const list=(user,shelfId)=>db.prepare(`SELECT b.id,b.state,b.created_at createdAt,COUNT(a.asset_id) total,
    SUM(a.state='queued') waiting,SUM(a.state='failed') failed FROM ai_batches b JOIN ai_batch_assets a ON a.batch_id=b.id
    JOIN items i ON i.id=a.asset_id JOIN shelves s ON s.id=i.shelf_id JOIN memberships m ON m.shelf_id=i.shelf_id AND m.user_id=b.user_id
    WHERE b.user_id=? AND (? IS NULL AND s.private=0 OR i.shelf_id=?) GROUP BY b.id ORDER BY b.created_at DESC LIMIT 100`).all(user,shelfId??null,shelfId??null);
  function create(userId,{requestId,features,regenerate=false,shelfId,seriesId,assetIds}){
    if(!/^[0-9a-f-]{36}$/i.test(requestId??'')||!Array.isArray(features)||!features.length||features.some(f=>!AI_FEATURES.includes(f)))throw httpError(422,'解析する内容と依頼番号を確認してください。');
    if(!shelfId&&(!Array.isArray(assetIds)||assetIds.length>1000||assetIds.some(id=>typeof id!=='string')))throw httpError(422,'選択した作品を確認してください。');
    const hash=aiHash({features,regenerate,shelfId,seriesId,assetIds});
    return transaction(db,()=>{
      const prior=db.prepare('SELECT * FROM ai_batches WHERE user_id=? AND request_id=?').get(userId,requestId);
      if(prior){if(prior.payload_hash!==hash)throw httpError(409,'同じ依頼番号の対象が異なります。');return {batchId:prior.id};}
      const id=randomUUID(),now=Date.now();db.prepare("INSERT INTO ai_batches VALUES(?,?,?,?,?,?,'queued',?,?)").run(id,userId,requestId,hash,JSON.stringify([...new Set(features)]),Number(regenerate),now,now);
      if(seriesId)db.prepare(`INSERT INTO ai_batch_assets(batch_id,asset_id)
        WITH RECURSIVE tree(id) AS(SELECT id FROM series WHERE id=? AND shelf_id=? UNION ALL SELECT s.id FROM series s JOIN tree p ON s.parent_id=p.id)
        SELECT DISTINCT ?,asset_id FROM series_items WHERE series_id IN(SELECT id FROM tree)`).run(seriesId,shelfId,id);
      else if(shelfId)db.prepare('INSERT INTO ai_batch_assets(batch_id,asset_id) SELECT ?,id FROM items WHERE shelf_id=?').run(id,shelfId);
      else{const put=db.prepare("INSERT OR IGNORE INTO ai_batch_assets(batch_id,asset_id) VALUES(?,?)");for(const assetId of assetIds)put.run(id,assetId);}
      return {batchId:id,total:db.prepare('SELECT COUNT(*) n FROM ai_batch_assets WHERE batch_id=?').get(id).n};
    });
  }
  async function expand(){
    if(!available())return;
    const batch=db.prepare("SELECT * FROM ai_batches WHERE state='queued' ORDER BY updated_at LIMIT 1").get();if(!batch)return;
    const rows=db.prepare("SELECT i.* FROM ai_batch_assets a JOIN items i ON i.id=a.asset_id WHERE a.batch_id=? AND a.state='queued' LIMIT 10").all(batch.id);
    for(const item of rows){
      if(closing||db.prepare('SELECT state FROM ai_batches WHERE id=?').get(batch.id)?.state!=='queued')break;
      const role=db.prepare('SELECT role FROM memberships WHERE user_id=? AND shelf_id=?').get(batch.user_id,item.shelf_id)?.role;
      let state='accepted',error=null;
      if(!enabledUser(batch.user_id)||!role||!['owner','editor'].includes(role)&&item.uploaded_by!==batch.user_id){state='cancelled';error='AI_AUTHORITY_EXPIRED';}
      else{const features=JSON.parse(batch.features_json).filter(f=>aiFeatureApplies(f,item.mime_type));if(features.length)try{await enqueue(item,batch.user_id,features,{requestId:requestFor(batch.id,item.id),regenerate:Boolean(batch.regenerate)});}catch(e){state='failed';error=/^AI_[A-Z_]+$/.test(e.code??'')?e.code:'AI_INPUT_UNAVAILABLE';}}
      db.prepare('UPDATE ai_batch_assets SET state=?,error_code=? WHERE batch_id=? AND asset_id=?').run(state,error,batch.id,item.id);
    }
    if(!db.prepare("SELECT 1 FROM ai_batch_assets WHERE batch_id=? AND state='queued' LIMIT 1").get(batch.id))db.prepare("UPDATE ai_batches SET state='complete',updated_at=? WHERE id=?").run(Date.now(),batch.id);
    else db.prepare('UPDATE ai_batches SET updated_at=? WHERE id=?').run(Date.now(),batch.id);
  }
  const timer=setInterval(()=>{if(!closing&&!task)task=expand().catch(()=>{}).finally(()=>{task=null;});},1000);timer.unref();
  return {create,list,control(user,id,action){const row=db.prepare('SELECT * FROM ai_batches WHERE id=? AND user_id=?').get(id,user);if(!row)throw httpError(404,'一括解析の依頼が見つかりません。');if(!['pause','resume','cancel','retry'].includes(action))throw httpError(422,'操作を確認してください。');
    if(action==='retry')db.prepare("UPDATE ai_batch_assets SET state='queued',error_code=NULL WHERE batch_id=? AND state='failed'").run(id);
    db.prepare('UPDATE ai_batches SET state=?,updated_at=? WHERE id=?').run(action==='pause'?'paused':action==='cancel'?'cancelled':'queued',Date.now(),id);
    return {id};},async close(){closing=true;clearInterval(timer);await task;}};
}
