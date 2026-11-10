import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,rename,lstat,readFile,unlink,statfs} from 'node:fs/promises';
import {createReadStream,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {httpError} from './security.js';
import {aiHash} from './ai-validation.js';

export const AI_MODEL_CATALOG = [
  {key:'vision-4b',name:'Qwen3-VL 4B 高品質',repo:'Qwen/Qwen3-VL-4B-Instruct-GGUF',engine:'llama',
    capabilities:['tags','ocr','chapters'],license:'apache-2.0',
    files:['Qwen3VL-4B-Instruct-Q8_0.gguf','mmproj-Qwen3VL-4B-Instruct-F16.gguf']},
  {key:'vision-2b',name:'Qwen3-VL 2B 省メモリー',repo:'Qwen/Qwen3-VL-2B-Instruct-GGUF',engine:'llama',
    capabilities:['tags','ocr','chapters'],license:'apache-2.0',
    files:['Qwen3VL-2B-Instruct-Q8_0.gguf','mmproj-Qwen3VL-2B-Instruct-F16.gguf']},
  {key:'embedding',name:'Qwen3 Embedding 0.6B',repo:'Qwen/Qwen3-Embedding-0.6B-GGUF',engine:'llama',
    capabilities:['embedding'],license:'apache-2.0',files:['Qwen3-Embedding-0.6B-Q8_0.gguf']},
  {key:'speech-large',name:'Whisper large-v3',repo:'ggerganov/whisper.cpp',engine:'whisper',
    capabilities:['transcript'],license:'mit',files:['ggml-large-v3.bin']},
  {key:'speech-small',name:'Whisper small 省メモリー',repo:'ggerganov/whisper.cpp',engine:'whisper',
    capabilities:['transcript'],license:'mit',files:['ggml-small.bin']},
  {key:'music-stems',name:'HTDemucs 音楽解析の前処理',repo:'facebookresearch/demucs',engine:'demucs',capabilities:[],license:'mit',revision:'8726e21a993978c7ba086d3872e7608d7d5bfca646',downloadBase:'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/',files:['955717e8-8726e21a.th'],pinnedFiles:[{name:'955717e8-8726e21a.th',size:84141911,sha256:'8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4'}]},
  {key:'music',name:'All-In-One harmonix ensemble',repo:'taejunkim/allinone',engine:'allinone',
    capabilities:['structure'],license:'mit',
    files:['harmonix-fold0-0vra4ys2.pth','harmonix-fold1-3ozjhtsj.pth','harmonix-fold2-gmgo0nsy.pth',
      'harmonix-fold3-i92b7m8p.pth','harmonix-fold4-1bql5qo0.pth','harmonix-fold5-x4z5zeef.pth',
      'harmonix-fold6-x7t226rq.pth','harmonix-fold7-qwwskhg6.pth']}
];

export function validateModelManifest(value,catalog=AI_MODEL_CATALOG) {
  const entry=catalog.find(row=>row.key===value?.key);
  if (!entry||value.repo!==entry.repo||!/^[0-9a-f]{40}$/.test(value.revision??'')||
      value.license!==entry.license||!Array.isArray(value.files)||value.files.length!==entry.files.length)
    throw httpError(422,'モデルの配布情報を確認してください。');
  if(entry.pinnedFiles&&(value.revision!==entry.revision||JSON.stringify(value.files.map(({name,size,sha256})=>({name,size,sha256})))!==JSON.stringify(entry.pinnedFiles)))throw httpError(422,'固定モデルの検証情報が一致しません。');
  for (const [index,file] of value.files.entries())
    if (file.name!==entry.files[index]||!Number.isSafeInteger(file.size)||file.size<1||file.size>32*1024**3||
        !/^[0-9a-f]{64}$/.test(file.sha256??''))
      throw httpError(422,'モデルのファイルと検証情報を確認してください。');
  const manifest={...entry,revision:value.revision,files:value.files.map(({name,size,sha256})=>({name,size,sha256}))};
  return {...manifest,id:aiHash({key:entry.key,revision:value.revision,files:manifest.files})};
}

export async function safeModelFetch(url,options={},fetcher=fetch) {
  let next=new URL(url),headers={...options.headers};
  for (let n=0;n<6;n++) {
    if (next.protocol!=='https:'||next.username||next.password||next.port&&next.port!=='443'||
        !(next.hostname==='huggingface.co'||next.hostname.endsWith('.huggingface.co')||
          next.hostname.endsWith('.xethub.hf.co')||next.hostname.endsWith('.xethub-eu.hf.co')||['cdn-lfs-us-1.hf.co','cdn-lfs-eu-1.hf.co'].includes(next.hostname)||next.hostname.endsWith('.cdn.hf.co')||next.hostname==='dl.fbaipublicfiles.com'&&next.pathname==='/demucs/hybrid_transformer/955717e8-8726e21a.th'))
      throw httpError(422,'モデルの取得先を確認してください。');
    const response=await fetcher(next,{...options,headers,redirect:'manual'});
    if (![301,302,303,307,308].includes(response.status)) return response;
    const target=new URL(response.headers.get('location'),next);
    await response.body?.cancel();
    if (target.origin!==next.origin) {
      headers={...headers};delete headers.Authorization;delete headers.authorization;
    }
    next=target;
  }
  throw httpError(502,'モデルの取得先を確認できません。');
}

export async function previewAiModel(key,{fetcher=fetch}={}) {
  const entry=AI_MODEL_CATALOG.find(row=>row.key===key);
  if (!entry) throw httpError(404,'対応するモデルを選んでください。');
  if(entry.pinnedFiles){const manifest=validateModelManifest({...entry,files:entry.pinnedFiles});return {manifest,totalBytes:manifest.files.reduce((n,f)=>n+f.size,0),licenseUrl:'https://github.com/facebookresearch/demucs/blob/v4.0.1/LICENSE',acceptanceHash:aiHash({id:manifest.id,license:manifest.license})};}
  const response=await safeModelFetch('https://huggingface.co/api/models/'+entry.repo+'?blobs=true',
    {signal:AbortSignal.timeout(30000)},fetcher);
  if (!response.ok) throw httpError(response.status===401||response.status===403?403:502,'配布元からモデル情報を取得できません。');
  const raw=await response.text();
  if (Buffer.byteLength(raw)>2*1024*1024) throw httpError(502,'モデル情報が大きすぎます。');
  const info=JSON.parse(raw);
  if (info.cardData?.license!==entry.license) throw httpError(409,'モデルの利用条件が更新されています。配布情報を確認してください。');
  const files=entry.files.map(name=>{
    const source=info.siblings?.find(row=>row.rfilename===name);
    return {name,size:source?.size??source?.lfs?.size,sha256:source?.lfs?.sha256};
  });
  const manifest=validateModelManifest({...entry,revision:info.sha,files});
  return {manifest,totalBytes:files.reduce((n,f)=>n+f.size,0),
    licenseUrl:'https://huggingface.co/'+entry.repo+'/tree/'+manifest.revision,
    acceptanceHash:aiHash({id:manifest.id,license:manifest.license})};
}

async function fileHash(path) {
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function createAiModels({db,dataDir,fetcher=fetch,authorized=()=>true,inUse=()=>false}) {
  const root=join(dataDir,'ai','models'),running=new Map();
  let closing=false;
  const row=id=>db.prepare('SELECT * FROM ai_models WHERE id=?').get(id);
  const view=record=>record?{...JSON.parse(record.manifest_json),state:record.state,
    progress:JSON.parse(record.progress_json),errorCode:record.error_code,acceptedAt:record.accepted_at}:null;
  const update=(id,state,progress={},error=null)=>db.prepare('UPDATE ai_models SET state=?,progress_json=?,error_code=?,updated_at=? WHERE id=?')
    .run(state,JSON.stringify(progress),error,Date.now(),id);
  async function checkDirectory(path) {
    await mkdir(path,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const info=await lstat(path);
    if (!info.isDirectory()||info.isSymbolicLink()) throw httpError(409,'モデル保存先を確認してください。');
  }
  async function download(record,signal) {
    const model=validateModelManifest(JSON.parse(record.manifest_json)),folder=join(root,model.id);
    await checkDirectory(join(dataDir,'ai'));await checkDirectory(root);await checkDirectory(folder);
    const needed=model.files.reduce((n,f)=>n+f.size,0);
    let complete=0;
    for (const file of model.files) {
      if (!authorized(record.accepted_by)) throw Object.assign(Error('Authority expired'),{code:'AI_AUTHORITY_EXPIRED'});
      const target=join(folder,file.name),part=target+'.part';
      const info=await lstat(target).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      if (info?.isFile()&&!info.isSymbolicLink()&&info.size===file.size&&await fileHash(target)===file.sha256) {
        complete+=file.size;continue;
      }
      if (info) throw Object.assign(Error('Installed model changed'),{code:'AI_MODEL_CORRUPT'});
      if(JSON.parse(record.manifest_json).localOnly)throw Object.assign(Error('Local model file missing'),{code:'AI_MODEL_NOT_READY'});
      const partial=await lstat(part).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      if (partial&&(partial.isSymbolicLink()||!partial.isFile()||partial.size>file.size))
        throw Object.assign(Error('Invalid partial model'),{code:'AI_MODEL_CORRUPT'});
      let offset=partial?.size??0;
      if(offset===file.size){if(await fileHash(part)===file.sha256){await rename(part,target);complete+=file.size;continue;}await unlink(part);offset=0;}
      const space=await statfs(folder);
      if(Number(space.bavail)*Number(space.bsize)<file.size-offset+256*1024*1024)throw Object.assign(Error('Model storage full'),{code:'AI_STORAGE_FULL'});
      const stalled=new AbortController();let idleTimer;
      const touch=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>stalled.abort(),120000);};touch();
      try {
      const response=await safeModelFetch(model.downloadBase?model.downloadBase+file.name:'https://huggingface.co/'+model.repo+'/resolve/'+model.revision+'/'+file.name,
        {signal:AbortSignal.any([signal,stalled.signal]),headers:offset?{Range:'bytes='+offset+'-'}:{}},fetcher);
      if (!response.ok) {await response.body?.cancel();throw Object.assign(Error('Model download failed'),{code:response.status===401||response.status===403?'AI_DOWNLOAD_DENIED':'AI_DOWNLOAD_FAILED'});}
      if (response.status!==206) offset=0;
      else if (!response.headers.get('content-range')?.startsWith('bytes '+offset+'-'))
        throw Object.assign(Error('Invalid model range'),{code:'AI_DOWNLOAD_FAILED'});
      const handle=await open(part,offset?'a':'w',0o600);
      let written=offset,lastUpdate=0;
      try {
        for await (const chunk of response.body) {
          touch();
          if (signal.aborted||closing) throw new DOMException('Cancelled','AbortError');
          if (!authorized(record.accepted_by)) throw Object.assign(Error('Authority expired'),{code:'AI_AUTHORITY_EXPIRED'});
          written+=chunk.length;
          if (written>file.size) throw Object.assign(Error('Model size mismatch'),{code:'AI_MODEL_CORRUPT'});
          await handle.writeFile(chunk);
          if (Date.now()-lastUpdate>500) {
            update(model.id,'downloading',{receivedBytes:complete+written,totalBytes:needed,file:file.name});
            lastUpdate=Date.now();
          }
        }
        await handle.sync();
      } finally {await handle.close();}
      if (written!==file.size)throw Object.assign(Error('Incomplete model'),{code:'AI_DOWNLOAD_INCOMPLETE'});
      if(await fileHash(part)!==file.sha256){await unlink(part);throw Object.assign(Error('Model checksum mismatch'),{code:'AI_MODEL_CORRUPT'});}
      if (!authorized(record.accepted_by)) throw Object.assign(Error('Authority expired'),{code:'AI_AUTHORITY_EXPIRED'});
      await rename(part,target);complete+=file.size;
      } finally {clearTimeout(idleTimer);}
    }
    update(model.id,'ready',{receivedBytes:complete,totalBytes:needed});
    return model;
  }
  function start(id) {
    const record=row(id);
    if (!record) throw httpError(404,'モデルを先に登録してください。');
    if (running.has(id)) return view(record);
    if (running.size>=1) throw httpError(429,'モデルの取得中です。完了後に再開してください。');
    const controller=new AbortController();
    update(id,'downloading');
    const promise=download(record,controller.signal).catch(error=>{
      update(id,closing||controller.signal.aborted?'paused':'failed',{},error.code??'AI_DOWNLOAD_FAILED');
    }).finally(()=>running.delete(id));
    running.set(id,{controller,promise});return view(row(id));
  }
  db.prepare("UPDATE ai_models SET state='paused' WHERE state='downloading'").run();
  return {
    root,list:()=>db.prepare('SELECT * FROM ai_models ORDER BY accepted_at').all().map(view),
    get:id=>view(row(id)),
    resolveByKey(key){const record=db.prepare("SELECT id FROM ai_models WHERE state='ready' AND json_extract(manifest_json,'$.key')=? ORDER BY accepted_at DESC LIMIT 1").get(key);if(!record)throw Object.assign(Error('Dependency model not installed'),{code:'AI_MODEL_NOT_READY'});return this.resolve(record.id);},
    resolve(id) {
      const model=view(row(id));
      if (model?.state!=='ready') throw Object.assign(Error('Model not installed'),{code:'AI_MODEL_NOT_READY'});
      const folder=join(root,id);if(model.files.length){try{for(const path of [join(dataDir,'ai'),root,folder]){const info=lstatSync(path);if(info.isSymbolicLink()||!info.isDirectory())throw Error();}for(const file of model.files){const info=lstatSync(join(folder,file.name));if(info.isSymbolicLink()||!info.isFile()||info.size!==file.size)throw Error();}}catch{update(id,'failed',{},'AI_MODEL_CORRUPT');throw Object.assign(Error('Installed model changed'),{code:'AI_MODEL_CORRUPT'});}}
      return {...model,folder};
    },
    accept(manifest,userId,acceptanceHash,{localOnly=false}={}) {
      const model=validateModelManifest(manifest);
      if (aiHash({id:model.id,license:model.license})!==acceptanceHash) throw httpError(409,'モデルの利用条件を確認してください。');
      const existing=row(model.id);if(running.has(model.id))return view(existing);
      const saved={...model,...(localOnly?{localOnly:true}:{})};
      if (!existing) db.prepare("INSERT INTO ai_models VALUES(?,?,'paused','{}',?,?,?,NULL,?)")
        .run(model.id,JSON.stringify(saved),userId,Date.now(),acceptanceHash,Date.now());
      else db.prepare('UPDATE ai_models SET manifest_json=?,accepted_by=?,accepted_at=?,license_hash=? WHERE id=?').run(JSON.stringify(saved),userId,Date.now(),acceptanceHash,model.id);
      return start(model.id);
    },
    get busy(){return running.size>0;},
    start,
    pause(id) {running.get(id)?.controller.abort();return view(row(id));},
    async remove(id) {
      if (inUse(id)||running.has(id)||db.prepare("SELECT 1 FROM ai_jobs WHERE model_id=? AND state IN ('queued','running','paused','dependency-wait','resource-wait')").get(id)||
          db.prepare('SELECT 1 FROM ai_documents WHERE vector_space=? LIMIT 1').get(id)||
          db.prepare("SELECT 1 FROM server_settings s,json_each(s.value,'$.models') m WHERE s.key='ai' AND m.value=?").get(id))
        throw httpError(409,'解析・検索で使用しているモデルです。参照先を変更してください。');
      const model=view(row(id));if(!model)return;
      for(const path of [join(dataDir,'ai'),root,join(root,id)]){const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(info&&(info.isSymbolicLink()||!info.isDirectory()))throw httpError(409,'モデル保存先を確認してください。');}
      for (const file of model.files) {
        await unlink(join(root,id,file.name)).catch(e=>{if(e.code!=='ENOENT')throw e;});
        await unlink(join(root,id,file.name+'.part')).catch(e=>{if(e.code!=='ENOENT')throw e;});
      }
      db.prepare('DELETE FROM ai_models WHERE id=?').run(id);
    },
    async close(){closing=true;for(const task of running.values())task.controller.abort();await Promise.allSettled([...running.values()].map(t=>t.promise));}
  };
}
