import {randomUUID} from 'node:crypto';
import {transaction} from './database.js';
import {httpError} from './security.js';
import {aiHash,normalizeAiText,validateAiTags,validateAiResult,validateAiPatch,applyAiEdits} from './ai-validation.js';

export function createAiStore(db) {
  const resultRow=db.prepare('SELECT * FROM ai_results WHERE asset_id=? AND feature=?');
  const editRow=db.prepare('SELECT * FROM ai_edits WHERE asset_id=? AND feature=?');
  const merge=(before={},delta={})=>Object.fromEntries([...new Set([...Object.keys(before),...Object.keys(delta)])].map(id=>[id,{...before[id],...delta[id]}]));
  const empty=()=>({tags:[],blocks:[],segments:[],summary:''});
  function tags(assetId,userId) {
    return db.prepare(`SELECT id,label,category,source,rejected,user_id FROM asset_tags
      WHERE asset_id=? AND (user_id IS NULL OR user_id=?) ORDER BY normalized`).all(assetId,userId)
      .map(({user_id,...row})=>({...row,scope:user_id?'personal':'shared',rejected:Boolean(row.rejected)}));
  }
  function *units(assetId,feature) {
    let found=false;
    for(const row of db.prepare('SELECT unit,result_json FROM ai_result_units WHERE asset_id=? AND feature=? ORDER BY unit').iterate(assetId,feature)){
      found=true;yield {unit:row.unit,value:JSON.parse(row.result_json)};
    }
    if(!found){const row=resultRow.get(assetId,feature);if(row)yield {unit:0,value:JSON.parse(row.result_json)};}
  }
  function read(assetId,feature,{offset=0,limit=20,unit,startMs,endMs}={}) {
    const row=resultRow.get(assetId,feature);if(!row)return null;
    const edit=editRow.get(assetId,feature),patch=JSON.parse(edit?.patch_json??'{}'),meta=JSON.parse(row.result_json);
    const result=empty();result.tags=meta.tags;result.summary=meta.summary;
    const storedCount=db.prepare('SELECT COUNT(*) n FROM ai_result_units WHERE asset_id=? AND feature=?').get(assetId,feature).n;
    const selected=storedCount?(unit!==undefined?db.prepare('SELECT unit,result_json FROM ai_result_units WHERE asset_id=? AND feature=? AND unit=?').all(assetId,feature,unit):db.prepare('SELECT unit,result_json FROM ai_result_units WHERE asset_id=? AND feature=? AND unit>=? ORDER BY unit LIMIT ?').all(assetId,feature,offset,limit)).map(r=>({unit:r.unit,value:JSON.parse(r.result_json)})):[{unit:0,value:meta}];
    const count=storedCount||1;let returned=0;const unresolved=[];
    for(const key of ['blocks','segments','splits'])for(const [id,edit]of Object.entries(patch[key]??{})){const exists=db.prepare('SELECT 1 FROM ai_result_locations WHERE asset_id=? AND feature=? AND block_id=?').get(assetId,feature,id);if(!exists)unresolved.push({kind:key,id,edit});}
    for(const entry of selected){
      const effective=applyAiEdits(entry.value,patch);
      if(startMs!==undefined||endMs!==undefined)effective.segments=effective.segments.filter(s=>s.endMs>(startMs??0)&&s.startMs<(endMs??Infinity));
      result.blocks.push(...effective.blocks);result.segments.push(...effective.segments);returned++;
    }
    // Legacy single-unit results remain readable during upgrades.
    return {feature,revision:row.revision,editRevision:edit?.revision??0,inputStamp:row.input_stamp,
      modelId:row.model_id,updatedAt:row.updated_at,provenance:meta.provenance,result,patch,unresolved,unitCount:count,offset,nextOffset:(selected.at(-1)?.unit??offset)+1,hasMore:unit===undefined&&Boolean(db.prepare('SELECT 1 FROM ai_result_units WHERE asset_id=? AND feature=? AND unit>? LIMIT 1').get(assetId,feature,selected.at(-1)?.unit??offset))};
  }
  function documentUnit(assetId,feature,result,revision,suffix='') {
    const statement=db.prepare(`INSERT INTO ai_documents(id,asset_id,feature,locator_json,text,normalized,revision)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET locator_json=excluded.locator_json,text=excluded.text,
      normalized=excluded.normalized,revision=excluded.revision,vector=NULL,vector_space=NULL`);
    const put={run(id,assetId,feature,locator,text,normalized,revision){
      statement.run(id,assetId,feature,locator,text,normalized,revision);
      for(let offset=1600;offset<text.length;offset+=1600){const part=text.slice(offset,offset+1800),place=JSON.parse(locator);if(place.chapter!==undefined)place.textOffset=(place.textOffset??0)+offset;statement.run(id+':chunk'+offset,assetId,feature,JSON.stringify(place),part,normalizeAiText(part),revision);if(offset+1800>=text.length)break;}
    }};
    for(const row of result.blocks){
      const locator={page:row.page,chapter:row.chapter,element:row.element,textOffset:row.textOffset,box:row.box,blockId:row.id,sourceId:row.id};
      put.run(assetId+':'+feature+':'+row.id,assetId,feature,JSON.stringify(locator),row.text,normalizeAiText(row.text),revision);
    }
    for(const row of result.segments){
      const text=[row.label,row.text].filter(Boolean).join(' ');
      put.run(assetId+':'+feature+':'+row.id,assetId,feature,JSON.stringify({startMs:row.startMs,endMs:row.endMs,segmentId:row.id,sourceId:row.manualParentId??row.id}),text,normalizeAiText(text),revision);
    }
    if(result.summary)put.run(assetId+':'+feature+':summary'+suffix,assetId,feature,'{}',result.summary,normalizeAiText(result.summary),revision);
  }
  function documents(assetId,feature,result,revision){
    db.prepare('DELETE FROM ai_documents WHERE asset_id=? AND feature=?').run(assetId,feature);documentUnit(assetId,feature,result,revision);
  }
  function publishUnits(item,feature,inputStamp,modelId,source,limits){
    const now=Date.now();
    return transaction(db,()=>{
      const revision=(resultRow.get(item.id,feature)?.revision??0)+1,meta=empty(),tagCounts=new Map();
      meta.provenance={pipeline:1,model:limits?.model??{id:modelId},profileHash:limits?.profileHash??null,totalUnits:limits?.totalUnits??0,successfulUnits:0,failedUnits:[]};
      db.prepare(`INSERT INTO ai_results VALUES(?,?,?,?,?,?,?) ON CONFLICT(asset_id,feature)
        DO UPDATE SET revision=excluded.revision,input_stamp=excluded.input_stamp,model_id=excluded.model_id,
        result_json=excluded.result_json,updated_at=excluded.updated_at`)
        .run(item.id,feature,revision,inputStamp,modelId,JSON.stringify(meta),now);
      db.prepare('DELETE FROM ai_result_units WHERE asset_id=? AND feature=?').run(item.id,feature);
      db.prepare('DELETE FROM ai_documents WHERE asset_id=? AND feature=?').run(item.id,feature);
      const patch=JSON.parse(editRow.get(item.id,feature)?.patch_json??'{}');
      const insert=db.prepare('INSERT INTO ai_result_units VALUES(?,?,?,?)');
      for(const {unit,value}of source){
        if(value.errorCode){if(meta.provenance.failedUnits.length<2000)meta.provenance.failedUnits.push(unit);continue;}
        meta.provenance.successfulUnits++;meta.provenance.totalUnits=Math.max(meta.provenance.totalUnits,unit+1);
        const raw=validateAiResult(feature,value,limits);
        insert.run(item.id,feature,unit,JSON.stringify(raw));
        for(const row of [...raw.blocks,...raw.segments])db.prepare('INSERT INTO ai_result_locations VALUES(?,?,?,?)').run(item.id,feature,row.id,unit);
        documentUnit(item.id,feature,applyAiEdits(raw,patch),revision,':'+unit);
        for(const tag of raw.tags){const old=tagCounts.get(tag.normalized);tagCounts.set(tag.normalized,{tag,count:(old?.count??0)+1});}
        if(meta.summary.length<4000&&raw.summary)meta.summary=(meta.summary+'\n'+raw.summary).trim().slice(0,4000);
      }
      meta.tags=[...tagCounts.values()].sort((a,b)=>b.count-a.count).slice(0,64).map(row=>row.tag);
      db.prepare('UPDATE ai_results SET result_json=? WHERE asset_id=? AND feature=?').run(JSON.stringify(meta),item.id,feature);
      if(feature==='tags'){
        db.prepare("DELETE FROM asset_tags WHERE asset_id=? AND source='ai' AND rejected=0").run(item.id);
        for(const tag of meta.tags)db.prepare("INSERT OR IGNORE INTO asset_tags VALUES(?,?,NULL,?,?,?,'ai',0,?)")
          .run(randomUUID(),item.id,tag.label,tag.normalized,tag.category,now);
      }
      return read(item.id,feature,{limit:1});
    });
  }
  function publish(item,feature,inputStamp,modelId,value,limits){return publishUnits(item,feature,inputStamp,modelId,[{unit:0,value}],limits);}
  function edit(item,feature,userId,body,limits){
    const raw=resultRow.get(item.id,feature);if(!raw)throw httpError(409,'先に解析結果を作成してください。');
    if(typeof body?.requestId!=='string'||!/^[0-9a-f-]{36}$/i.test(body.requestId))throw httpError(422,'訂正操作の識別子を確認してください。');
    const payloadHash=aiHash({feature,revision:body.revision,resultRevision:body.resultRevision,patch:body.patch,dropUnresolved:body.dropUnresolved});
    return transaction(db,()=>{
      const old=db.prepare('SELECT * FROM ai_edit_history WHERE asset_id=? AND feature=? AND request_id=?').get(item.id,feature,body.requestId);
      if(old){if(old.payload_hash!==payloadHash||old.user_id!==userId)throw httpError(409,'同じ操作番号に異なる訂正があります。');return read(item.id,feature,{limit:1});}
      const current=editRow.get(item.id,feature);
      if(body.revision!==(current?.revision??0)||body.resultRevision!==raw.revision)throw httpError(409,'解析情報が更新されました。最新の内容を確認してください。');
      const base=empty();
      const keys={blocks:new Set(Object.keys(body.patch?.blocks??{})),segments:new Set(Object.keys(body.patch?.segments??{}))};
      for(const id of Object.keys(body.patch?.splits??{}))keys.segments.add(id);
      const affected=new Set();for(const key of ['blocks','segments'])for(const id of keys[key]){const location=db.prepare('SELECT unit FROM ai_result_locations WHERE asset_id=? AND feature=? AND block_id=?').get(item.id,feature,id);if(location)affected.add(location.unit);}
      const originals=db.prepare('SELECT result_json FROM ai_result_units WHERE asset_id=? AND feature=? AND unit=?');
      for(const unit of affected){const value=JSON.parse(originals.get(item.id,feature,unit).result_json);for(const key of ['blocks','segments'])base[key].push(...value[key].filter(b=>keys[key].has(b.id)));}
      const delta=validateAiPatch(body.patch??{},base,limits),prior=JSON.parse(current?.patch_json??'{}');
      const patch={blocks:merge(prior.blocks,delta.blocks),segments:merge(prior.segments,delta.segments),splits:{...prior.splits,...delta.splits}};
      const drop=body.dropUnresolved??[];if(!Array.isArray(drop)||drop.length>2000||drop.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(id)))throw httpError(422,'確認済みにする訂正を選んでください。');
      for(const id of drop){if(db.prepare('SELECT 1 FROM ai_result_locations WHERE asset_id=? AND feature=? AND block_id=?').get(item.id,feature,id))throw httpError(409,'現在の認識情報に対応している訂正です。');if(!patch.blocks[id]&&!patch.segments[id]&&!patch.splits[id])throw httpError(422,'以前の訂正が見つかりません。');delete patch.blocks[id];delete patch.segments[id];delete patch.splits[id];}
      if(Buffer.byteLength(JSON.stringify(patch))>1024*1024)throw httpError(422,'訂正情報の量が上限を超えています。');
      const revision=(current?.revision??0)+1,now=Date.now();
      db.prepare(`INSERT INTO ai_edits VALUES(?,?,?,?,?) ON CONFLICT(asset_id,feature)
        DO UPDATE SET revision=excluded.revision,patch_json=excluded.patch_json,updated_at=excluded.updated_at`).run(item.id,feature,revision,JSON.stringify(patch),now);
      db.prepare('INSERT INTO ai_edit_history VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),item.id,feature,userId,body.requestId,payloadHash,revision,JSON.stringify(patch),now);
      for(const unit of affected){const value=JSON.parse(originals.get(item.id,feature,unit).result_json);for(const row of [...value.blocks,...value.segments])db.prepare("DELETE FROM ai_documents WHERE asset_id=? AND feature=? AND (id=? OR json_extract(locator_json,'$.sourceId')=?)").run(item.id,feature,item.id+':'+feature+':'+row.id,row.id);documentUnit(item.id,feature,applyAiEdits(value,patch),raw.revision,':'+unit);}
      return read(item.id,feature,{limit:1});
    });
  }
  function restore(item,feature,userId,body,limits){
    if(!/^[0-9a-f-]{36}$/i.test(body?.requestId??'')||!Number.isSafeInteger(body.restoreRevision)||body.restoreRevision<0)throw httpError(422,'戻す訂正履歴を確認してください。');
    const payloadHash=aiHash({operation:'restore',revision:body.revision,resultRevision:body.resultRevision,restoreRevision:body.restoreRevision});
    return transaction(db,()=>{
      const repeated=db.prepare('SELECT * FROM ai_edit_history WHERE asset_id=? AND feature=? AND request_id=?').get(item.id,feature,body.requestId);
      if(repeated){if(repeated.payload_hash!==payloadHash||repeated.user_id!==userId)throw httpError(409,'同じ操作番号に異なる内容があります。');return read(item.id,feature,{limit:1});}
      const raw=resultRow.get(item.id,feature),current=editRow.get(item.id,feature),history=body.restoreRevision===0?{patch_json:'{}'}:db.prepare('SELECT * FROM ai_edit_history WHERE asset_id=? AND feature=? AND revision=?').get(item.id,feature,body.restoreRevision);
      if(!raw||!history)throw httpError(404,'訂正履歴が見つかりません。');
      if(body.revision!==(current?.revision??0)||body.resultRevision!==raw.revision)throw httpError(409,'解析情報が更新されました。最新の内容を確認してください。');
      const patch=JSON.parse(history.patch_json),before=JSON.parse(current?.patch_json??'{}'),affected=new Set();
      for(const value of [patch,before])for(const key of ['blocks','segments','splits'])for(const id of Object.keys(value[key]??{})){const row=db.prepare('SELECT unit FROM ai_result_locations WHERE asset_id=? AND feature=? AND block_id=?').get(item.id,feature,id);if(row)affected.add(row.unit);}
      const revision=(current?.revision??0)+1,now=Date.now();db.prepare('INSERT INTO ai_edits VALUES(?,?,?,?,?) ON CONFLICT(asset_id,feature) DO UPDATE SET revision=excluded.revision,patch_json=excluded.patch_json,updated_at=excluded.updated_at').run(item.id,feature,revision,history.patch_json,now);
      db.prepare('INSERT INTO ai_edit_history VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),item.id,feature,userId,body.requestId,payloadHash,revision,history.patch_json,now);
      for(const unit of affected){const value=JSON.parse(db.prepare('SELECT result_json FROM ai_result_units WHERE asset_id=? AND feature=? AND unit=?').get(item.id,feature,unit).result_json),effective=applyAiEdits(value,patch);validateAiResult(feature,effective,limits);
        for(const row of [...value.blocks,...value.segments])db.prepare("DELETE FROM ai_documents WHERE asset_id=? AND feature=? AND (id=? OR json_extract(locator_json,'$.sourceId')=?)").run(item.id,feature,item.id+':'+feature+':'+row.id,row.id);documentUnit(item.id,feature,effective,raw.revision,':'+unit);
      }
      return read(item.id,feature,{limit:1});
    });
  }
  function setTags(item,userId,body,canEdit,{withinTransaction=false}={}){
    const personal=body.scope==='personal';
    if(!personal&&body.scope!=='shared')throw httpError(422,'タグの保存範囲を選んでください。');
    if(!personal&&!canEdit)throw httpError(403,'共有タグを編集する権限がありません。');
    const accepted=validateAiTags(body.tags),rejected=validateAiTags(body.rejected??[]),adopted=new Set(validateAiTags(body.adopted??[]).map(t=>t.normalized));
    if([...adopted].some(tag=>!accepted.some(t=>t.normalized===tag)))throw httpError(422,'採用するタグを現在のタグから選んでください。');
    const owner=personal?userId:null,feature=personal?'personal-tags:'+userId:'shared-tags';
    return (withinTransaction?work=>work():work=>transaction(db,work))(()=>{
      const revision=editRow.get(item.id,feature)?.revision??0;
      if(body.revision!==revision)throw httpError(409,'タグが更新されました。最新の内容を確認してください。');
      const before=db.prepare('SELECT * FROM asset_tags WHERE asset_id=? AND user_id IS ?').all(item.id,owner);
      for(const old of before)if(old.source==='ai'&&!old.rejected&&!accepted.some(t=>t.normalized===old.normalized)&&!rejected.some(t=>t.normalized===old.normalized))rejected.push({label:old.label,normalized:old.normalized,category:old.category});
      const now=Date.now();db.prepare('DELETE FROM asset_tags WHERE asset_id=? AND user_id IS ?').run(item.id,owner);
      const put=db.prepare('INSERT INTO asset_tags VALUES(?,?,?,?,?,?,?,?,?)');
      for(const tag of accepted)put.run(randomUUID(),item.id,owner,tag.label,tag.normalized,tag.category,adopted.has(tag.normalized)?'manual':before.find(old=>old.normalized===tag.normalized&&!old.rejected)?.source??'manual',0,now);
      for(const tag of rejected){
        if(accepted.some(row=>row.normalized===tag.normalized))throw httpError(422,'採用と非表示のタグが重複しています。');
        put.run(randomUUID(),item.id,owner,tag.label,tag.normalized,tag.category,'manual',1,now);
      }
      db.prepare(`INSERT INTO ai_edits VALUES(?,?,?,'{}',?) ON CONFLICT(asset_id,feature)
        DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`).run(item.id,feature,revision+1,now);
      return {tags:tags(item.id,userId),revision:revision+1};
    });
  }
  return {read,units,original:(id,feature,offset=0)=>{const row=db.prepare('SELECT result_json FROM ai_result_units WHERE asset_id=? AND feature=? AND unit>=? ORDER BY unit LIMIT 1').get(id,feature,offset);return row?JSON.parse(row.result_json):null;},publish,publishUnits,edit,restore,tags,setTags,documents,
    tagRevision:(id,user,scope)=>editRow.get(id,scope==='personal'?'personal-tags:'+user:'shared-tags')?.revision??0};
}
