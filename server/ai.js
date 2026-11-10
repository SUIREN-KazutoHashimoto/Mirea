import {randomUUID} from 'node:crypto';
import {httpError} from './security.js';
import {transaction} from './database.js';
import {AI_FEATURES,aiText,aiHash,normalizeAiText,applyAiEdits} from './ai-validation.js';
import {createAiStore} from './ai-store.js';
import {createAiSettings} from './ai-settings.js';
import {AI_MODEL_CATALOG,createAiModels,previewAiModel,validateModelManifest} from './ai-models.js';
import {createAiRuntime} from './ai-runtime.js';
import {createAiJobs} from './ai-jobs.js';
import {aiFeatureApplies} from './ai-input.js';
import {searchAiLibrary,validateAiSearch} from './ai-search.js';
import {createAiBatches} from './ai-batches.js';
import {registerAiTags} from './ai-tags.js';
import {exportAi} from './ai-export.js';
import {createAiSelfTest} from './ai-self-test.js';
import {registerAiNotices} from './ai-notices.js';

const DAY=86400000;
export async function registerAi(app,context) {
  const {db,dataDir,authenticate,findItem,membership,requireShelfUnlock,adminAccess,maintenance,options={}}=context;
  const settings=createAiSettings(db,options.aiEnvironment??process.env),store=createAiStore(db);
  const models=createAiModels({db,dataDir,fetcher:options.aiModelFetch,authorized:adminAccess.isAdmin,inUse:id=>runtime.uses?.(id)});
  const runtime=options.aiRuntime??createAiRuntime({settings:()=>settings.value});
  const selfTest=createAiSelfTest({dataDir,models,runtime,settings,maintenance});
  const jobs=createAiJobs({...context,settings,models,runtime,store,enabledUser:adminAccess.enabled,
    resolveInput:options.aiResolveInput,analyzeUnit:options.aiAnalyzeUnit});
  const batches=createAiBatches({db,enqueue:jobs.enqueue,enabledUser:adminAccess.enabled,available:()=>settings.value.enabled&&!maintenance.locked});
  const auth={onRequest:async req=>authenticate(req),preHandler:async req=>authenticate(req)};
  const admin={onRequest:async req=>adminAccess.requireAdmin(req),preHandler:async req=>adminAccess.requireAdmin(req)};
  const previews=new Map(),queryEmbeddings=new Map();let exportsActive=0,queryRunning=0;
  const ensureAvailable=()=>{if(maintenance.locked)throw httpError(409,'保守処理中です。完了後に操作してください。');};
  function asset(req,id=req.params.id) {
    const item=findItem(id,req.user.id);
    requireShelfUnlock(req,item.shelf_id);return item;
  }
  function canEdit(item,userId) {return ['owner','editor'].includes(membership(item.shelf_id,userId));}
  function canAnalyze(item,userId) {return canEdit(item,userId)||item.uploaded_by===userId;}
  function shelf(req,id,roles) {membership(id,req.user.id,roles);requireShelfUnlock(req,id);return db.prepare('SELECT * FROM shelves WHERE id=?').get(id);}
  function publicJob(row) {
    if(!row)return null;
    return {id:row.id,assetId:row.asset_id,feature:row.feature,state:row.state,
      checkpoint:row.checkpoint,totalUnits:row.total_units,errorCode:row.error_code,
      createdAt:row.created_at,startedAt:row.started_at,updatedAt:row.updated_at,finishedAt:row.finished_at,elapsedMs:row.started_at?Math.max(0,(row.finished_at??Date.now())-row.started_at):0,estimatedAt:row.state==='running'&&row.checkpoint>0&&row.total_units>row.checkpoint?Date.now()+Math.max(0,row.updated_at-row.started_at)*(row.total_units-row.checkpoint)/row.checkpoint:null};
  }
  function info(item,userId,readOptions={limit:1}) {
    const features={};
    for(const feature of readOptions.feature?[readOptions.feature]:AI_FEATURES) {
      const result=store.read(item.id,feature,readOptions);
      if(result){const {patch,...publicResult}=result;features[feature]=publicResult;}
    }
    return {assetId:item.id,tags:store.tags(item.id,userId),features,
      tagRevisions:{shared:store.tagRevision(item.id,userId,'shared'),personal:store.tagRevision(item.id,userId,'personal')},
      jobs:db.prepare('SELECT * FROM ai_jobs WHERE asset_id=? ORDER BY created_at DESC LIMIT 50').all(item.id).map(publicJob),
      canEdit:canEdit(item,userId),canAnalyze:canAnalyze(item,userId),
      availableFeatures:AI_FEATURES.filter(feature=>aiFeatureApplies(feature,item.mime_type))};
  }
  function limits(item) {
    const media=db.prepare('SELECT metadata_json FROM media_ingest WHERE asset_id=?').get(item.id)??
      db.prepare('SELECT metadata_json FROM video_assets WHERE item_id=?').get(item.id)??
      db.prepare('SELECT metadata_json FROM audio_assets WHERE item_id=?').get(item.id);
    return {pageCount:item.page_count,durationMs:media?Math.round(JSON.parse(media.metadata_json).duration*1000):Number.MAX_SAFE_INTEGER};
  }

  registerAiNotices(app,auth);
  registerAiTags(app,{db,authenticate,asset,shelf,canEdit,store,ensureAvailable});
  app.get('/api/v1/ai/capabilities',auth,async()=>({enabled:settings.value.enabled,
    features:AI_FEATURES,availableFeatures:AI_FEATURES.filter(f=>settings.value.models[f]&&models.get(settings.value.models[f])?.state==='ready'),models:models.list().filter(model=>model.state==='ready').map(model=>({
      id:model.id,name:model.name,capabilities:model.capabilities})),backend:settings.value.backend}));
  app.get('/api/v1/admin/ai/settings',admin,async()=>({...settings.inspect(),
    runtime:await runtime.supported(),sessions:runtime.inspect(),jobs:jobs.inspect()}));
  app.patch('/api/v1/admin/ai/settings',admin,async req=>{
    ensureAvailable();await adminAccess.reauthenticate(req);
    const {currentPassword,...patch}=req.body??{};
    if(patch.models)for(const [feature,id]of Object.entries(patch.models)) {
      const model=models.get(id);
      if(!AI_FEATURES.includes(feature)||model?.state!=='ready'||!model?.capabilities.includes(feature))
        throw httpError(422,'解析種類に対応するモデルを選んでください。');
    }
    const result=settings.save(patch);adminAccess.audit(req,'ai.settings',null,{keys:Object.keys(patch)});
    void jobs.pump();return result;
  });
  app.get('/api/v1/admin/ai/self-test',admin,async()=>({test:selfTest.status}));
  app.post('/api/v1/admin/ai/self-test',admin,async(req,reply)=>{ensureAvailable();await adminAccess.reauthenticate(req);return reply.code(202).send({test:selfTest.start({music:req.body?.music===true})});});
  app.delete('/api/v1/admin/ai/self-test',admin,async req=>{await adminAccess.reauthenticate(req);return {test:selfTest.cancel()};});
  app.get('/api/v1/admin/ai/models',admin,async()=>({catalog:AI_MODEL_CATALOG,models:models.list()}));
  app.post('/api/v1/admin/ai/models/preview',admin,async req=>{
    const preview=await previewAiModel(req.body?.key,{fetcher:options.aiModelFetch});
    adminAccess.requireAdmin(req);
    const id=randomUUID();
    previews.set(id,{...preview,userId:req.user.id,expiresAt:Date.now()+15*60000});
    while(previews.size>32)previews.delete(previews.keys().next().value);
    return {...preview,previewId:id};
  });
  app.post('/api/v1/admin/ai/models',admin,async(req,reply)=>{
    ensureAvailable();await adminAccess.reauthenticate(req);
    const preview=previews.get(req.body?.previewId);
    if(!preview||preview.expiresAt<Date.now()||preview.userId!==req.user.id||
        req.body?.acceptTerms!==true||req.body?.acceptanceHash!==preview.acceptanceHash)
      throw httpError(409,'取得するモデルと利用条件を確認してください。');
    const result=models.accept(preview.manifest,req.user.id,preview.acceptanceHash);
    adminAccess.audit(req,'ai.model.install',result.id,{key:result.key,revision:result.revision});
    return reply.code(202).send({model:result});
  });
  app.post('/api/v1/admin/ai/models/import',admin,async(req,reply)=>{
    ensureAvailable();await adminAccess.reauthenticate(req);if(req.body?.acceptTerms!==true)throw httpError(422,'モデルの利用条件を確認してください。');
    const manifest=validateModelManifest(req.body.manifest),acceptanceHash=aiHash({id:manifest.id,license:manifest.license});
    const model=models.accept(manifest,req.user.id,acceptanceHash,{localOnly:true});adminAccess.audit(req,'ai.model.import',model.id,{key:model.key,revision:model.revision});return reply.code(202).send({model});
  });
  app.post('/api/v1/admin/ai/models/:id/:action',admin,async(req,reply)=>{
    ensureAvailable();await adminAccess.reauthenticate(req);
    if(req.params.action==='resume')return reply.code(202).send({model:models.start(req.params.id)});
    if(req.params.action==='pause')return {model:models.pause(req.params.id)};
    if(req.params.action==='remove'){await models.remove(req.params.id);adminAccess.audit(req,'ai.model.remove',req.params.id);return reply.code(204).send();}
    throw httpError(404,'モデルの操作が見つかりません。');
  });

  app.get('/api/v1/shelves/:id/ai',auth,async req=>{
    const target=shelf(req,req.params.id),policy=db.prepare('SELECT * FROM ai_policies WHERE shelf_id=?').get(target.id);
    return {enabled:Boolean(policy?.enabled),features:JSON.parse(policy?.features_json??'[]'),revision:policy?.revision??0,
      canEdit:membership(target.id,req.user.id)==='owner'};
  });
  app.put('/api/v1/shelves/:id/ai',auth,async req=>{
    ensureAvailable();const target=shelf(req,req.params.id,['owner']),body=req.body;
    if(typeof body?.enabled!=='boolean'||!Array.isArray(body.features)||body.features.length>6||
        body.features.some(feature=>!AI_FEATURES.includes(feature)))throw httpError(422,'自動解析する内容を選んでください。');
    return transaction(db,()=>{
      const old=db.prepare('SELECT * FROM ai_policies WHERE shelf_id=?').get(target.id);
      if(body.revision!==(old?.revision??0))throw httpError(409,'本棚の解析設定が変更されました。');
      const revision=(old?.revision??0)+1,enabledSince=old?.enabled?old.updated_at:Date.now();
      db.prepare(`INSERT INTO ai_policies VALUES(?,?,?,?,?) ON CONFLICT(shelf_id)
        DO UPDATE SET enabled=excluded.enabled,features_json=excluded.features_json,
        revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(target.id,Number(body.enabled),JSON.stringify([...new Set(body.features)]),revision,enabledSince);
      if(!body.enabled)db.prepare("UPDATE ai_jobs SET state='paused' WHERE automatic=1 AND asset_id IN (SELECT id FROM items WHERE shelf_id=?) AND state IN ('queued','resource-wait','dependency-wait')").run(target.id);
      return {enabled:body.enabled,features:body.features,revision};
    });
  });

  app.get('/api/v1/items/:id/ai',auth,async req=>info(asset(req),req.user.id));
  app.get('/api/v1/items/:id/ai/:feature',auth,async req=>{
    const item=asset(req),offset=Number(req.query.offset??0);if(!AI_FEATURES.includes(req.params.feature)||!Number.isSafeInteger(offset)||offset<0)throw httpError(422,'解析結果の取得位置を確認してください。');const value=store.read(item.id,req.params.feature,{offset,limit:1});if(value&&req.query.original==='true'){if(!canEdit(item,req.user.id))throw httpError(403,'認識情報を編集する権限がありません。');value.original=store.original(item.id,req.params.feature,offset);}return value;
  });
  app.put('/api/v1/items/:id/ai/tags',auth,async req=>{
    ensureAvailable();const item=asset(req);
    return store.setTags(item,req.user.id,req.body??{},canEdit(item,req.user.id));
  });
  app.get('/api/v1/items/:id/ai/:feature/edits',auth,async req=>{
    const item=asset(req);if(!canEdit(item,req.user.id))throw httpError(403,'訂正履歴を確認する権限がありません。');if(!AI_FEATURES.includes(req.params.feature))throw httpError(422,'解析の種類を確認してください。');
    if(req.query.revision!==undefined){const revision=Number(req.query.revision);if(!Number.isSafeInteger(revision)||revision<0)throw httpError(422,'訂正履歴の版を確認してください。');if(revision===0)return {revision:0,patch:{}};const row=db.prepare('SELECT revision,created_at,patch_json FROM ai_edit_history WHERE asset_id=? AND feature=? AND revision=?').get(item.id,req.params.feature,revision);if(!row)throw httpError(404,'訂正履歴が見つかりません。');return {revision:row.revision,createdAt:row.created_at,patch:JSON.parse(row.patch_json)};}
    const offset=Number(req.query.offset??0);if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw httpError(422,'履歴の取得位置を確認してください。');const rows=db.prepare('SELECT revision,created_at createdAt FROM ai_edit_history WHERE asset_id=? AND feature=? ORDER BY revision DESC LIMIT 51 OFFSET ?').all(item.id,req.params.feature,offset);return {edits:rows.slice(0,50),hasMore:rows.length>50,nextOffset:offset+Math.min(rows.length,50)};
  });
  app.post('/api/v1/items/:id/ai/:feature/edits',auth,async req=>{
    ensureAvailable();const item=asset(req);if(!canEdit(item,req.user.id))throw httpError(403,'訂正を戻す権限がありません。');if(!AI_FEATURES.includes(req.params.feature))throw httpError(422,'解析の種類を確認してください。');const result=store.restore(item,req.params.feature,req.user.id,req.body??{},limits(item));if(settings.value.enabled&&settings.value.models.embedding)await jobs.enqueue(item,req.user.id,['embedding'],{requestId:randomUUID(),regenerate:true});return result;
  });
  app.patch('/api/v1/items/:id/ai/:feature',auth,async req=>{
    ensureAvailable();const item=asset(req);
    if(!canEdit(item,req.user.id))throw httpError(403,'認識情報を編集する権限がありません。');
    const result=store.edit(item,req.params.feature,req.user.id,req.body??{},limits(item));
    if(settings.value.enabled&&settings.value.models.embedding)
      await jobs.enqueue(item,req.user.id,['embedding'],{requestId:randomUUID(),regenerate:true});
    return result;
  });
  app.post('/api/v1/items/:id/ai/jobs',auth,async(req,reply)=>{
    ensureAvailable();const item=asset(req);
    if(!canAnalyze(item,req.user.id))throw httpError(403,'解析を依頼する権限がありません。');
    if(!settings.value.enabled)throw httpError(409,'管理者がAI機能を準備すると利用できます。');
    const result=await jobs.enqueue(item,req.user.id,req.body?.features,
      {requestId:req.body?.requestId,regenerate:req.body?.regenerate===true});
    authenticate(req);asset(req);return reply.code(202).send(result);
  });
  app.post('/api/v1/ai/analyze',auth,async(req,reply)=>{
    ensureAvailable();const body=req.body??{};
    if(!settings.value.enabled)throw httpError(409,'管理者がAI機能を準備すると利用できます。');
    if(body.shelfId){shelf(req,body.shelfId,['owner']);if(body.seriesId&&!db.prepare('SELECT 1 FROM series WHERE id=? AND shelf_id=?').get(body.seriesId,body.shelfId))throw httpError(404,'シリーズが見つかりません。');return reply.code(202).send(batches.create(req.user.id,body));}
    if(Array.isArray(body.assetIds)){for(const id of body.assetIds){const item=asset(req,id);if(!canAnalyze(item,req.user.id))throw httpError(403,'解析対象を確認してください。');}return reply.code(202).send(batches.create(req.user.id,body));}
    throw httpError(422,'解析する本棚・シリーズ・作品を選んでください。');
  });

  async function listJobs(req,adminView=false) {
    const limit=Number(req.query?.limit??50),offset=Number(req.query?.offset??0);if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>100000)throw httpError(422,'ジョブの取得位置を確認してください。');
    const where=["m.user_id=?","s.private=0"],values=[req.user.id];
    if(req.query?.shelfId){shelf(req,req.query.shelfId);where[1]='i.shelf_id=?';values.push(req.query.shelfId);}
    if(!adminView){where.push('j.requester_id=?');values.push(req.user.id);}
    if(req.query?.state==='active')where.push("j.state IN ('queued','running','paused','resource-wait','dependency-wait')");else if(req.query?.state==='attention')where.push("j.state IN ('failed','partial')");else if(req.query?.state){if(!['complete','partial','failed','cancelled','queued','running','paused','resource-wait','dependency-wait'].includes(req.query.state))throw httpError(422,'ジョブの状態を選んでください。');where.push('j.state=?');values.push(req.query.state);}
    const rows=db.prepare(`SELECT j.*,i.title,i.shelf_id FROM ai_jobs j JOIN items i ON i.id=j.asset_id
      JOIN shelves s ON s.id=i.shelf_id JOIN memberships m ON m.shelf_id=i.shelf_id
      WHERE ${where.join(' AND ')} ORDER BY j.created_at DESC LIMIT ? OFFSET ?`).all(...values,limit+1,offset);
    return {jobs:rows.slice(0,limit).map(row=>({...publicJob(row),title:row.title,shelfId:row.shelf_id})),hasMore:rows.length>limit};
  }
  app.get('/api/v1/ai/batches',auth,async req=>{if(req.query.shelfId)shelf(req,req.query.shelfId);return {batches:batches.list(req.user.id,req.query.shelfId)};});
  app.post('/api/v1/ai/batches/:id/:action',auth,async req=>batches.control(req.user.id,req.params.id,req.params.action));
  app.get('/api/v1/ai/jobs',auth,req=>listJobs(req));
  app.get('/api/v1/admin/ai/jobs',admin,req=>listJobs(req,true));
  app.post('/api/v1/ai/jobs/:id/:action',auth,async req=>{
    ensureAvailable();const job=jobs.get(req.params.id);
    if(!job)throw httpError(404,'解析ジョブが見つかりません。');
    const item=asset(req,job.asset_id);
    if(job.requester_id!==req.user.id&&!canEdit(item,req.user.id))throw httpError(403,'解析ジョブを操作する権限がありません。');
    return {job:publicJob(jobs.control(job.id,req.params.action))};
  });

  app.post('/api/v1/ai/search',{...auth,bodyLimit:16384},async req=>{
    const body=validateAiSearch(req.body??{}),scope=body.scope;
    if(scope.shelfId)shelf(req,scope.shelfId);
    if(scope.seriesId) {
      const series=db.prepare('SELECT * FROM series WHERE id=?').get(scope.seriesId);
      if(!series)throw httpError(404,'シリーズが見つかりません。');
      shelf(req,series.shelf_id);scope.shelfId=series.shelf_id;
    }
    let vector,vectorSpace,semanticPending=false;
    const modelId=settings.value.models.embedding;
    if(body.mode==='semantic'&&body.query&&modelId) {
      try {
        const model=models.resolve(modelId);
        const query=aiText(body.query,500),key=aiHash({model:model.id,user:req.user.id,query});let entry=queryEmbeddings.get(key);if(entry?.done&&entry.expires<Date.now()){queryEmbeddings.delete(key);entry=null;}
        if(!entry&&queryRunning<4){
          entry={expires:Date.now()+60000};queryRunning++;
          entry.promise=runtime.embed(model,['Instruct: Retrieve relevant media content.'+String.fromCharCode(10)+'Query: '+query],{timeout:5000,interactive:true}).then(rows=>{entry.vector=rows[0];entry.done=true;entry.expires=Date.now()+60000;return rows[0];}).catch(error=>{entry.done=true;entry.retryable=error.code==='AI_RESOURCE_WAIT';entry.expires=Date.now()+1000;return null;}).finally(()=>queryRunning--);
          queryEmbeddings.set(key,entry);while(queryEmbeddings.size>64){const remove=[...queryEmbeddings].find(([,v])=>v.done);if(!remove)break;queryEmbeddings.delete(remove[0]);}
        }
        if(!entry)throw Object.assign(Error('Search inference busy'),{code:'AI_RESOURCE_WAIT'});
        vector=entry.vector??await Promise.race([entry.promise,new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),700);timer.unref();})]);if(vector)vectorSpace=model.id;else semanticPending=!entry.done||Boolean(entry.retryable);
      }catch{/* Text search responds within the interactive budget. */}
    }
    const result=await searchAiLibrary({dataDir,userId:req.user.id,query:body.query,mode:body.mode,
      tags:body.tags,tagMode:body.tagMode,limit:body.limit,offset:body.offset,scope,vector,vectorSpace});
    authenticate(req);if(scope.shelfId)shelf(req,scope.shelfId);
    result.items=result.items.flatMap(row=>{try{const item=asset(req,row.assetId);if(!scope.shelfId&&db.prepare('SELECT private FROM shelves WHERE id=?').get(item.shelf_id)?.private)return [];return [{...row,item:context.publicItem?{...context.publicItem(item),role:membership(item.shelf_id,req.user.id)}:undefined}];}catch{return [];}});
    return {...result,semanticPending};
  });
  app.get('/api/v1/items/:id/ai/timeline',auth,async req=>{
    const item=asset(req),features={};for(const feature of ['structure','chapters']){const meta=store.read(item.id,feature,{limit:1});if(!meta)continue;const segments=[];for(const {value}of store.units(item.id,feature)){const effective=applyAiEdits(value,meta.patch);segments.push(...effective.segments);if(segments.length>5000)throw httpError(422,'区間情報が多すぎます。内容画面から確認してください。');}const {patch,...publicMeta}=meta;features[feature]={...publicMeta,result:{tags:[],blocks:[],segments,summary:''},hasMore:false};}
    const now=Date.now(),pack={version:1,userId:req.user.id,assetId:item.id,features,serverTime:now,expiresAt:Math.min(req.session.expires_at,now+7*DAY)};return {...pack,checksum:aiHash(pack)};
  });
  function contentPack(item,userId,session,feature,offset=0){
    const now=Date.now(),value=info(item,userId,{offset,limit:1,feature});
    const pack={version:1,userId,assetId:item.id,shelfId:item.shelf_id,...(feature?{feature,offset}:{}),inputGeneration:Object.values(value.features).map(row=>row.inputStamp),...value,serverTime:now,expiresAt:Math.min(session.expires_at,now+7*DAY)};
    return {...pack,checksum:aiHash(pack)};
  }
  app.get('/api/v1/items/:id/ai/packs',auth,async req=>{
    const item=asset(req),offset=Number(req.query.offset??0),feature=req.query.feature;
    if(!AI_FEATURES.includes(feature)||!Number.isSafeInteger(offset)||offset<0)throw httpError(422,'保存する解析情報を確認してください。');
    const packs=[];let position=offset,size=0;
    for(let i=0;i<8;i++){const pack=contentPack(item,req.user.id,req.session,feature,position),bytes=Buffer.byteLength(JSON.stringify(pack));if(packs.length&&size+bytes>4*1024*1024)break;packs.push(pack);size+=bytes;const data=pack.features[feature];if(!data?.hasMore)break;if(!Number.isSafeInteger(data.nextOffset)||data.nextOffset<=position)throw httpError(500,'解析情報の取得位置が不正です。');position=data.nextOffset;}
    return {packs};
  });
  app.get('/api/v1/items/:id/ai/pack',auth,async req=>{
    const item=asset(req),now=Date.now(),offset=Number(req.query.offset??0),feature=req.query.feature;
    if(!Number.isSafeInteger(offset)||offset<0||feature&&!AI_FEATURES.includes(feature))throw httpError(422,'保存する解析情報を確認してください。');
    return contentPack(item,req.user.id,req.session,feature,offset);
  });
  app.get('/api/v1/items/:id/ai/export',auth,async(req,reply)=>{
    const item=asset(req);
    if(exportsActive>=2)throw httpError(429,'別の解析情報を書き出しています。完了後に再試行してください。');
    return exportAi(req,reply,{dataDir,item,maintenance,authorize:()=>{authenticate(req);asset(req);},onOpen:()=>exportsActive++,onClose:()=>exportsActive--});
  });
  app.get('/api/v1/items/:id/ai/related',auth,async req=>{
    const item=asset(req),labels=store.tags(item.id,req.user.id).filter(tag=>!tag.rejected).slice(0,5).map(tag=>tag.label);
    const scope=db.prepare('SELECT private FROM shelves WHERE id=?').get(item.shelf_id)?.private?{shelfId:item.shelf_id}:{};
    const found=new Map();
    for(const tag of labels) {
      const result=await searchAiLibrary({dataDir,userId:req.user.id,scope,tags:[tag],limit:10});
      for(const row of result.items)if(row.assetId!==item.id)found.set(row.assetId,{...row,reason:tag});
    }
    authenticate(req);asset(req);
    return {items:[...found.values()].slice(0,20).flatMap(row=>{try{const candidate=asset(req,row.assetId);if(!scope.shelfId&&db.prepare('SELECT private FROM shelves WHERE id=?').get(candidate.shelf_id)?.private)return [];return [{...row,item:context.publicItem?{...context.publicItem(candidate),role:membership(candidate.shelf_id,req.user.id)}:undefined}];}catch{return [];}})};
  });

  app.get('/api/v1/ai/lists',auth,async req=>({lists:db.prepare('SELECT * FROM ai_smart_lists WHERE user_id=? ORDER BY updated_at DESC')
    .all(req.user.id).flatMap(row=>{const filter=JSON.parse(row.filter_json),shelfId=filter.scope?.shelfId??(filter.scope?.seriesId?db.prepare('SELECT shelf_id FROM series WHERE id=?').get(filter.scope.seriesId)?.shelf_id:null);if(shelfId){try{shelf(req,shelfId);if(db.prepare('SELECT private FROM shelves WHERE id=?').get(shelfId)?.private&&req.query.shelfId!==shelfId)return [];}catch{return [];}}return [{id:row.id,title:row.title,revision:row.revision,filter}];})}));
  app.post('/api/v1/ai/lists',auth,async(req,reply)=>{
    const title=aiText(req.body?.title,120),filter=req.body?.filter;
    if(!title||!filter||typeof filter!=='object'||Array.isArray(filter)||Buffer.byteLength(JSON.stringify(filter))>4096||
      Object.keys(filter).some(key=>!['query','scope','tags','mode','tagMode'].includes(key)))throw httpError(422,'保存する検索条件を確認してください。');
    if(db.prepare('SELECT COUNT(*) n FROM ai_smart_lists WHERE user_id=?').get(req.user.id).n>=200)
      throw httpError(409,'保存した検索条件が上限に達しています。');
    validateAiSearch(filter);if(filter.scope?.shelfId)shelf(req,filter.scope.shelfId);
    const id=randomUUID(),now=Date.now();
    db.prepare('INSERT INTO ai_smart_lists VALUES(?,?,?,?,1,?,?)').run(id,req.user.id,title,JSON.stringify(filter),now,now);
    return reply.code(201).send({id,title,filter,revision:1});
  });
  app.patch('/api/v1/ai/lists/:id',auth,async req=>{
    const row=db.prepare('SELECT * FROM ai_smart_lists WHERE id=? AND user_id=?').get(req.params.id,req.user.id);if(!row)throw httpError(404,'保存した検索条件が見つかりません。');
    if(req.body?.revision!==row.revision)throw httpError(409,'検索条件が更新されました。開き直してください。');const title=aiText(req.body.title,120),filter=validateAiSearch(req.body.filter);if(!title)throw httpError(422,'名前を入力してください。');if(filter.scope.shelfId)shelf(req,filter.scope.shelfId);
    const {offset,limit,...saved}=filter;db.prepare('UPDATE ai_smart_lists SET title=?,filter_json=?,revision=revision+1,updated_at=? WHERE id=?').run(title,JSON.stringify(saved),Date.now(),row.id);return {id:row.id,title,filter:saved,revision:row.revision+1};
  });
  app.delete('/api/v1/ai/lists/:id',auth,async(req,reply)=>{
    db.prepare('DELETE FROM ai_smart_lists WHERE id=? AND user_id=?').run(req.params.id,req.user.id);
    return reply.code(204).send();
  });

  app.addHook('onRequest',async req=>{
    if(/\/(?:content|pages|renditions|hls|uploads)(?:\/|\?|$)/.test(req.url))jobs.prioritizeForeground();
  });
  app.addHook('onClose',async()=>{await batches.close();await selfTest.close();await jobs.close();await runtime.close();await models.close();});
  return {jobs,models,runtime,settings,store,cancelAsset:jobs.cancelAsset,get busy(){return jobs.busy||models.busy||selfTest.busy||exportsActive>0;}};
}
