import { createHash } from 'node:crypto';
import { transaction } from './database.js';
import { isTimedMime } from './audio-types.js';
import { httpError } from './security.js';

const uuid={type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'};
const millis={type:'integer',minimum:0,maximum:31*86400000};
const fraction={type:'number',minimum:0,maximum:1};
export function publicProgress(row) {
  return row ? { revision:row.revision,positionMs:row.position_ms,durationMs:row.duration_ms,page:row.page_number,
    scrollX:row.scroll_x,scrollY:row.scroll_y,zoom:row.zoom,completed:Boolean(row.completed),updatedAt:row.updated_at } : null;
}
export function registerProgress(app,{db,authenticate,findItem,options}) {
  const auth={onRequest:async req=>authenticate(req)};
  const get=db.prepare('SELECT * FROM asset_progress WHERE user_id=? AND asset_id=?');
  app.get('/api/v1/items/:id/progress',auth,async req=>{
    findItem(req.params.id,req.user.id);
    const progress=publicProgress(get.get(req.user.id,req.params.id));
    return {progress,revision:progress?.revision ?? 0};
  });
  app.put('/api/v1/items/:id/progress',{
    ...auth,bodyLimit:2048,
    config:{rateLimit:options.rateLimit===false?false:{hook:'preHandler',max:240,timeWindow:'1 minute',keyGenerator:req=>req.user.id}},
    schema:{body:{type:'object',additionalProperties:false,required:['revision','updateId'],properties:{
      revision:{type:'integer',minimum:0,maximum:2147483646},updateId:uuid,
      positionMs:millis,durationMs:{...millis,minimum:1},page:{type:'integer',minimum:1,maximum:1000000},scrollX:fraction,scrollY:fraction,zoom:{enum:['fit','1','1.5','2']}
    }}}
  },async req=>{
    const item=findItem(req.params.id,req.user.id),input=req.body;
    const video=isTimedMime(item.mime_type);
    if(video){
      if(input.positionMs===undefined || input.durationMs===undefined || input.positionMs>input.durationMs || ['page','scrollX','scrollY','zoom'].some(key=>input[key]!==undefined)) throw httpError(422,'動画・音声の再開位置が不正です。');
    }else if(input.page===undefined || input.page>item.page_count || input.positionMs!==undefined || input.durationMs!==undefined) throw httpError(422,'本の再開位置が不正です。');
    const state=video?{positionMs:input.positionMs,durationMs:input.durationMs}:{page:input.page,scrollX:input.scrollX??0,scrollY:input.scrollY??0,zoom:input.zoom??'fit'};
    const hash=createHash('sha256').update(JSON.stringify({revision:input.revision,...state})).digest('hex');
    return transaction(db,()=>{
      const previous=get.get(req.user.id,item.id);
      if(previous?.update_id===input.updateId){
        if(previous.payload_hash!==hash) throw httpError(409,'同じ更新IDに異なる内容は保存できません。');
        return {progress:publicProgress(previous)};
      }
      if((previous?.revision??0)!==input.revision) throw httpError(409,'別の画面で進行度が更新されました。開き直して最新の続き位置を取得してください。');
      const completed=video && input.positionMs>=input.durationMs ? 1:0;
      db.prepare(`INSERT INTO asset_progress(user_id,asset_id,revision,update_id,payload_hash,position_ms,duration_ms,page_number,scroll_x,scroll_y,zoom,completed,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,asset_id) DO UPDATE SET revision=excluded.revision,update_id=excluded.update_id,payload_hash=excluded.payload_hash,
        position_ms=excluded.position_ms,duration_ms=excluded.duration_ms,page_number=excluded.page_number,scroll_x=excluded.scroll_x,scroll_y=excluded.scroll_y,zoom=excluded.zoom,completed=excluded.completed,updated_at=excluded.updated_at`)
        .run(req.user.id,item.id,input.revision+1,input.updateId,hash,state.positionMs??null,state.durationMs??null,state.page??null,state.scrollX??null,state.scrollY??null,state.zoom??null,completed,Date.now());
      return {progress:publicProgress(get.get(req.user.id,item.id))};
    });
  });
}
