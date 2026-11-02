// Isolated source/data upgrade rehearsal. It never connects to a running server.
// The previous revision is exported without changing the current checkout.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,createDecipheriv,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm,lstat,readdir} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const fromCommit=process.argv.find(value=>value.startsWith('--from-commit='))?.slice(14);
if(!/^[a-f0-9]{40}$/.test(fromCommit??''))throw Error('Pass an independently verified published commit with --from-commit=<40-character-sha>');
const git=process.env.MIREA_GIT??'git';
const actual=execFileSync(git,['rev-parse',`${fromCommit}^{commit}`],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
assert.equal(actual,fromCommit,'The previous revision must be a commit, not a movable reference');
const local=join(root,'.local');await mkdir(local,{recursive:true});
const work=await mkdtemp(join(local,'source-upgrade-'));
const previous=join(work,'previous');await mkdir(previous);
const tar=process.platform==='win32'?join(process.env.SystemRoot??'C:/Windows','System32','tar.exe'):'tar';
const archive=join(work,'previous.tar');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let app;
const request=(method,path,token,payload,headers={})=>app.inject({method,url:path,headers:{...(token?{authorization:'Bearer '+token}:{}),...headers},...(payload===undefined?{}:{payload})});
const json=async(method,path,token,payload)=>{
  const result=await request(method,'/api/v1'+path,token,payload);
  assert(result.statusCode>=200&&result.statusCode<300,`${method} ${path}: ${result.statusCode} ${result.body}`);
  return result.statusCode===204?null:result.json();
};
async function close(){if(app){const closing=app;app=null;await closing.close();}}
function pdf(){
  const content='BT /F1 18 Tf 30 200 Td (Synthetic upgrade fixture) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let body='%PDF-1.4\n';const offsets=[];
  objects.forEach((value,index)=>{offsets.push(Buffer.byteLength(body));body+=`${index+1} 0 obj\n${value}\nendobj\n`;});
  const xref=Buffer.byteLength(body);return Buffer.from(body+`xref\n0 6\n0000000000 65535 f \n`+offsets.map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
const bytes=pdf();
async function stageUpload(token,shelf,series,title){
  const upload=await json('POST',`/shelves/${shelf}/uploads`,token,{title,seriesId:series,files:[{filename:'fixture.pdf',mime:'application/pdf',size:bytes.length}]});
  const part=await request('PUT',`/api/v1/uploads/${upload.id}/files/0/parts/0`,token,bytes,{'content-type':'application/octet-stream','x-chunk-sha256':hash(bytes)});
  assert.equal(part.statusCode,204,part.body);return upload.id;
}
async function completeUpload(token,id){
  await json('POST',`/uploads/${id}/complete`,token);
  for(let n=0;n<900;n++){
    const state=await json('GET',`/uploads/${id}`,token);
    if(state.state==='complete')return state.item;
    assert.notEqual(state.state,'failed',state.error);await delay(100);
  }
  throw Error('Synthetic upload processing did not finish');
}
async function treeSnapshot(folder){
  const result={};
  async function walk(current,prefix){
    for(const entry of await readdir(current,{withFileTypes:true})){
      const path=join(current,entry.name),name=prefix+entry.name,info=await lstat(path);
      assert(!info.isSymbolicLink(),'Synthetic backup must not contain links');
      if(entry.isDirectory())await walk(path,name+'/');
      else if(entry.isFile())result[name]={sha256:hash(await readFile(path)),mtimeMs:info.mtimeMs};
      else throw Error('Unexpected synthetic backup entry');
    }
  }
  await walk(folder,'');return result;
}
function decode(encrypted,grant,size){
  const key=Buffer.from(grant.key,'base64');
  try{const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(0,12));decipher.setAAD(Buffer.from(`mirea-download-v1|${grant.manifest.id}|0|0|${size}`));decipher.setAuthTag(encrypted.subarray(-16));return Buffer.concat([decipher.update(encrypted.subarray(12,-16)),decipher.final()]);}
  finally{key.fill(0);}
}
async function verifyState(state,{pending=true}={}){
  const {token,userId,shelf,parent,child,item,download,encrypted}=state;
  assert.equal((await json('GET','/auth/me',token)).user.id,userId,'Existing login session survives');
  const login=await json('POST','/auth/login',null,{email:state.email,password:state.password});assert.equal(login.user.id,userId,'Password still authenticates');
  const catalog=await json('GET','/library/catalog',token);
  assert(catalog.shelves.some(value=>value.id===shelf));
  assert(catalog.series.some(value=>value.id===child&&value.parentId===parent));
  assert(catalog.items.some(value=>value.id===item&&value.series.id===child));
  assert.equal((await json('GET',`/items/${item}/progress`,token)).progress.scrollY,.5);
  const history=await json('GET','/analytics/me/summary',token);assert(history.assets.some(value=>value.assetId===item));
  const content=await request('GET',`/api/v1/items/${item}/content`,token);assert.equal(content.statusCode,200);assert.deepEqual(content.rawPayload,bytes);
  const ranged=await request('GET',`/api/v1/items/${item}/content`,token,undefined,{range:'bytes=5-20'});assert.equal(ranged.statusCode,206);assert.deepEqual(ranged.rawPayload,bytes.subarray(5,21));
  const grant=await json('POST',`/downloads/${download}/open`,token,{});assert.equal(grant.userId,userId);assert.equal(grant.expiresAt-grant.serverTime,7*86400000);
  assert.equal(grant.key,state.grantKey,'Existing encrypted download key is unchanged');
  assert.deepEqual(decode(encrypted,grant,bytes.length),bytes,'Previously downloaded ciphertext still decrypts');grant.key='';
  if(pending){const upload=await json('GET',`/uploads/${state.pending}`,token);assert.equal(upload.state,'uploading');}
  assert.equal((await request('GET','/api/v1/library/catalog')).statusCode,401);
}
try{
  execFileSync(git,['archive','--format=tar',`--output=${archive}`,fromCommit,'server','package.json','pnpm-lock.yaml'],{cwd:root,windowsHide:true});
  execFileSync(tar,['-xf',archive,'-C',previous],{windowsHide:true});
  const previousPackage=JSON.parse(await readFile(join(previous,'package.json'),'utf8'));
  const candidatePackage=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const oldCreate=(await import(pathToFileURL(join(previous,'server/app.js')).href)).createApp;
  const newCreate=(await import(pathToFileURL(join(root,'server/app.js')).href)).createApp;
  const reports=[];
  for(const separate of [false,true]){
    const fixture=join(work,separate?'separate':'combined');await mkdir(fixture);
    const dataDir=join(fixture,'data'),mediaDir=separate?join(fixture,'media'):undefined;
    if(mediaDir)await mkdir(mediaDir);
    const options={dataDir,mediaDir:mediaDir??dataDir,allowRegistration:true,serverAdminUserIds:[],rateLimit:false,logger:false};
    app=await oldCreate(options);
    assert.equal((await request('GET','/api/health')).json().version,previousPackage.version);
    const email=randomUUID()+'@example.invalid',password=randomUUID()+'-synthetic';
    const session=await json('POST','/auth/register',null,{name:'Synthetic upgrade reader',email,password}),token=session.token;
    const shelf=(await json('POST','/shelves',token,{name:'Synthetic upgrade shelf'})).id;
    const parent=(await json('POST',`/shelves/${shelf}/series`,token,{title:'Parent'})).series.id;
    const child=(await json('POST',`/shelves/${shelf}/series`,token,{title:'Child',parentId:parent})).series.id;
    const item=await stageUpload(token,shelf,child,'Persistent PDF');await completeUpload(token,item);
    const progress=await json('GET',`/items/${item}/progress`,token);
    await json('PUT',`/items/${item}/progress`,token,{revision:progress.revision,updateId:randomUUID(),page:1,scrollX:0,scrollY:.5,zoom:'fit'});
    await json('POST','/analytics/events',token,{view:{id:randomUUID(),assetId:item,context:'viewer',platform:'web',clientVersion:'upgrade-fixture'},events:[{id:randomUUID(),seq:1,type:'open',at:Date.now(),elapsedMs:0}]});
    const download=(await json('POST',`/items/${item}/download`,token)).manifest.id;
    const grant=await json('POST',`/downloads/${download}/open`,token,{});
    const part=await request('GET',`/api/v1/downloads/${download}/files/0/parts/0`,token);assert.equal(part.statusCode,200);
    const pending=await stageUpload(token,shelf,child,'Transfer to resume');
    const state={token,userId:session.user.id,email,password,shelf,parent,child,item,download,encrypted:part.rawPayload,grantKey:grant.key,pending};grant.key='';
    await verifyState(state);await close();

    // PAX preserves sub-millisecond mtimes used by existing download manifests.
    // Node fs.cp's timestamp conversion can round them on Windows.
    const config={storage:separate?'separate':'combined',fromVersion:previousPackage.version};
    await writeFile(join(fixture,'synthetic-config.json'),JSON.stringify(config));
    const before={data:await treeSnapshot(dataDir),...(mediaDir?{media:await treeSnapshot(mediaDir)}:{})};
    const backup=join(fixture,'full-backup.tar');
    execFileSync(tar,['--format=pax','-cf',backup,'-C',fixture,'data',...(mediaDir?['media']:[]),'synthetic-config.json'],{windowsHide:true});
    const backupHash=hash(await readFile(backup)),master=await readFile(join(dataDir,'keys','download-master.key'));

    app=await newCreate(options);
    assert.equal((await request('GET','/api/health')).json().version,candidatePackage.version);
    await verifyState(state);await completeUpload(token,pending);await close();
    assert.deepEqual(await readFile(join(dataDir,'keys','download-master.key')),master);
    const db=new DatabaseSync(join(dataDir,'mirea.sqlite'),{readOnly:true});
    try{assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);}finally{db.close();}

    // Restore into new empty paths; never overwrite the upgraded data.
    const restored=join(fixture,'restored');await mkdir(restored);
    execFileSync(tar,['-xf',backup,'-C',restored],{windowsHide:true});
    assert.equal(hash(await readFile(backup)),backupHash,'The full backup remains untouched');
    assert.deepEqual(await treeSnapshot(join(restored,'data')),before.data,'Restore preserves exact bytes and file timestamps');
    if(mediaDir)assert.deepEqual(await treeSnapshot(join(restored,'media')),before.media);
    assert.deepEqual(JSON.parse(await readFile(join(restored,'synthetic-config.json'),'utf8')),config);
    app=await oldCreate({...options,dataDir:join(restored,'data'),mediaDir:join(restored,mediaDir?'media':'data')});
    await verifyState(state);await close();
    assert.deepEqual(await readFile(join(restored,'data/keys/download-master.key')),master);master.fill(0);state.grantKey='';
    reports.push({storage:separate?'separate':'combined',oldToCandidate:true,fullBackupRestoredWithOldCode:true,existingLogin:true,passwordLogin:true,nestedSeries:true,progressAndHistory:true,originalAndRange:true,existingEncryptedDownload:true,pendingUploadResumed:true,foreignKeysValid:true});
  }
  console.log(JSON.stringify({success:true,fromCommit,fromVersion:previousPackage.version,candidateVersion:candidatePackage.version,verification:'source-and-data integration using shared installed dependencies; no deployed server, container or Android device',backupMethod:'stopped-filesystem-pax-copy',adminBackupCovered:false,reports},null,2));
}finally{
  await close();
  if(!resolve(work).startsWith(resolve(local)+sep+'source-upgrade-'))throw Error('Unsafe synthetic workspace cleanup');
  await rm(work,{recursive:true,force:true});
}
