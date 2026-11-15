import {DatabaseSync} from 'node:sqlite';
import {readFile,lstat,readdir,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {openRecoveryStore,checkDatabase,durableJson,readManifest} from './recovery-store.js';
import {recoverySettings,RECOVERY_DEFAULTS,RECOVERY_LIMITS} from './recovery-settings.js';
import {PROJECT_ROOT} from './runtime.js';
import {adminBody} from './admin.js';
import {httpError} from './security.js';
import {DATABASE_SCHEMA_VERSION} from './database.js';

const optional=async file=>{try{return await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const reject=(code,message)=>Object.assign(new Error(message),{code});
function compareVersions(left,right){const tuple=value=>{const m=/^(\d+)\.(\d+)\.(\d+)(-beta)?$/.exec(value??'');if(!m)throw reject('RECOVERY_VERSION_INVALID','Invalid persisted runtime version');return [...m.slice(1,4).map(Number),m[4]?0:1];};const a=tuple(left),b=tuple(right);for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;}
async function containsFile(directory){try{for(const name of await readdir(directory)){const info=await lstat(join(directory,name));if(info.isFile()||info.isSymbolicLink()||info.isDirectory()&&await containsFile(join(directory,name)))return true;}return false;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
export async function prepareRecovery({storage,version,options={}}){
 const {dataDir,mediaDir}=storage,filename=join(dataDir,'mirea.sqlite'),runtimeFile=join(dataDir,'recovery-runtime.json'),transitionFile=join(dataDir,'recovery-transition.json');
 if(await optional(join(dataDir,'.mirea-restore-incomplete')))throw reject('RECOVERY_RESTORE_INCOMPLETE','Restore was not completed. Keep the original data and complete recovery into an empty directory.');
 const runtime=JSON.parse(await optional(runtimeFile)??'null');
 if(runtime&&compareVersions(version,runtime.version)<0)throw reject('RECOVERY_DOWNGRADE_BLOCKED','Older application code cannot open newer data. Restore a matching pre-upgrade recovery point into a separate directory.');
 if(await optional(transitionFile))throw reject('RECOVERY_STARTUP_INCOMPLETE','Previous upgrade did not finish. Preserve these data and restore the pre-upgrade recovery point before retrying.');
 const identity=JSON.parse(await readFile(join(dataDir,'storage-layout.json'),'utf8'));
 const store=await openRecoveryStore({dataDir,mediaDir,directory:options.recoveryDirectory??process.env.RECOVERY_DIR,storageId:identity.id});
 const selectedEnvironment=['HOST','PORT','DATA_DIR','MEDIA_DIR','HTTPS_KEY_FILE','HTTPS_CERT_FILE','CORS_ORIGINS','SERVER_ADMIN_USER_IDS','ALLOW_REGISTRATION','ANALYTICS_ENABLED','MAX_UPLOAD_BYTES','UPLOAD_CHUNK_BYTES','APP_UPDATES_DIR','APP_UPDATES_SOURCE','WINDOWS_MAINTENANCE_DIR','RECOVERY_DIR','RECOVERY_INTERVAL_MINUTES','RECOVERY_FULL_INTERVAL_HOURS','RECOVERY_RETENTION_DAYS','RECOVERY_RESERVE_MIB'];
 selectedEnvironment.push('FFMPEG_PATH','FFPROBE_PATH','MAX_CONCURRENT_UPLOADS','MAX_CONCURRENT_JOBS','MAX_CONCURRENT_THUMBNAILS','MAX_CONCURRENT_PREVIEWS','MAX_CONCURRENT_INGEST','MAX_UPLOAD_ASSETS','AI_ENABLED','AI_BACKEND','AI_THREADS','AI_MEMORY_MIB','AI_CONCURRENT_JOBS','AI_RUNTIME_DIR','AI_MUSIC_PYTHON','AI_EXECUTOR','AI_VULKAN_RENDER_NODE','HEALTHCHECK_CA_FILE','HEALTHCHECK_TLS_SERVER_NAME','MIREA_TRUENAS_PREFLIGHT','MIREA_INSTALL_ID','MIREA_STORAGE_GROUP_ID','MIREA_TLS_IP','MIREA_TLS_ROOT_SHA256','MIREA_TLS_LEAF_SHA256','MIREA_TLS_SPKI_SHA256');
 const configuration=()=>[
  {name:'runtime.json',bytes:JSON.stringify({version,storage:{dataDir,mediaDir},environment:Object.fromEntries(selectedEnvironment.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))})},
  {name:'server.env',path:options.backupConfigFile??join(PROJECT_ROOT,'.env')},
  ...['HTTPS_KEY_FILE','HTTPS_CERT_FILE','HEALTHCHECK_CA_FILE'].filter(key=>process.env[key]).map(key=>({name:key==='HTTPS_KEY_FILE'?'tls-key.pem':key==='HTTPS_CERT_FILE'?'tls-cert.pem':'tls-ca.pem',path:resolve(PROJECT_ROOT,process.env[key])}))
 ];
 let existed=false;try{const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.size===0)throw reject('RECOVERY_DATABASE_INVALID','Existing database is empty or unsafe');existed=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!existed&&(runtime||await optional(join(dataDir,'keys','download-master.key'))||await containsFile(storage.uploadDir)||await containsFile(storage.videoDir)||await containsFile(storage.originalDir)))throw reject('RECOVERY_DATABASE_MISSING','Stored media or encryption identity exists but the database is missing. Restore the database; a new empty database will not be created.');
 let checkpoint;
 if(existed){
  const currentDatabase=checkDatabase(filename);
  if(currentDatabase.schema>DATABASE_SCHEMA_VERSION)throw reject('RECOVERY_DOWNGRADE_BLOCKED','Database schema is newer than this application. Restore a matching recovery point before downgrading.');
  if(!runtime||compareVersions(version,runtime.version)!==0||currentDatabase.schema!==DATABASE_SCHEMA_VERSION){
   const source=new DatabaseSync(filename,{readOnly:true});
   try{const hasSettings=source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='server_settings'").get();const reserveMiB=hasSettings?recoverySettings(source).value.reserveMiB:Number(process.env.RECOVERY_RESERVE_MIB??RECOVERY_DEFAULTS.reserveMiB);if(!Number.isSafeInteger(reserveMiB)||reserveMiB<64||reserveMiB>1048576)throw reject('RECOVERY_CONFIGURATION_INVALID','Invalid recovery space reserve');checkpoint=await store.capture({db:source,scope:'full',reason:'pre-upgrade',version,previousVersion:runtime?.version??null,configuration:configuration(),reserveMiB});}finally{source.close();}
   await durableJson(transitionFile,{format:1,version,previousVersion:runtime?.version??null,snapshot:checkpoint.id,createdAt:Date.now()});
  }
 }
 return {store,configuration,checkpoint,async commit(){await durableJson(runtimeFile,{format:1,version,startedAt:Date.now(),preUpgradeSnapshot:checkpoint?.id??runtime?.preUpgradeSnapshot??null});if(checkpoint)await unlink(transitionFile);}};
}

export async function registerRecovery(app,{db,prepared,version,adminAccess:a,maintenance,options={}}){
 const {store,configuration}=prepared,settings=recoverySettings(db),statusFile=join(store.directory,'status.json');
 let state,active=null,closing=false;const serviceStartedAt=Date.now();
 try{state=JSON.parse(await optional(statusFile)??'{}');if(!state||typeof state!=='object'||Array.isArray(state))throw Error();}catch{state={lastError:{code:'RECOVERY_STATUS_INVALID',at:Date.now()}};}
 for(const key of ['lastPruneAt','lastCollectionAt','lastFullAttemptAt','fullDeferredAt'])if(state[key]!==undefined&&(!Number.isSafeInteger(state[key])||state[key]<0||state[key]>Date.now()+300000))delete state[key];
 // A process interruption is visible after restart, never reported as a successful backup.
 if(state.active){state={...state,active:null,lastError:{code:'RECOVERY_INTERRUPTED',at:Date.now()}};await durableJson(statusFile,state);}
 const persist=()=>durableJson(statusFile,state);
 async function execute({scope='database',reason='scheduled',verifyId}={}){
  if(closing||active)throw httpError(409,'別の保全処理を実行中か、サーバーを停止中です。');
  let release;const startedAt=Date.now();state={...state,active:{scope:verifyId?'verify':scope,startedAt},progress:null};
  const task=(async()=>{try{
   await persist();
   if(verifyId){await store.verify(verifyId);state.lastVerified={id:verifyId,at:Date.now()};if(state.lastError?.scope==='verify')state.lastError=null;}
   else{
    // Database snapshots use SQLite's online backup API and do not freeze ordinary usage.
    // Full snapshots require the existing maintenance gate, including idle background jobs.
    if(scope==='full'){state.lastFullAttemptAt=Date.now();release=await maintenance.acquire();}
    const snapshot=await store.capture({db,scope,reason,version,configuration:configuration(),reserveMiB:settings.value.reserveMiB,onProgress:progress=>{state.progress=progress;}});
    state.lastDatabaseAt=snapshot.createdAt;
    if(scope==='full'){state.lastFullAt=snapshot.createdAt;state.fullDeferredAt=null;}
    state.lastSnapshot=snapshot.id;if(!state.lastError?.scope||state.lastError.scope===scope)state.lastError=null;
    // Expiry and object collection happen only after a new verified recovery point exists.
    if(Date.now()-(state.lastPruneAt??0)>=3600000){const collectObjects=Date.now()-(state.lastCollectionAt??0)>=86400000;await store.prune({retentionDays:settings.value.retentionDays,collectObjects});state.lastPruneAt=Date.now();if(collectObjects)state.lastCollectionAt=Date.now();}
   }
  }catch(error){
   const deferred=reason==='scheduled'&&scope==='full'&&error.statusCode===409;
   if(deferred)state.fullDeferredAt=Date.now();
   else{state.lastError={code:/^RECOVERY_[A-Z_]+$/.test(error.code??'')?error.code:'RECOVERY_FAILED',scope:verifyId?'verify':scope,at:Date.now()};app.log.error({code:state.lastError.code},'Recovery operation failed; existing data and recovery points were retained');}
   throw error;
  }finally{release?.();state.active=null;state.progress=null;await persist();}})();
  active=task;try{return await task;}finally{active=null;}
 }
 // Set initial dates from durable manifests too, including the checkpoint made before migration.
 const existing=(await store.list()).filter(s=>!s.invalid);
 state.lastDatabaseAt=Math.max(...existing.map(s=>s.createdAt),0);
 state.lastFullAt=Math.max(...existing.filter(s=>s.scope==='full').map(s=>s.createdAt),0);
 async function tick(){if(closing||active||maintenance.locked)return;const now=Date.now(),values=settings.value;
  if(now-(state.lastDatabaseAt||serviceStartedAt)>=values.intervalMinutes*60000)await execute({scope:'database'}).catch(()=>{});
  if(!closing&&!active&&now-(state.lastFullAt||serviceStartedAt)>=values.fullIntervalHours*3600000&&now-Math.max(state.fullDeferredAt??0,state.lastFullAttemptAt??0)>=600000)await execute({scope:'full'}).catch(()=>{});
 }
 const timer=setInterval(()=>tick().catch(()=>{}),Math.min(60000,options.recoveryTickMs??60000));timer.unref();
 app.addHook('onClose',async()=>{closing=true;clearInterval(timer);await active?.catch(()=>{});});
 const auth={onRequest:async req=>a.requireAdmin(req)};
 const snapshots=async()=> (await store.list()).slice(0,100).map(s=>s.invalid?{id:s.id,invalid:true}:{id:s.id,createdAt:s.createdAt,scope:s.scope,reason:s.reason,version:s.version,previousVersion:s.previousVersion,files:s.fileCount,bytes:s.bytes,database:s.database});
 app.get('/api/v1/admin/recovery',auth,async()=>({...state,settings:settings.metadata,directory:store.directory,snapshots:await snapshots(),databaseOverdue:Date.now()-(state.lastDatabaseAt??0)>settings.value.intervalMinutes*3*60000,fullOverdue:Date.now()-(state.lastFullAt??0)>settings.value.fullIntervalHours*2*3600000,restoration:'offline-empty-destination',mediaBackupIsSeparate:true}));
 app.patch('/api/v1/admin/recovery/settings',{...auth,schema:{body:adminBody({values:{type:'object',additionalProperties:false,properties:Object.fromEntries(Object.entries(RECOVERY_LIMITS).map(([key,[minimum,maximum]])=>[key,{type:'integer',minimum,maximum}]))}})}},async req=>{await a.reauthenticate(req);const value=settings.update(req.body.values);a.audit(req,'recovery.settings');return value;});
 app.post('/api/v1/admin/recovery',{...auth,schema:{body:adminBody({scope:{enum:['database','full']},acknowledgePause:{type:'boolean'}})}},async(req,reply)=>{
  await a.reauthenticate(req);if(req.body.scope==='full'&&!req.body.acknowledgePause)throw httpError(400,'全体保全中は操作を一時制限することを確認してください。');
  if(active||closing)throw httpError(409,'別の保全処理を実行中です。');
  a.audit(req,'recovery.create',null,{scope:req.body.scope});execute({scope:req.body.scope,reason:'manual'}).catch(()=>{});return reply.code(202).send({started:true});
 });
 app.post('/api/v1/admin/recovery/:id/verify',{...auth,schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}},body:adminBody()}},async(req,reply)=>{
  await a.reauthenticate(req);if(active||closing)throw httpError(409,'別の保全処理を実行中です。');await readManifest(store.directory,req.params.id);if(active||closing)throw httpError(409,'別の保全処理を実行中です。');a.audit(req,'recovery.verify',req.params.id);execute({verifyId:req.params.id,reason:'manual'}).catch(()=>{});return reply.code(202).send({started:true});
 });
 return {execute,tick,get state(){return state;}};
}
