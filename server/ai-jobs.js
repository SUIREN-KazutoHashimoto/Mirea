import {randomUUID} from 'node:crypto';
import {mkdir,rm,statfs,lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import {transaction} from './database.js';
import {httpError} from './security.js';
import {AI_FEATURES,aiHash,validateAiResult,normalizeAiText} from './ai-validation.js';
import {resolveAiInput,aiUnitCount,analyzeAiUnit,aiFeatureApplies} from './ai-input.js';

const activeStates=['queued','running','paused','resource-wait','dependency-wait'];
const safeCode=error=>typeof error?.code==='string'&&/^AI_[A-Z_]{1,60}$/.test(error.code)?error.code:
  error?.code==='ENOSPC'?'AI_STORAGE_FULL':error?.name==='AbortError'?'AI_INTERRUPTED':'AI_ANALYSIS_FAILED';

export function createAiJobs({db,dataDir,settings,models,runtime,store,maintenance,jobPool,
  enabledUser,resolveInput=resolveAiInput,analyzeUnit=analyzeAiUnit,...context}) {
  const running=new Map(),root=join(dataDir,'ai','work');
  let closing=false,pumping=false,foregroundUntil=0,lastUser=null,scanning=null,preparing=true,automaticCursor=null;
  const workId=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  async function directory(path){await mkdir(path,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Object.assign(Error('Analysis workspace invalid'),{code:'AI_WORKSPACE_INVALID'});}
  const prepared=(async()=>{await directory(join(dataDir,'ai'));await directory(root);for(const entry of await readdir(root,{withFileTypes:true})){if(!workId.test(entry.name)||running.has(entry.name))continue;if(entry.isSymbolicLink()||!entry.isDirectory())continue;await rm(join(root,entry.name),{recursive:true,force:true});}})().finally(()=>{preparing=false;});prepared.catch(()=>{});
  const get=id=>db.prepare('SELECT * FROM ai_jobs WHERE id=?').get(id);
  const allowed=job=>{
    const item=db.prepare('SELECT * FROM items WHERE id=?').get(job.asset_id);
    if(!item||!job.requester_id||!enabledUser(job.requester_id))return null;
    const role=db.prepare('SELECT role FROM memberships WHERE shelf_id=? AND user_id=?').get(item.shelf_id,job.requester_id)?.role;
    if(!role||!['owner','editor'].includes(role)&&item.uploaded_by!==job.requester_id)return null;
    if(job.automatic&&!db.prepare('SELECT 1 FROM ai_policies WHERE shelf_id=? AND enabled=1').get(item.shelf_id))return null;
    return item;
  };
  function setState(id,state,error=null) {
    const now=Date.now();
    db.prepare('UPDATE ai_jobs SET state=?,error_code=?,updated_at=?,finished_at=? WHERE id=?')
      .run(state,error,now,['complete','partial','failed','cancelled'].includes(state)?now:null,id);
  }
  function dependencies(job) {
    const prerequisites=job.feature==='chapters'?['transcript']:job.feature==='tags'?['ocr','transcript','structure']:
      job.feature==='embedding'?AI_FEATURES.filter(f=>f!=='embedding'):[];
    if(!prerequisites.length)return false;
    const rows=db.prepare("SELECT feature,state FROM ai_jobs WHERE asset_id=? AND id!=? AND state IN ('queued','running','paused','resource-wait','dependency-wait')").all(job.asset_id,job.id);
    return rows.some(row=>prerequisites.includes(row.feature));
  }
  function profileFor(id,feature,modelId){const config=settings.value;return aiHash({modelId,feature,pipeline:1,contextTokens:config.contextTokens,outputTokens:config.outputTokens,...(feature==='embedding'?{results:db.prepare('SELECT feature,revision,updated_at FROM ai_results WHERE asset_id=? ORDER BY feature').all(id),edits:db.prepare('SELECT feature,revision,updated_at FROM ai_edits WHERE asset_id=? ORDER BY feature').all(id)}:{})});}
  async function enqueue(item,userId,features,{requestId,regenerate=false,automatic=false}={}) {
    if(!Array.isArray(features)||!features.length||features.length>AI_FEATURES.length||
        features.some(f=>!AI_FEATURES.includes(f)||!aiFeatureApplies(f,item.mime_type)))
      throw httpError(422,'この作品で利用できる解析を選んでください。');
    if(!requestId||!/^[0-9a-f-]{36}$/i.test(requestId))throw httpError(422,'解析依頼の識別子を確認してください。');
    const payloadHash=aiHash({item:item.id,features,regenerate,automatic});
    const prior=db.prepare('SELECT * FROM ai_requests WHERE user_id=? AND request_id=?').get(userId,requestId);
    if(prior){if(prior.payload_hash!==payloadHash)throw httpError(409,'同じ依頼番号の内容が異なります。');return JSON.parse(prior.response_json);}
    const requested=[...features];features=[...new Set([...features,...(features.includes('tags')&&item.mime_type.startsWith('audio/')?['transcript','structure'].filter(f=>settings.value.models[f]):[]),...(features.includes('chapters')&&settings.value.models.transcript?['transcript']:[])])];
    if(requested.includes('tags')&&item.mime_type.startsWith('audio/')&&!features.some(f=>f==='transcript'||f==='structure')&&!store.read(item.id,'transcript')&&!store.read(item.id,'structure'))throw httpError(409,'音声のタグ付けには、文字起こしまたは曲の構成用モデルを設定してください。');
    const input=await resolveInput({db,...context},item);
    const response=transaction(db,()=>{
      const role=db.prepare('SELECT role FROM memberships WHERE shelf_id=? AND user_id=?').get(item.shelf_id,userId)?.role;if(!enabledUser(userId)||!role||!['owner','editor'].includes(role)&&item.uploaded_by!==userId)throw httpError(403,'解析を依頼する権限が変わりました。');
      const live=db.prepare('SELECT * FROM items WHERE id=? AND shelf_id=?').get(item.id,item.shelf_id);
      if(!live)throw httpError(409,'作品の保存先が変わりました。もう一度確認してください。');
      const duplicate=db.prepare('SELECT * FROM ai_requests WHERE user_id=? AND request_id=?').get(userId,requestId);
      if(duplicate){if(duplicate.payload_hash!==payloadHash)throw httpError(409,'依頼内容が異なります。');return JSON.parse(duplicate.response_json);}
      const jobs=[];
      for(const feature of [...new Set(features)]) {
        const modelId=settings.value.models[feature]??'';
        const profileHash=profileFor(item.id,feature,modelId);
        const existing=db.prepare("SELECT * FROM ai_jobs WHERE asset_id=? AND feature=? AND input_stamp=? AND profile_hash=? AND state IN ('queued','running','paused','resource-wait','dependency-wait')").get(item.id,feature,input.stamp,profileHash);
        if(existing){jobs.push(existing.id);continue;}
        const published=store.read(item.id,feature);
        if(!regenerate&&published?.inputStamp===input.stamp&&published.modelId===modelId)continue;
        const id=randomUUID(),now=Date.now();
        db.prepare(`INSERT INTO ai_jobs(id,asset_id,requester_id,feature,model_id,input_stamp,profile_hash,
          state,automatic,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?,?)`)
          .run(id,item.id,userId,feature,modelId,input.stamp,profileHash,Number(automatic),now,now);
        jobs.push(id);
      }
      const value={jobIds:jobs};
      db.prepare('INSERT INTO ai_requests VALUES(?,?,?,?,?)').run(userId,requestId,payloadHash,JSON.stringify(value),Date.now());
      return value;
    });
    void safePump();return response;
  }
  function aggregate(job) {
    const output={tags:[],blocks:[],segments:[],summary:''},tagCounts=new Map(),summaries=[];
    for(const unit of db.prepare('SELECT result_json FROM ai_units WHERE job_id=? ORDER BY unit').iterate(job.id)) {
      const value=JSON.parse(unit.result_json);
      for(const tag of value.tags??[]) {
        const normalized=normalizeAiText(typeof tag==='string'?tag:tag.label),old=tagCounts.get(normalized);
        tagCounts.set(normalized,{tag,count:(old?.count??0)+1});
      }
      output.blocks.push(...value.blocks??[]);
      output.segments.push(...value.segments??[]);
      if(value.summary)summaries.push(value.summary);
    }
    output.tags=[...tagCounts.values()].sort((a,b)=>b.count-a.count).slice(0,64).map(row=>row.tag);
    output.summary=summaries.join('\n').slice(0,4000);
    output.segments.sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs);
    return output;
  }
  async function execute(job,controller) {
    if(!workId.test(job.id)){setState(job.id,'failed','AI_INPUT_UNAVAILABLE');return;}
    let item=allowed(job);
    if(!item){setState(job.id,'cancelled','AI_AUTHORITY_EXPIRED');return;}
    const signal=controller.signal,authorize=()=>{
      if(closing||signal.aborted)throw new DOMException('Analysis interrupted','AbortError');
      item=allowed(job);
      if(!item)throw Object.assign(Error('Analysis authority expired'),{code:'AI_AUTHORITY_EXPIRED'});
    };
    const guard=setInterval(()=>{if(!allowed(job))controller.abort();},1000);guard.unref();
    const folder=join(root,job.id);let ownsFolder=false;
    try {
      if(!workId.test(job.id))throw Object.assign(Error('Analysis identity invalid'),{code:'AI_INPUT_UNAVAILABLE'});
      await prepared;const prior=await lstat(folder).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});if(prior&&(prior.isSymbolicLink()||!prior.isDirectory()))throw Object.assign(Error('Analysis workspace invalid'),{code:'AI_WORKSPACE_INVALID'});if(prior)await rm(folder,{recursive:true,force:true});await directory(folder);ownsFolder=true;authorize();
      if(!job.model_id&&settings.value.models[job.feature]){const modelId=settings.value.models[job.feature],profileHash=profileFor(job.asset_id,job.feature,modelId);if(db.prepare("SELECT 1 FROM ai_jobs WHERE asset_id=? AND feature=? AND input_stamp=? AND profile_hash=? AND id!=? AND state IN ('queued','running','paused','resource-wait','dependency-wait')").get(job.asset_id,job.feature,job.input_stamp,profileHash,job.id)){setState(job.id,'cancelled','AI_SUPERSEDED');return;}job={...job,model_id:modelId,profile_hash:profileHash};db.prepare('UPDATE ai_jobs SET model_id=?,profile_hash=? WHERE id=?').run(modelId,profileHash,job.id);}
      const model=models.resolve(job.model_id);
      if(job.feature==='structure')model.stems=models.resolveByKey('music-stems');
      const weightBytes=model.files.reduce((n,f)=>n+f.size,0);
      if(weightBytes*1.25>settings.value.memoryMiB*1024**2)
        throw Object.assign(Error('Configured memory is insufficient'),{code:'AI_RESOURCE_WAIT'});
      const input=await resolveInput({db,...context},item);authorize();
      if(input.stamp!==job.input_stamp) {
        if(db.prepare("SELECT 1 FROM ai_jobs WHERE asset_id=? AND feature=? AND input_stamp=? AND profile_hash=? AND id!=? AND state IN ('queued','running','paused','resource-wait','dependency-wait')").get(job.asset_id,job.feature,input.stamp,job.profile_hash,job.id)){setState(job.id,'cancelled','AI_SUPERSEDED');return;}
        db.prepare('DELETE FROM ai_units WHERE job_id=?').run(job.id);
        db.prepare('UPDATE ai_jobs SET input_stamp=?,checkpoint=0 WHERE id=?').run(input.stamp,job.id);
        job={...job,input_stamp:input.stamp,checkpoint:0};
      }
      if(['transcript','structure','chapters'].includes(job.feature)&&!input.durationMs)
        throw Object.assign(Error('Media information not ready'),{code:'AI_DEPENDENCY_WAIT'});
      const documents=job.feature==='embedding'?db.prepare('SELECT id FROM ai_documents WHERE asset_id=? ORDER BY id').all(item.id):[];
      const total=aiUnitCount(job.feature,input,item,documents);
      db.prepare('UPDATE ai_jobs SET total_units=? WHERE id=?').run(total,job.id);
      const errors=[];
      for(let unit=job.checkpoint;unit<total;unit++) {
        authorize();
        const previous=db.prepare('SELECT result_json FROM ai_units WHERE job_id=? AND unit=?').get(job.id,unit);
        if(previous&&!JSON.parse(previous.result_json).errorCode)continue;
        if(get(job.id)?.state!=='running')break;
        if(maintenance.locked||Date.now()<foregroundUntil||!settings.value.enabled) {
          setState(job.id,'queued');return;
        }
        const free=await statfs(folder),temporary=job.feature==='structure'?input.durationMs/1000*44100*8+64*1024**2:64*1024**2;
        if(temporary>settings.value.temporaryMiB*1024**2)throw Object.assign(Error('Analysis scratch budget insufficient'),{code:'AI_TEMPORARY_LIMIT'});
        if(Number(free.bavail)*Number(free.bsize)<temporary+64*1024**2)
          throw Object.assign(Error('Temporary storage is full'),{code:'AI_STORAGE_FULL'});
        const unitFolder=join(folder,String(unit));
        try {
          let result;
          for(let attempt=0;attempt<2;attempt++){try{result=await analyzeUnit({context:{db,...context},item,input,feature:job.feature,unit,folder:unitFolder,model,runtime,store,signal,document:documents[unit]});if(job.feature!=='embedding')validateAiResult(job.feature,result,{pageCount:item.page_count,durationMs:input.durationMs||Number.MAX_SAFE_INTEGER});break;}catch(error){if(attempt===0&&!signal.aborted&&(error.code==='AI_OUTPUT_INVALID'||error.statusCode===422))continue;throw error;}}
          authorize();
          if(get(job.id)?.state!=='running')return;
          if(job.feature==='embedding') {
            if(result.vector) {
              const vector=Float32Array.from(result.vector);
              db.prepare('UPDATE ai_documents SET vector=?,vector_space=? WHERE id=? AND asset_id=? AND revision=? AND text=?')
                .run(Buffer.from(vector.buffer),model.id,result.documentId,item.id,result.documentRevision,result.documentText);
            }
          } else {
            validateAiResult(job.feature,result,{pageCount:item.page_count,durationMs:input.durationMs||Number.MAX_SAFE_INTEGER});
          }
          db.prepare('INSERT OR REPLACE INTO ai_units VALUES(?,?,?)').run(job.id,unit,JSON.stringify(result));
        } catch(error) {
          if(signal.aborted||safeCode(error).includes('RESOURCE')||safeCode(error).includes('MODEL')||
              safeCode(error).includes('RUNTIME')||safeCode(error).includes('STORAGE')||safeCode(error)==='AI_TEMPORARY_LIMIT')throw error;
          errors.push(unit);
          db.prepare('INSERT OR REPLACE INTO ai_units VALUES(?,?,?)')
            .run(job.id,unit,JSON.stringify({errorCode:safeCode(error),tags:[],blocks:[],segments:[],summary:''}));
        } finally {await rm(unitFolder,{recursive:true,force:true});}
        db.prepare('UPDATE ai_jobs SET checkpoint=?,updated_at=? WHERE id=?').run(unit+1,Date.now(),job.id);
        // Return the execution slot between units to preserve fairness.
        if(unit+1<total){setState(job.id,'queued');return;}
      }
      authorize();
      if(get(job.id)?.state!=='running')return;
      const fresh=await resolveInput({db,...context},item);authorize();
      if(fresh.stamp!==input.stamp)throw Object.assign(Error('Input changed'),{code:'AI_INPUT_CHANGED'});
      const failedUnits=db.prepare("SELECT COUNT(*) n FROM ai_units WHERE job_id=? AND json_extract(result_json,'$.errorCode') IS NOT NULL").get(job.id).n;
      if(failedUnits===total&&total>0)throw Object.assign(Error('All analysis units failed'),{code:'AI_ANALYSIS_FAILED'});
      if(job.feature!=='embedding') {
        if(db.prepare("SELECT 1 FROM ai_jobs WHERE asset_id=? AND feature=? AND created_at>? AND state IN ('complete','partial') LIMIT 1").get(job.asset_id,job.feature,job.created_at)){setState(job.id,'cancelled','AI_SUPERSEDED');return;}
        const source=(function*(){for(const row of db.prepare('SELECT unit,result_json FROM ai_units WHERE job_id=? ORDER BY unit').iterate(job.id))yield {unit:row.unit,value:JSON.parse(row.result_json)};})();
        store.publishUnits(item,job.feature,input.stamp,model.id,source,{pageCount:item.page_count,durationMs:input.durationMs||Number.MAX_SAFE_INTEGER,totalUnits:total,profileHash:job.profile_hash,model:{id:model.id,key:model.key,name:model.name,revision:model.revision,engine:model.engine,license:model.license}});
      }
      setState(job.id,failedUnits?'partial':'complete',failedUnits?'AI_PARTIAL_RESULT':null);
      if(job.feature!=='embedding'&&settings.value.models.embedding)
        await enqueue(item,job.requester_id,['embedding'],{requestId:randomUUID(),regenerate:true,automatic:Boolean(job.automatic)});
    }catch(error) {
      const live=get(job.id);
      if(live&&!['paused','cancelled'].includes(live.state)) {
        const code=safeCode(error);
        if(closing||signal.aborted)setState(job.id,'queued');
        else if(['AI_MODEL_NOT_READY','AI_RUNTIME_UNAVAILABLE','AI_RESOURCE_WAIT','AI_MEMORY_LIMIT','AI_STORAGE_FULL','AI_TEMPORARY_LIMIT','AI_DEPENDENCY_WAIT'].includes(code))
          setState(job.id,code==='AI_DEPENDENCY_WAIT'?'dependency-wait':'resource-wait',code);
        else setState(job.id,'failed',code);
      }
    }finally{clearInterval(guard);if(ownsFolder)await rm(folder,{recursive:true,force:true});}
  }
  async function pump() {
    if(pumping||closing||!settings.value.enabled||maintenance.locked||Date.now()<foregroundUntil)return;
    const hours=settings.value.quietHours,hour=new Date().getHours();
    if(hours&&!(hours[0]===hours[1]||(hours[0]<hours[1]?hour>=hours[0]&&hour<hours[1]:hour>=hours[0]||hour<hours[1])))return;
    pumping=true;
    try {
      const capacity=Math.max(0,settings.value.concurrentJobs-running.size);
      if(!capacity)return;
      const candidates=db.prepare(`SELECT j.* FROM ai_jobs j WHERE j.state IN ('queued','resource-wait','dependency-wait')
        AND (j.error_code IS NULL OR j.updated_at<?)
        AND NOT EXISTS(SELECT 1 FROM ai_jobs p WHERE p.asset_id=j.asset_id AND p.id!=j.id AND p.state IN ('queued','running','paused','resource-wait','dependency-wait') AND
          (j.feature='chapters' AND p.feature='transcript' OR j.feature='tags' AND p.feature IN ('ocr','transcript','structure') OR j.feature='embedding' AND p.feature!='embedding'))
        ORDER BY j.updated_at,j.created_at LIMIT 100`).all(Date.now()-15000);
      candidates.sort((a,b)=>(a.requester_id===lastUser)-(b.requester_id===lastUser)||a.updated_at-b.updated_at);
      let count=0;
      for(const candidate of candidates) {
        if(count>=capacity)break;
        if(running.has(candidate.id)||dependencies(candidate))continue;
        const controller=new AbortController(),lease=randomUUID(),now=Date.now();
        const claim=db.prepare("UPDATE ai_jobs SET state='running',lease=?,started_at=COALESCE(started_at,?),updated_at=?,error_code=NULL WHERE id=? AND state IN ('queued','resource-wait','dependency-wait')")
          .run(lease,now,now,candidate.id);
        if(!claim.changes)continue;
        lastUser=candidate.requester_id;count++;
        const promise=execute({...candidate,state:'running',lease},controller).finally(()=>{
          running.delete(candidate.id);if(!closing)setTimeout(()=>void safePump(),25).unref();
        });
        running.set(candidate.id,{controller,promise});
      }
    }finally{pumping=false;}
  }
  async function scanAutomatic() {
    if(closing||!settings.value.enabled||maintenance.locked)return;
    const rows=db.prepare(`SELECT i.*,p.features_json FROM items i JOIN ai_policies p ON p.shelf_id=i.shelf_id
      WHERE p.enabled=1 AND i.created_at>=p.updated_at AND (? IS NULL OR i.created_at<? OR i.created_at=? AND i.id<?) AND EXISTS(SELECT 1 FROM json_each(p.features_json) f
        WHERE (f.value IN ('tags','embedding') OR f.value='ocr' AND i.mime_type IN ('application/pdf','application/epub+zip','application/vnd.mirea.image-book') OR f.value='transcript' AND (i.mime_type LIKE 'audio/%' OR i.mime_type LIKE 'video/%') OR f.value='structure' AND i.mime_type LIKE 'audio/%' OR f.value='chapters' AND i.mime_type LIKE 'video/%') AND NOT EXISTS(SELECT 1 FROM ai_jobs j WHERE j.asset_id=i.id AND j.feature=f.value)) ORDER BY i.created_at DESC,i.id DESC LIMIT 50`).all(automaticCursor?.time??null,automaticCursor?.time??null,automaticCursor?.time??null,automaticCursor?.id??null);
    automaticCursor=rows.length===50?{time:rows.at(-1).created_at,id:rows.at(-1).id}:null;
    for(const item of rows) {
      const owner=db.prepare("SELECT user_id FROM memberships WHERE shelf_id=? AND role='owner'").get(item.shelf_id)?.user_id;
      if(closing)break;
      if(!owner||!enabledUser(owner))continue;
      const features=JSON.parse(item.features_json).filter(feature=>aiFeatureApplies(feature,item.mime_type)&&
        !db.prepare('SELECT 1 FROM ai_jobs WHERE asset_id=? AND feature=?').get(item.id,feature));
      if(features.length)await enqueue(item,owner,features,{requestId:randomUUID(),automatic:true}).catch(()=>{});
      await yieldEventLoop();
    }
  }
  db.prepare("UPDATE ai_jobs SET state='queued',lease=NULL,error_code=NULL WHERE state='running'").run();
  const safePump=()=>pump().catch(()=>{});
  const timer=setInterval(()=>{void safePump();if(!scanning)scanning=scanAutomatic().catch(()=>{}).finally(()=>{scanning=null;});},2000);timer.unref();
  return {
    enqueue,pump,get,
    inspect:()=>({running:running.size,waiting:db.prepare("SELECT COUNT(*) n FROM ai_jobs WHERE state IN ('queued','resource-wait','dependency-wait')").get().n}),
    prioritizeForeground(ms=500){foregroundUntil=Math.max(foregroundUntil,Date.now()+Math.min(1500,ms));},
    control(id,action) {
      const job=get(id);if(!job)throw httpError(404,'解析ジョブが見つかりません。');
      if(action==='pause') {if(!activeStates.includes(job.state))throw httpError(409,'完了したジョブです。');setState(id,'paused');running.get(id)?.controller.abort();}
      else if(action==='cancel') {if(['complete','partial','failed','cancelled'].includes(job.state))return job;setState(id,'cancelled');running.get(id)?.controller.abort();}
      else if(action==='resume') {if(job.state==='running')return get(id);if(!['paused','failed','partial','resource-wait','dependency-wait'].includes(job.state))throw httpError(409,'再開できるジョブを選んでください。');setState(id,'queued');}
      else if(action==='retry') {
        if(!['failed','partial','cancelled'].includes(job.state))throw httpError(409,'再試行できるジョブを選んでください。');
        if(db.prepare("SELECT 1 FROM ai_jobs WHERE asset_id=? AND feature=? AND input_stamp=? AND profile_hash=? AND id!=? AND state IN ('queued','running','paused','resource-wait','dependency-wait')").get(job.asset_id,job.feature,job.input_stamp,job.profile_hash,job.id))throw httpError(409,'同じ内容の解析がすでに待機・実行中です。');
        const failed=db.prepare("SELECT unit FROM ai_units WHERE job_id=? AND json_extract(result_json,'$.errorCode') IS NOT NULL ORDER BY unit LIMIT 1").get(id);
        db.prepare('UPDATE ai_jobs SET checkpoint=?,attempts=attempts+1 WHERE id=?').run(failed?.unit??0,id);
        if(failed)db.prepare("DELETE FROM ai_units WHERE job_id=? AND json_extract(result_json,'$.errorCode') IS NOT NULL").run(id);
        else db.prepare('DELETE FROM ai_units WHERE job_id=?').run(id);
        setState(id,'queued');
      }else throw httpError(422,'解析ジョブの操作を確認してください。');
      void safePump();return get(id);
    },
    async cancelAsset(id) {
      db.prepare("UPDATE ai_jobs SET state='cancelled' WHERE asset_id=? AND state IN ('queued','running','paused','resource-wait','dependency-wait')").run(id);
      const tasks=[...running].filter(([key])=>get(key)?.asset_id===id);
      for(const [,task]of tasks)task.controller.abort();
      await Promise.allSettled(tasks.map(([,task])=>task.promise));
    },
    get busy(){return preparing||running.size>0;},
    async close(){closing=true;clearInterval(timer);for(const task of running.values())task.controller.abort();await Promise.allSettled([...running.values()].map(task=>task.promise));await scanning;await prepared.catch(()=>{});}
  };
}
