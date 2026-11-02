import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createJobPool,createJobLanes} from '../server/job-pool.js';
import {createMediaPipeline} from '../server/media-pipeline.js';
import {openDatabase,transaction} from '../server/database.js';
import {createApp} from '../server/app.js';
import {planUploads,validateUploadPlan} from '../web/src/upload-batch.js';
import {folderUploadJobs} from '../web/src/folder-upload.js';
import {createMediaProcessor} from '../server/media.js';
import sharp from 'sharp';
import {encoderThreads} from '../server/video-transcode.js';
import {createMaintenanceGate} from '../server/maintenance-gate.js';
import {encryptBackup,decryptBackup} from '../server/backup-archive.js';
import Fastify from 'fastify';
import {gunzipSync} from 'node:zlib';
const tick=()=>new Promise(r=>setImmediate(r));
const config={maxUploadBytes:1024**2,maxBookPages:1000,maxImageBytes:1024,maxUploadAssets:1000};
function file(path){const f=new File(['synthetic'],path.split('/').at(-1));Object.defineProperty(f,'webkitRelativePath',{value:path});return f;}
test('the execution slot is released before completion or failure reaches its consumer',async()=>{
 const pool=createJobPool(()=>1);await pool.run(()=>42);assert.equal(pool.running,0);
 await assert.rejects(pool.run(()=>{throw Error('synthetic');}),/synthetic/);assert.equal(pool.running,0);assert.equal(pool.queued,0);
});
test('capacity notifications replenish 616 tasks without an external timer and react immediately to a higher limit',async()=>{
 let limit=1,next=0,done=0,running=0,max=0,release;const held=new Promise(r=>release=r),pool=createJobPool(()=>limit),all=new Promise((resolve,reject)=>{
  pool.onAvailable(()=>{while(next<616&&pool.running+pool.queued<limit){const id=next++;pool.run(async()=>{max=Math.max(max,++running);try{if(id===0)await held;else await delay(1);}finally{running--;}}).then(()=>{if(++done===616)resolve();},reject);}});
 });await tick();assert.equal(next,1);limit=5;pool.pump();await tick();await tick();assert.equal(max,5);release();await all;assert.equal(done,616);assert.equal(pool.running,0);assert.equal(pool.queued,0);
});
test('616 unique Windows filenames stay unique after title generation, while true edited duplicates still fail',()=>{
 const files=Array.from({length:308},(_,i)=>['mp3','flac'].map(ext=>file(`New/Album ${Math.floor(i/20)}/Track ${i}.${ext}`))).flat(),jobs=folderUploadJobs(files,planUploads);
 assert.equal(jobs.length,616);assert.equal(validateUploadPlan(jobs,config),'');assert.equal(jobs[0].title,'Track 0.flac');assert.equal(jobs[1].title,'Track 0.mp3');
 jobs[1].title=jobs[0].title;const error=validateUploadPlan(jobs,config);assert.match(error,/タイトル/);assert(error.includes(jobs[0].relativePath)&&error.includes(jobs[1].relativePath));
});
test('folder sidecars never become false duplicate assets; identical titles in different folders remain valid',()=>{
 const jobs=folderUploadJobs(['New/A/Song.flac','New/A/Song.log','New/A/Song.cue','New/A/Song.lrc','New/B/Song.flac'].map(file),planUploads);assert.equal(jobs.length,2);assert.equal(validateUploadPlan(jobs,config),'');assert(jobs.every(j=>j.title==='Song'));
 assert.match(validateUploadPlan(planUploads([file('Song.log')]),config),/形式/);
});
test('CPU and memory budgets give a lone encoder spare capacity without oversubscribing a full queue',()=>{
 const memory=8*1024**3;assert(encoderThreads(1,16,memory)>encoderThreads(5,16,memory));assert.equal(encoderThreads(1,128,memory),16);assert.equal(encoderThreads(5,32,512*1024**2,8192*4096),1);
});
test('original retention cleanup waits for a full backup and maintenance waits for an already started cleanup',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mirea-retention-backup-')),db=openDatabase(':memory:'),app=Fastify(),maintenance=createMaintenanceGate(app),id=randomUUID();
 const originalDir=join(dir,'originals');await mkdir(originalDir);
 const source=join(originalDir,id),bytes=Buffer.from('Synthetic original kept consistent with its snapshot.');await writeFile(source,bytes);
 db.exec("INSERT INTO users VALUES('u','backup@example.test','Fixture','fixture',1);INSERT INTO shelves(id,name,created_at) VALUES('s','Fixture',1);INSERT INTO memberships VALUES('s','u','owner')");
 db.prepare("INSERT INTO items VALUES(?,'s','Fixture','fixture.m4a','audio/mp4',?,'u',1,1,0)").run(id,bytes.length);
 db.prepare("INSERT INTO media_ingest(asset_id,source_mime,source_filename,source_size,retain_original,canonical_ready,metadata_json,created_at) VALUES(?,'audio/mp4','fixture.m4a',?,0,1,'{}',1)").run(id,bytes.length);
 const pipeline=await createMediaPipeline(app,{db,originalDir,maintenance,jobPool:createJobLanes(()=>({maxConcurrentJobs:1}))});
 t.after(async()=>{await app.close();db.close();await rm(dir,{recursive:true,force:true});});
 maintenance.setBusy(()=>pipeline.busy);
 const unlock=await maintenance.acquire();
 try{
  // The snapshot includes this source. A periodic collection must not remove
  // it between enumeration and the archive's subsequent filesystem reads.
  const files=[{path:source,name:'data/originals/'+id,size:bytes.length}],destination=join(dir,'full.mireabackup'),password='synthetic-backup-password';
  await Promise.all([pipeline.reapSources(),pipeline.reapSources()]);
  assert.deepEqual(await readFile(source),bytes);assert.equal(db.prepare('SELECT source_removed FROM media_ingest WHERE asset_id=?').get(id).source_removed,0);
  await encryptBackup({files,destination,password});const archive=join(dir,'full.tar.gz');await decryptBackup(destination,archive,password);assert(gunzipSync(await readFile(archive)).includes(bytes));
 }finally{unlock();}
 const collection=pipeline.reapSources();assert.equal(pipeline.busy,true,'filesystem cleanup is reported until its DB/file changes both finish');
 assert.equal(pipeline.reapSources(),collection,'simultaneous triggers share one collection');
 let acquired=false;const waiting=maintenance.acquire().then(release=>{acquired=true;return release;});
 assert.equal(acquired,false);await collection;const release=await waiting;
 try{assert.equal(pipeline.busy,false);assert.equal(db.prepare('SELECT source_removed FROM media_ingest WHERE asset_id=?').get(id).source_removed,1);await assert.rejects(readFile(source),{code:'ENOENT'});}finally{release();}
 // Failed cleanup must release its reservation without marking the source as
 // removed. A corrupt directory fixture simulates a filesystem refusal.
 await mkdir(source);db.prepare('UPDATE media_ingest SET source_removed=0 WHERE asset_id=?').run(id);
 await assert.rejects(pipeline.reapSources());assert.equal(pipeline.busy,false);assert.equal(db.prepare('SELECT source_removed FROM media_ingest WHERE asset_id=?').get(id).source_removed,0);
 const afterFailure=await maintenance.acquire();afterFailure();
});
test('616 durable media tasks drain continuously with one slow first task, preserving each original and dependency',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mirea-queue-0203-')),db=openDatabase(join(dir,'state.sqlite'));const paths=Object.fromEntries(['originalDir','uploadDir','thumbnailDir','previewDir','videoDir','stagingDir'].map(k=>[k,join(dir,k)]));for(const p of Object.values(paths))await mkdir(p);
 const ids=Array.from({length:616},()=>randomUUID()),hooks=[],errors=[],pool=createJobLanes(()=>({maxConcurrentJobs:5}));let running=0,peak=0,started=0,release;const slow=new Promise(r=>release=r),app={log:{error:e=>errors.push(e)},addHook:(_name,fn)=>hooks.push(fn)};
 transaction(db,()=>{db.exec("INSERT INTO users VALUES('u','queue@example.test','Queue','fixture',1);INSERT INTO shelves(id,name,created_at) VALUES('s','Queue',1);INSERT INTO memberships VALUES('s','u','owner')");for(let n=0;n<616;n++){const id=ids[n];db.prepare("INSERT INTO items VALUES(?,'s',?,'fixture.m4a','audio/mp4',8,'u',1,1,0)").run(id,id);db.prepare("INSERT INTO media_ingest(asset_id,source_mime,source_filename,source_size,retain_original,metadata_json,created_at) VALUES(?,'audio/mp4','fixture.m4a',8,1,'{}',1)").run(id);for(const kind of ['thumbnail','transcode'])db.prepare('INSERT INTO media_tasks(id,asset_id,kind,state,created_at,updated_at) VALUES(?,?,?,?,?,1)').run(randomUUID(),id,kind,kind==='thumbnail'?'complete':'queued',n+1);}});
 for(const id of ids)await writeFile(join(paths.originalDir,id),'original');
 const pipeline=await createMediaPipeline(app,{db,...paths,jobPool:pool,maintenance:{tryReserve:()=>()=>{}},adminAccess:{enabled:()=>true},audioTranscoder:{async convert(source,folder){peak=Math.max(peak,++running);const first=started++===0;try{if(first)await slow;await delay(1);await writeFile(join(folder,'audio.m4a'),'fixture!');return {size:8,duration:1};}finally{running--;}}}});
 t.after(async()=>{release();for(const h of hooks)await h();db.close();await rm(dir,{recursive:true,force:true});});
 const advancing=Date.now()+30000;while(started<20&&Date.now()<advancing)await delay(10);assert(started>=20,'later jobs continue while the first is slow');assert.equal(peak,5);release();
 // Durable flush latency varies by host. Prove continuous replenishment rather
 // than confusing slow, still-advancing storage with a stopped queue. Keep an
 // independent finite ceiling, real fsync/WAL FULL and every original intact.
 const states=db.prepare("SELECT state,COUNT(*) n FROM media_tasks WHERE kind='transcode' GROUP BY state"),counts=()=>Object.fromEntries(states.all().map(row=>[row.state,row.n]));
 const drainingAt=performance.now(),deadline=drainingAt+15*60000;let previous=counts().complete??0,lastProgress=drainingAt,longestGap=0;
 while(pipeline.busy){
  await delay(250);const now=performance.now(),current=counts(),completed=current.complete??0;
  if(completed>previous){longestGap=Math.max(longestGap,now-lastProgress);previous=completed;lastProgress=now;}
  assert(now-lastProgress<60000,`durable queue stopped advancing for 60 seconds: ${JSON.stringify(current)}`);
  assert(now<deadline,`durable queue exceeded the finite 15-minute ceiling while advancing; inspect storage flush latency: ${JSON.stringify(current)}`);
 }
 t.diagnostic(`616 durable tasks drained in ${((performance.now()-drainingAt)/1000).toFixed(1)} seconds; longest observed completion gap ${(longestGap/1000).toFixed(1)} seconds; fsync and SQLite durability unchanged`);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM media_tasks WHERE kind='transcode' AND state='complete'").get().n,616);assert.equal(pipeline.busy,false);assert.deepEqual(errors,[]);assert.equal((await readdir(paths.originalDir)).length,616);assert.equal(await readFile(join(paths.originalDir,ids.at(-1)),'utf8'),'original');assert.equal(db.prepare('SELECT COUNT(*) n FROM media_ingest WHERE source_removed=0 AND retain_original=1').get().n,616);
});
test('current job window includes running work even behind hundreds of older queued records',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mirea-job-view-0203-')),app=await createApp({dataDir:dir,rateLimit:false}),db=openDatabase(join(dir,'mirea.sqlite'));t.after(async()=>{await app.close();db.close();await rm(dir,{recursive:true,force:true});});
 const user=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Fixture',email:'view@example.test',password:'queue-fixture-password'}})).json();db.prepare("INSERT INTO user_access VALUES(?,'admin',0)").run(user.user.id);await tick();
 transaction(db,()=>{for(let n=0;n<617;n++)db.prepare("INSERT INTO admin_jobs(id,kind,asset_id,state,requested_by,created_at,updated_at) VALUES(?,'thumbnail',NULL,?,?,?,1)").run(String(n).padStart(4,'0'),n===616?'running':'queued',user.user.id,n+1);});
 const r=await app.inject({url:'/api/v1/admin/jobs',headers:{authorization:'Bearer '+user.token}});assert.equal(r.statusCode,200);assert.equal(r.json().currentJobs[0].id,'0616');assert.equal(r.json().currentCount,617);assert.deepEqual(r.json().currentSummary,{running:1,queued:616});
});

test('bulk regeneration drains beyond its bounded window while a slow first job occupies one lane',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mirea-bulk-0203-')),media=createMediaProcessor(),cover=await sharp({create:{width:4,height:4,channels:3,background:'#123456'}}).png().toBuffer();let running=0,peak=0,started=0,release;const held=new Promise(r=>release=r);
 media.thumbnail=async(_source,_mime,destination)=>{peak=Math.max(peak,++running);try{if(started++===0)await held;await writeFile(destination,cover);}finally{running--;}};
 const options={dataDir:dir,mediaProcessor:media,rateLimit:false,serverAdminUserIds:[]},app=await createApp(options),db=openDatabase(join(dir,'mirea.sqlite'));
 t.after(async()=>{release();await app.close();db.close();await rm(dir,{recursive:true,force:true});});
 const user=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Bulk',email:'bulk@example.test',password:'queue-fixture-password'}})).json();options.serverAdminUserIds.push(user.user.id);
 transaction(db,()=>{db.exec("INSERT INTO shelves(id,name,created_at) VALUES('s','Queue',1)");db.prepare("INSERT INTO memberships VALUES('s',?,'owner')").run(user.user.id);for(let n=0;n<96;n++)db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,'s',?,'fixture.pdf','application/pdf',8,?,1)").run(randomUUID(),'Fixture '+n,user.user.id);});
 const response=await app.inject({method:'POST',url:'/api/v1/admin/assets/regenerate-all',headers:{authorization:'Bearer '+user.token},payload:{kind:'thumbnail',acknowledgeCost:true}});assert.equal(response.statusCode,202,response.body);assert.equal(response.json().accepted,96);
 const moving=Date.now()+30000;while(started<24&&Date.now()<moving)await delay(10);assert(started>=24,'the regeneration window is replenished while the first job is slow');assert.equal(peak,2);release();
 const deadline=Date.now()+120000;while(db.prepare("SELECT 1 FROM admin_jobs WHERE state IN ('queued','running')").get()&&Date.now()<deadline)await delay(20);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM admin_jobs WHERE state='complete'").get().n,96);assert.equal(db.prepare('SELECT COUNT(*) n FROM items WHERE thumbnail_ready=1').get().n,96);
});
