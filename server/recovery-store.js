import {DatabaseSync,backup} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {mkdir,lstat,readdir,readFile,writeFile,open,rename,unlink,link,copyFile,statfs} from 'node:fs/promises';
import {join,resolve,relative,sep,isAbsolute,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {tarBackupStream} from './backup-archive.js';

export const RECOVERY_FORMAT=1;
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
export const within=(parent,child)=>{const r=relative(resolve(parent),resolve(child));return r===''||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
const exists=async file=>{try{return await lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const fail=(code,message)=>Object.assign(new Error(message),{code});
export async function syncDirectory(directory){if(process.platform==='win32')return;const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
export async function durableJson(file,value){const temp=file+'.'+randomUUID()+'.tmp';const handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}try{await rename(temp,file);await syncDirectory(dirname(file));}finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
export async function fileHash(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
export function checkDatabase(file,{full=false}={}){const db=new DatabaseSync(file,{readOnly:true});try{
 const check=db.prepare(full?'PRAGMA integrity_check':'PRAGMA quick_check(1)').all();
 if(check.length!==1||Object.values(check[0])[0]!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw fail('RECOVERY_DATABASE_INVALID','Database integrity verification failed');
 const schema=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
 if(!schema)throw fail('RECOVERY_DATABASE_INVALID','Database schema is missing');
 return {schema:db.prepare('SELECT version FROM schema_version').get().version,users:db.prepare('SELECT count(*) n FROM users').get().n,assets:db.prepare('SELECT count(*) n FROM items').get().n};
 }finally{db.close();}}
function safeName(name){return typeof name==='string'&&/^(data|media|configuration)\//.test(name)&&Buffer.byteLength(name)<=16384&&!/[\\:\0\r\n]/.test(name)&&name.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[. ]$/.test(p)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(p));}
export function validateManifest(envelope){
 const {manifest,sha256}=envelope??{};
 if(!manifest||sha256!==createHash('sha256').update(JSON.stringify(manifest)).digest('hex')||manifest.format!==1||!UUID.test(manifest.id)||!Number.isSafeInteger(manifest.createdAt)||!['database','full'].includes(manifest.scope)||!Array.isArray(manifest.files)||manifest.files.length>2000000)throw fail('RECOVERY_MANIFEST_INVALID','Invalid recovery manifest');
 const names=new Set();for(const file of manifest.files){const key=file.name?.toLowerCase();if(!safeName(file.name)||names.has(key)||!SHA.test(file.sha256)||!Number.isSafeInteger(file.size)||file.size<0||!Number.isFinite(file.mtimeMs)||file.mtimeNs!==undefined&&!/^-?\d{1,24}$/.test(file.mtimeNs))throw fail('RECOVERY_MANIFEST_INVALID','Invalid recovery file');names.add(key);}
 const sorted=[...names].sort();for(let index=1;index<sorted.length;index++)if(sorted[index].startsWith(sorted[index-1]+'/'))throw fail('RECOVERY_MANIFEST_INVALID','Conflicting recovery paths');
 if(!manifest.files.some(file=>file.name==='data/mirea.sqlite'))throw fail('RECOVERY_MANIFEST_INVALID','Recovery database missing');
 return manifest;
}
export async function readManifest(directory,id){if(!UUID.test(id??''))throw fail('RECOVERY_MANIFEST_INVALID','Invalid recovery ID');const folder=join(directory,'snapshots',id),info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink())throw fail('RECOVERY_MANIFEST_INVALID','Invalid snapshot directory');const file=join(folder,'manifest.json'),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512*1024*1024)throw fail('RECOVERY_MANIFEST_INVALID','Invalid recovery manifest file');const value=validateManifest(JSON.parse(await readFile(file,'utf8')));if(value.id!==id)throw fail('RECOVERY_MANIFEST_INVALID','Snapshot identity mismatch');return value;}
export async function verifyRecoveryPoint(directory,id,{database=true}={}){
 for(const target of [directory,join(directory,'snapshots'),join(directory,'objects')]){const info=await lstat(target);if(!info.isDirectory()||info.isSymbolicLink())throw fail('RECOVERY_PATH_INVALID','Recovery storage may not follow links');}
 const manifest=await readManifest(directory,id);
 for(const file of manifest.files){const location=join(directory,'objects',file.sha256),info=await lstat(location);if(!info.isFile()||info.isSymbolicLink()||info.size!==file.size||await fileHash(location)!==file.sha256)throw fail('RECOVERY_CHECKSUM_MISMATCH','Recovery content verification failed');}
 if(database)checkDatabase(join(directory,'objects',manifest.files.find(f=>f.name==='data/mirea.sqlite').sha256),{full:true});return manifest;
}

export async function openRecoveryStore({dataDir,mediaDir=dataDir,directory,storageId}){
 dataDir=resolve(dataDir);mediaDir=resolve(mediaDir);const custom=directory!==undefined;directory=resolve(directory??join(dataDir,'recovery'));
 if(directory===dataDir||directory===mediaDir||within(directory,dataDir)||within(directory,mediaDir)||within(dataDir,directory)&&directory!==join(dataDir,'recovery')||mediaDir!==dataDir&&within(mediaDir,directory))throw fail('RECOVERY_PATH_INVALID','Recovery directory must be data/recovery or disjoint from live storage');
 // An explicitly configured mount must exist; never fall back into the container filesystem.
 if(custom){const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw fail('RECOVERY_PATH_INVALID','Recovery mount must be an existing directory');}
 else await mkdir(directory,{recursive:true,mode:0o700});
 if((await lstat(directory)).isSymbolicLink())throw fail('RECOVERY_PATH_INVALID','Recovery store may not be a link');
 const identityFile=join(directory,'recovery-store.json'),identity=await exists(identityFile);
 if(identity){if(!identity.isFile()||identity.isSymbolicLink()||identity.size>2048)throw fail('RECOVERY_PATH_INVALID','Invalid recovery store identity');const value=JSON.parse(await readFile(identityFile,'utf8'));if(value.format!==1||value.storageId!==storageId)throw fail('RECOVERY_IDENTITY_MISMATCH','Recovery store belongs to different storage');}
 else{if((await readdir(directory)).length)throw fail('RECOVERY_PATH_INVALID','New recovery store must be empty');await durableJson(identityFile,{format:1,storageId});}
 for(const name of ['objects','snapshots','work']){const target=join(directory,name);await mkdir(target,{recursive:true,mode:0o700});const info=await lstat(target);if(!info.isDirectory()||info.isSymbolicLink())throw fail('RECOVERY_PATH_INVALID','Invalid recovery storage directory');}
 let busy=false,summaryCache=null,summaryAt=0;
 const objectPath=hash=>{if(!SHA.test(hash))throw fail('RECOVERY_MANIFEST_INVALID','Invalid content identity');return join(directory,'objects',hash);};
 const summarize=manifest=>{const {files,...summary}=manifest;return {...summary,fileCount:files.length};};
 async function list(){
  if(summaryCache&&Date.now()-summaryAt<30000)return [...summaryCache];
  const result=[];for(const name of await readdir(join(directory,'snapshots'))){if(!UUID.test(name))continue;try{
   const folder=join(directory,'snapshots',name),file=join(folder,'summary.json'),info=await exists(file);let summary;
   if(info){if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw fail('RECOVERY_MANIFEST_INVALID','Invalid recovery summary');const envelope=JSON.parse(await readFile(file,'utf8'));summary=envelope.summary;
    if(!summary||envelope.sha256!==createHash('sha256').update(JSON.stringify(summary)).digest('hex')||summary.id!==name||summary.format!==1||!Number.isSafeInteger(summary.createdAt)||summary.createdAt>Date.now()+300000||!['database','full'].includes(summary.scope)||!['scheduled','manual','pre-upgrade'].includes(summary.reason)||!Number.isSafeInteger(summary.fileCount))throw fail('RECOVERY_MANIFEST_INVALID','Invalid recovery summary');
    const manifestInfo=await lstat(join(folder,'manifest.json'));if(!manifestInfo.isFile()||manifestInfo.isSymbolicLink())throw fail('RECOVERY_MANIFEST_INVALID','Invalid recovery manifest');
   }else summary=summarize(await readManifest(directory,name));
   result.push(summary);
  }catch{result.push({id:name,invalid:true});}}
  summaryCache=result.sort((a,b)=>(b.createdAt??0)-(a.createdAt??0));summaryAt=Date.now();return [...summaryCache];
 }
 const verify=(id,options)=>verifyRecoveryPoint(directory,id,options);
 async function capture({db,scope='database',reason='scheduled',version,previousVersion=null,configuration=[],reserveMiB=512,now=Date.now(),onProgress=()=>{}}){
  if(busy)throw fail('RECOVERY_BUSY','Another recovery operation is running');busy=true;
  const id=randomUUID(),work=join(directory,'work',id);
  try{
   await mkdir(work,{mode:0o700});
   const space=await statfs(directory),estimate=Number(db.prepare('PRAGMA page_count').get().page_count)*Number(db.prepare('PRAGMA page_size').get().page_size);
   if(Number(space.bavail)*Number(space.bsize)<estimate+reserveMiB*1048576)throw fail('RECOVERY_SPACE_LOW','Insufficient recovery space');
   const files=[],verified=new Set();let bytes=0;
   async function add(source,name){
    if(!safeName(name))throw fail('RECOVERY_PATH_INVALID','Unsafe recovery filename');
    const before=await lstat(source);if(!before.isFile()||before.isSymbolicLink())throw fail('RECOVERY_PATH_INVALID','Recovery may only read regular files');
    const sha256=await fileHash(source),target=objectPath(sha256),stored=await exists(target);
    if(stored){if(!stored.isFile()||stored.isSymbolicLink()||stored.size!==before.size||!verified.has(sha256)&&await fileHash(target)!==sha256)throw fail('RECOVERY_CHECKSUM_MISMATCH','Existing recovery object is damaged');}
    else{
     const free=await statfs(directory);if(Number(free.bavail)*Number(free.bsize)<before.size+reserveMiB*1048576)throw fail('RECOVERY_SPACE_LOW','Insufficient recovery space');
     const temp=join(work,randomUUID());await copyFile(source,temp,constants.COPYFILE_FICLONE);if(await fileHash(temp)!==sha256)throw fail('RECOVERY_SOURCE_CHANGED','Backup source changed');
     const handle=await open(temp,'r+');try{await handle.sync();}finally{await handle.close();}
     await link(temp,target);await unlink(temp);
    }
    const after=await lstat(source);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino)throw fail('RECOVERY_SOURCE_CHANGED','Backup source changed');
    const precise=await lstat(source,{bigint:true});
    if(Number(precise.mtimeNs)/1000000!==after.mtimeMs&&Math.abs(Number(precise.mtimeNs)/1000000-after.mtimeMs)>0.001)throw fail('RECOVERY_SOURCE_CHANGED','Backup source changed');
    verified.add(sha256);files.push({name,sha256,size:before.size,mtimeMs:before.mtimeMs,mtimeNs:precise.mtimeNs.toString()});bytes+=before.size;onProgress({files:files.length,bytes});
   }
   async function walk(source,name){const info=await lstat(source);if(info.isSymbolicLink())throw fail('RECOVERY_PATH_INVALID','Recovery may not follow links');if(info.isDirectory()){for(const child of (await readdir(source)).sort())await walk(join(source,child),name+'/'+child);}else await add(source,name);}
   const snapshot=join(work,'mirea.sqlite');await backup(db,snapshot,{rate:128});const sealed=new DatabaseSync(snapshot);try{sealed.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');}finally{sealed.close();}checkDatabase(snapshot,{full:true});await add(snapshot,'data/mirea.sqlite');
   if(scope==='full'){
    for(const name of (await readdir(dataDir)).sort()){
     const source=join(dataDir,name);if(['mirea.sqlite','mirea.sqlite-wal','mirea.sqlite-shm','mirea.sqlite-journal','recovery-transition.json'].includes(name)||within(directory,source)||within(source,directory))continue;
     await walk(source,'data/'+name);
    }
    if(mediaDir!==dataDir)for(const name of (await readdir(mediaDir)).sort())await walk(join(mediaDir,name),'media/'+name);
   }else{
    for(const name of ['keys','storage-layout.json','recovery-runtime.json'])if(await exists(join(dataDir,name)))await walk(join(dataDir,name),'data/'+name);
   }
   for(const entry of configuration)if(entry.bytes!==undefined){const file=join(work,randomUUID());await writeFile(file,entry.bytes,{mode:0o600,flag:'wx'});await add(file,'configuration/'+entry.name);}else if(await exists(entry.path))await add(entry.path,'configuration/'+entry.name);
   // Metadata snapshots must not publish a key set that changed while SQLite was copied.
   for(const file of files.filter(f=>f.name.startsWith('data/keys/')))if(await fileHash(join(dataDir,...file.name.slice(5).split('/')))!==file.sha256)throw fail('RECOVERY_SOURCE_CHANGED','Backup key changed');
   const manifest={format:1,id,createdAt:now,scope,reason,version,previousVersion,separate:mediaDir!==dataDir,storageId,database:checkDatabase(snapshot),files,bytes};
   const envelope={manifest,sha256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')};
   validateManifest(envelope);
   await durableJson(join(work,'manifest.json'),envelope);await syncDirectory(join(directory,'objects'));
   const published=join(directory,'snapshots',id);await mkdir(published,{mode:0o700});await rename(join(work,'manifest.json'),join(published,'manifest.json'));
   const summary=summarize(manifest);await durableJson(join(published,'summary.json'),{summary,sha256:createHash('sha256').update(JSON.stringify(summary)).digest('hex')});await syncDirectory(published);await syncDirectory(join(directory,'snapshots'));summaryCache=null;
   return manifest;
  }finally{
   // Only our flat, UUID-named scratch files are removable; never traverse a live tree.
   try{if(await exists(work)){for(const name of await readdir(work)){const file=join(work,name),info=await lstat(file);if(info.isFile()&&!info.isSymbolicLink())await unlink(file);}const {rmdir}=await import('node:fs/promises');await rmdir(work);}}finally{busy=false;}
  }
 }
 async function prune({now=Date.now(),retentionDays=30,collectObjects=false}={}){
  if(busy)return;const snapshots=await list();if(snapshots.some(s=>s.invalid))return;
  const keep=new Set(),buckets=new Set();
  for(const snapshot of snapshots){
   // Upgrade and explicit manual checkpoints are never expired automatically.
   if(snapshot.reason==='pre-upgrade'||snapshot.reason==='manual'){keep.add(snapshot.id);continue;}
   const age=now-snapshot.createdAt;
   const bucket=age<86400000?'recent:'+snapshot.id:age<7*86400000?'hour:'+Math.floor(snapshot.createdAt/3600000):'day:'+Math.floor(snapshot.createdAt/86400000);
   if(age<retentionDays*86400000&&!buckets.has(snapshot.scope+bucket)){buckets.add(snapshot.scope+bucket);keep.add(snapshot.id);}
  }
  // Always retain at least the latest two points of each scope, even after prolonged downtime.
  for(const scope of ['database','full'])snapshots.filter(s=>s.scope===scope).slice(0,2).forEach(s=>keep.add(s.id));
  for(const snapshot of snapshots)if(!keep.has(snapshot.id)){await unlink(join(directory,'snapshots',snapshot.id,'manifest.json'));await unlink(join(directory,'snapshots',snapshot.id,'summary.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});const {rmdir}=await import('node:fs/promises');await rmdir(join(directory,'snapshots',snapshot.id));}summaryCache=null;
  if(!collectObjects)return;
  const references=new Set();for(const snapshot of snapshots)if(keep.has(snapshot.id))for(const file of (await readManifest(directory,snapshot.id)).files)references.add(file.sha256);
  for(const name of await readdir(join(directory,'objects'))){if(!SHA.test(name)||references.has(name))continue;const file=objectPath(name),info=await lstat(file);if(info.isFile()&&!info.isSymbolicLink()&&info.mtimeMs<now-86400000)await unlink(file);}
 }
 return {directory,list,capture,verify,prune,objectPath};
}

export async function restoreRecoveryPoint({directory,id,destination,metadataOnly=false}){
 directory=resolve(directory);destination=resolve(destination);
 if(within(directory,destination)||within(destination,directory))throw fail('RECOVERY_PATH_INVALID','Restore destination must be separate from the backup store');
 const manifest=await readManifest(directory,id);if(manifest.scope!=='full'&&!metadataOnly)throw fail('RECOVERY_MEDIA_NOT_INCLUDED','This snapshot contains no media; select a full recovery point');
 const root=await exists(destination);if(root&&(!root.isDirectory()||root.isSymbolicLink()||(await readdir(destination)).length))throw fail('RECOVERY_DESTINATION_NOT_EMPTY','Restore destination must be empty');
 // Validate every object before creating any restored state.
 await verifyRecoveryPoint(directory,id);
 await mkdir(destination,{recursive:true,mode:0o700});await mkdir(join(destination,'data'),{mode:0o700});const incomplete=join(destination,'data','.mirea-restore-incomplete');await durableJson(incomplete,{id});
 // PAX preserves nanosecond mtimes, which existing encrypted downloads use to
 // identify the source. Do not round file timestamps with JavaScript utimes.
 const tar=process.platform==='win32'?join(process.env.SystemRoot??'C:/Windows','System32','tar.exe'):'/usr/bin/tar';
 const child=spawn(tar,['-x','-k','-f','-','-C',destination],{windowsHide:true,stdio:['pipe','ignore','ignore']});
 const completed=new Promise((yes,no)=>{child.once('error',no);child.once('exit',code=>code===0?yes():no(fail('RECOVERY_EXTRACT_FAILED','Recovery extraction failed')));});
 try{await Promise.all([pipeline(tarBackupStream(manifest.files.map(file=>({...file,path:join(directory,'objects',file.sha256),mtime:file.mtimeMs}))),child.stdin),completed]);}catch(error){child.kill();await completed.catch(()=>{});throw error;}
 for(const file of manifest.files){const target=join(destination,...file.name.split('/'));if(!within(destination,target))throw fail('RECOVERY_PATH_INVALID','Unsafe restore target');const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink()||await fileHash(target)!==file.sha256)throw fail('RECOVERY_CHECKSUM_MISMATCH','Restored content verification failed');const handle=await open(target,'r+');try{await handle.sync();}finally{await handle.close();}}
 checkDatabase(join(destination,'data','mirea.sqlite'),{full:true});await unlink(incomplete);await syncDirectory(join(destination,'data'));await durableJson(join(destination,'restore-result.json'),{format:1,snapshot:id,scope:manifest.scope,previousVersion:manifest.previousVersion,createdBy:manifest.version,files:manifest.files.length,restoredAt:Date.now(),verified:true});return manifest;
}
