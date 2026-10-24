import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,mkdir,writeFile,readFile,access,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {selectVideoSource} from '../server/media-source.js';
import {makePdf,makeMp4} from './fixtures.js';
import {createMediaProcessor} from '../server/media.js';

const password='maintenance-test-password';
async function setup(t,extra={}){
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-maintenance-')),options={dataDir,rateLimit:false,cleanupGraceMs:0,serverAdminUserIds:[],...extra},app=await createApp(options),db=new DatabaseSync(join(dataDir,'mirea.sqlite'));db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{await app.close();db.close();await rm(dataDir,{recursive:true,force:true});});
  const req=(method,path,user,body)=>app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},...(body!==undefined?{payload:body}:{})});
  const register=async name=>(await req('POST','/auth/register',null,{name,email:name+'@example.test',password})).json();
  const admin=await register('admin'),reader=await register('reader');options.serverAdminUserIds.push(admin.user.id);
  const shelf=(await req('POST','/shelves',reader,{name:'Private shelf'})).json().id;
  const asset=async(mime='application/pdf',bytes=makePdf())=>{const id=randomUUID();await writeFile(join(dataDir,'uploads',id),bytes);db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,'fixture',?,?,?,?)").run(id,shelf,'Private sample',mime,bytes.length,reader.user.id,Date.now());return id;};
  const wait=async id=>{for(let n=0;n<300;n++){const row=db.prepare('SELECT * FROM admin_jobs WHERE id=?').get(id);if(['complete','failed'].includes(row?.state))return row;await new Promise(r=>setTimeout(r,50));}throw Error('Job timeout');};
  return {dataDir,app,db,req,admin,reader,shelf,asset,wait};
}
test('new resumable video/audio requests retain originals by default and still honor explicit opt-out',async t=>{
  const c=await setup(t);
  for(const [mime,filename] of [['video/mp4','source.mp4'],['audio/mpeg','source.mp3']]){
    for(const flag of [undefined,false,true]){const r=await c.req('POST',`/shelves/${c.shelf}/uploads`,c.reader,{title:'Policy',files:[{filename,mime,size:100}],...(flag===undefined?{}:{retainOriginal:flag})});assert.equal(r.statusCode,201,r.body);assert.equal(r.json().retainOriginal,flag!==false);assert.equal((await c.req('DELETE','/uploads/'+r.json().id,c.reader)).statusCode,204);}
  }
});
test('individual and whole-asset regeneration require enabled admin plus warning but no password; history replay is retired',async t=>{
  const c=await setup(t),ids=[await c.asset(),await c.asset()];
  assert.equal((await c.req('POST',`/admin/assets/${ids[0]}/regenerate`,c.admin,{kind:'thumbnail'})).statusCode,400);
  assert.equal((await c.req('POST',`/admin/assets/${ids[0]}/regenerate`,c.reader,{kind:'thumbnail',acknowledgeCost:true})).statusCode,403);
  const old=[];
  for(const id of ids){const r=await c.req('POST',`/admin/assets/${id}/regenerate`,c.admin,{kind:'thumbnail',acknowledgeCost:true});assert.equal(r.statusCode,202,r.body);old.push(r.json().job);assert.equal((await c.wait(r.json().job.id)).state,'complete');}
  let r=await c.req('POST','/admin/assets/regenerate-all',c.admin,{kind:'thumbnail',acknowledgeCost:true});assert.equal(r.statusCode,202,r.body);assert.equal(r.json().accepted,2);for(const entry of c.db.prepare("SELECT id FROM admin_jobs WHERE state IN ('queued','running')").all())assert.equal((await c.wait(entry.id)).state,'complete');
  r=await c.req('POST','/admin/jobs/retry',c.admin,{jobs:[{type:'job',id:old[0].id}],acknowledgeCost:true});assert.equal(r.statusCode,410);
  assert.equal((await c.req('POST','/admin/jobs/retry',c.reader,{jobs:[{type:'job',id:old[0].id}],acknowledgeCost:true})).statusCode,403);
  assert.equal((await c.req('POST','/admin/assets/regenerate-all',c.reader,{kind:'thumbnail',acknowledgeCost:true})).statusCode,403);
  assert.equal((await c.req('POST','/admin/assets/regenerate-all',c.admin,{kind:'thumbnail'})).statusCode,400);
  assert.equal((await c.req('POST','/admin/backups',c.admin,{mode:'metadata',backupPassword:'separate-backup-password',acknowledgeSensitive:true})).statusCode,400);
  assert.equal((await c.req('PATCH','/admin/users/'+c.reader.user.id,c.admin,{disabled:true})).statusCode,400);
});
test('cleanup scans only safe media, protects live generations/retry sources/secrets and rechecks readers and changed files before confirmed deletion',async t=>{
  const c=await setup(t),live=await c.asset(),orphan=randomUUID(),failed=randomUUID();
  await writeFile(join(c.dataDir,'uploads',orphan),'orphan bytes');await mkdir(join(c.dataDir,'videos',live));await writeFile(join(c.dataDir,'videos',live,'old-generation.mp4'),'must stay');
  await mkdir(join(c.dataDir,'uploads','transfers',failed));await writeFile(join(c.dataDir,'uploads','transfers',failed,'0-0'),'retry raw');
  const session=c.db.prepare('SELECT id FROM sessions WHERE user_id=?').get(c.reader.user.id).id;
  c.db.prepare("INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at) VALUES(?,?,?,?,?,?,1,'failed',0,0)").run(failed,c.shelf,c.reader.user.id,session,'Failed retained source',JSON.stringify([{filename:'source.mp4',mime:'video/mp4',size:9}]));
  assert.equal((await c.req('POST','/admin/cleanup/scan',c.reader)).statusCode,403);
  const scan=()=>c.req('POST','/admin/cleanup/scan',c.admin).then(r=>{assert.equal(r.statusCode,200,r.body);return r.json();});
  const remove=(s,ids,extra={})=>c.req('POST','/admin/cleanup/delete',c.admin,{scanId:s.scanId,ids,confirmDelete:'DELETE',acknowledgeUnrecoverable:true,currentPassword:password,...extra});
  let s=await scan();assert(s.candidates.some(r=>r.assetId===orphan));assert(!s.candidates.some(r=>[live,failed].includes(r.assetId)));assert(!s.candidates.some(r=>r.title.includes('keys/')));
  const candidate=s.candidates.find(r=>r.assetId===orphan);
  assert.equal((await remove(s,[candidate.id],{currentPassword:'wrong-password'})).statusCode,403);await access(join(c.dataDir,'uploads',orphan));
  assert.equal((await remove(s,[randomUUID()])).statusCode,400);
  await writeFile(join(c.dataDir,'uploads',orphan),'changed orphan bytes');assert.equal((await remove(s,[candidate.id])).json().results[0].deleted,false);await access(join(c.dataDir,'uploads',orphan));
  c.db.prepare("INSERT INTO user_access VALUES(?,'user',1)").run(c.reader.user.id);s=await scan();const invisible=s.candidates.find(r=>r.kind==='asset'&&r.assetId===live);assert(invisible);
  c.db.prepare('UPDATE user_access SET disabled=0 WHERE user_id=?').run(c.reader.user.id);assert.equal((await remove(s,[invisible.id])).json().results[0].deleted,false);await access(join(c.dataDir,'uploads',live));
  s=await scan();const orphanOnly=s.candidates.find(r=>r.assetId===orphan);let r=await remove(s,[orphanOnly.id]);assert.equal(r.json().results[0].deleted,true);await assert.rejects(access(join(c.dataDir,'uploads',orphan)),{code:'ENOENT'});
  c.db.prepare('UPDATE user_access SET disabled=1 WHERE user_id=?').run(c.reader.user.id);s=await scan();r=await remove(s,[s.candidates.find(r=>r.kind==='asset'&&r.assetId===live).id]);assert.equal(r.json().results[0].deleted,true,r.body);assert.equal(c.db.prepare('SELECT 1 FROM items WHERE id=?').get(live),undefined);
  await assert.rejects(access(join(c.dataDir,'uploads',live)),{code:'ENOENT'});await assert.rejects(access(join(c.dataDir,'videos',live)),{code:'ENOENT'});await access(join(c.dataDir,'uploads','transfers',failed,'0-0'));await access(join(c.dataDir,'keys','download-master.key'));
});
test('cleanup never follows directory links and excludes recently changed orphans under its production grace policy',async t=>{
  const c=await setup(t,{cleanupGraceMs:3600000}),outside=await mkdtemp(join(tmpdir(),'mirea-preserved-'));t.after(()=>rm(outside,{recursive:true,force:true}));await writeFile(join(outside,'preserve.txt'),'outside');
  const id=randomUUID(),recent=randomUUID();await symlink(outside,join(c.dataDir,'videos',id),process.platform==='win32'?'junction':'dir');await writeFile(join(c.dataDir,'uploads',recent),'recent orphan');
  const r=await c.req('POST','/admin/cleanup/scan',c.admin);assert.equal(r.statusCode,200,r.body);assert(!r.json().candidates.some(row=>[id,recent].includes(row.assetId)));assert(r.json().skippedUnsafe>0);assert.equal(await readFile(join(outside,'preserve.txt'),'utf8'),'outside');
});
test('missing originals select the highest available canonical or historical rendition and never overwrite or invent a raw original',async t=>{
  const c=await setup(t),id=await c.asset(),generation=randomUUID(),videoDir=join(c.dataDir,'videos'),originalDir=join(c.dataDir,'originals'),uploadDir=join(c.dataDir,'uploads');
  await mkdir(join(videoDir,id,generation),{recursive:true});await writeFile(join(videoDir,id,generation,'1080p.mp4'),'old best');
  const metadata={generation,renditions:[{quality:'1080p',width:1920,height:1080,bitrate:5000000}]};c.db.prepare('INSERT INTO video_generations VALUES(?,?,?,?)').run(id,generation,JSON.stringify(metadata),Date.now());
  const args={db:c.db,item:{id},videoDir,originalDir,uploadDir,probe:async()=>({width:640,height:360,video:{width:640,height:360}})};
  let source=await selectVideoSource(args);assert.equal(source.kind,'best-available');assert.equal(source.path,join(videoDir,id,generation,'1080p.mp4'));
  source=await selectVideoSource({...args,probe:async()=>({width:3840,height:2160,video:{bit_rate:'20000000'}})});assert.equal(source.path,join(uploadDir,id));
  await writeFile(join(originalDir,id),'raw original');source=await selectVideoSource(args);assert.equal(source.kind,'original');assert.equal(source.path,join(originalDir,id));assert.equal(await readFile(source.path,'utf8'),'raw original');
});
test('failed automatic previews expose a valid asset retry identity, support bulk retry and clear stale failure after success',async t=>{
  const media=createMediaProcessor(),realPreview=media.preview.bind(media);let fail=true;media.preview=async(...args)=>{if(fail){fail=false;throw Error('Planned automatic preview failure');}return realPreview(...args);};
  const c=await setup(t,{mediaProcessor:media}),bytes=await makeMp4(join(c.dataDir,'preview-source.mp4'),{duration:.3,audio:true}),id=await c.asset('video/mp4',bytes);
  assert.equal((await c.req('POST',`/items/${id}/preview`,c.reader)).statusCode,202);
  let failed;for(let n=0;n<100;n++){const rows=(await c.req('GET','/admin/jobs',c.admin)).json().previews;failed=rows.find(row=>row.assetId===id&&row.state==='failed');if(failed)break;await new Promise(r=>setTimeout(r,20));}
  assert(failed);assert.equal(failed.id,id);assert.equal(failed.automatic,true);
  assert.equal((await c.req('POST','/admin/jobs/retry',c.admin,{acknowledgeCost:true,jobs:[{id,type:'asset'}]})).statusCode,410);
  const retried=await c.req('POST','/admin/assets/regenerate-all',c.admin,{acknowledgeCost:true,kind:'preview'});assert.equal(retried.statusCode,202,retried.body);assert.equal(retried.json().accepted,1);assert.equal((await c.wait(c.db.prepare("SELECT id FROM admin_jobs WHERE asset_id=? AND kind='preview' ORDER BY created_at DESC LIMIT 1").get(id).id)).state,'complete');
  assert(!(await c.req('GET','/admin/jobs',c.admin)).json().previews.some(row=>row.assetId===id&&row.state==='failed'));assert((await readFile(join(c.dataDir,'previews',id+'.mp4'))).length>100);
});

test('whole-asset regeneration includes assets with no history, drains more than twenty durable jobs and separates history from current work',async t=>{
  const media=createMediaProcessor();let active=0,maximum=0;
  media.thumbnail=async(source,mime,destination)=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,5));await writeFile(destination,'synthetic thumbnail');active--;};media.validateImage=async()=>({width:1,height:1});
  const c=await setup(t,{mediaProcessor:media});for(let n=0;n<25;n++)await c.asset();
  const deleted=randomUUID();c.db.prepare("INSERT INTO admin_jobs(id,kind,state,created_at,updated_at) VALUES(?,'thumbnail','complete',0,0)").run(deleted);
  const r=await c.req('POST','/admin/assets/regenerate-all',c.admin,{kind:'thumbnail',acknowledgeCost:true});assert.equal(r.statusCode,202,r.body);assert.equal(r.json().accepted,25);
  const running=(await c.req('GET','/admin/jobs',c.admin)).json();assert.equal(running.currentCount,25);assert(running.currentJobs.every(j=>['queued','running'].includes(j.state)));assert(running.history.jobs.some(j=>j.id===deleted));
  for(const job of c.db.prepare('SELECT id FROM admin_jobs WHERE asset_id IS NOT NULL').all())assert.equal((await c.wait(job.id)).state,'complete');assert.equal(maximum,5);
  const finished=(await c.req('GET','/admin/jobs',c.admin)).json();assert.equal(finished.currentCount,0);assert.equal(finished.currentJobs.length,0);assert.equal(finished.history.jobs.length,26);
  const videos=await c.req('POST','/admin/assets/regenerate-all',c.admin,{kind:'transcode',acknowledgeCost:true});assert.equal(videos.json().accepted,0);
});

test('processing uploads appear as ACL-scoped non-playable placeholders and disappear from pending results after publication',async t=>{
  const c=await setup(t),session=c.db.prepare('SELECT id FROM sessions WHERE user_id=?').get(c.reader.user.id).id,id=randomUUID();
  assert.equal((await c.req('POST',`/shelves/${c.shelf}/members`,c.reader,{email:'admin@example.test',role:'viewer'})).statusCode,201);
  c.db.prepare("INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at,processing_json) VALUES(?,?,?,?,?,?,1,'processing',?,?,?)").run(id,c.shelf,c.reader.user.id,session,'Processing video',JSON.stringify([{filename:'source.mkv',mime:'video/x-matroska',size:99}]),Date.now(),Date.now()+60000,JSON.stringify({stage:'transcode',percent:37}));
  for(const user of [c.reader,c.admin]){const r=await c.req('GET',`/shelves/${c.shelf}/items`,user);assert.equal(r.statusCode,200);const row=r.json().pendingUploads.find(i=>i.id===id);assert(row.pending);assert.equal(row.processing.percent,37);assert.equal(row.kind,'video');assert(!('files_json' in row));assert(!('thumbnailUrl' in row));assert.equal((await c.req('POST',`/items/${id}/playback-ticket`,user)).statusCode,404);}
  assert.equal((await c.req('GET','/uploads',c.reader)).json().activeCount,1);assert.equal((await c.req('GET','/uploads',c.admin)).json().activeCount,0);
  const outsider=(await c.req('POST','/auth/register',null,{name:'outsider',email:'outsider@example.test',password})).json();assert.equal((await c.req('GET',`/shelves/${c.shelf}/items`,outsider)).statusCode,404);
  c.db.prepare("UPDATE upload_sessions SET state='complete' WHERE id=?").run(id);assert.equal((await c.req('GET',`/shelves/${c.shelf}/items`,c.reader)).json().pendingUploads.length,0);
});

test('restart drains a persisted whole-asset queue beyond the twenty-job execution window',async t=>{
  const c=await setup(t);for(let n=0;n<25;n++){const asset=await c.asset();c.db.prepare("INSERT INTO admin_jobs(id,kind,asset_id,state,requested_by,created_at,updated_at) VALUES(?,'thumbnail',?,'queued',?,0,0)").run(randomUUID(),asset,c.admin.user.id);}
  await c.app.close();
  const media=createMediaProcessor();media.thumbnail=async(source,mime,destination)=>writeFile(destination,'synthetic thumbnail');media.validateImage=async()=>({width:1,height:1});
  const restarted=await createApp({dataDir:c.dataDir,rateLimit:false,serverAdminUserIds:[c.admin.user.id],mediaProcessor:media});
  try{for(const row of c.db.prepare('SELECT id FROM admin_jobs').all())assert.equal((await c.wait(row.id)).state,'complete');assert.equal(c.db.prepare("SELECT COUNT(*) n FROM admin_jobs WHERE state='complete'").get().n,25);}finally{await restarted.close();}
});

test('only the current shelf owner can rename/delete; deletion confirms password/name and preserves other shelves, accounts and encryption keys',async t=>{
  const c=await setup(t),item=await c.asset(),other=(await c.req('POST','/shelves',c.reader,{name:'Keep shelf'})).json().id;
  const key=await readFile(join(c.dataDir,'keys','download-master.key'));
  assert.equal((await c.req('PATCH',`/shelves/${c.shelf}`,c.admin,{name:'Forbidden'})).statusCode,404);
  await c.req('POST',`/shelves/${c.shelf}/members`,c.reader,{email:'admin@example.test',role:'viewer'});
  assert.equal((await c.req('PATCH',`/shelves/${c.shelf}`,c.admin,{name:'Forbidden'})).statusCode,403);
  assert.equal((await c.req('PATCH',`/shelves/${c.shelf}`,c.reader,{name:'   '})).statusCode,400);
  assert.equal((await c.req('PATCH',`/shelves/${c.shelf}`,c.reader,{name:'Renamed shelf'})).statusCode,200);
  const body={currentPassword:password,confirmName:'Renamed shelf',acknowledgeDelete:true};
  assert.equal((await c.req('DELETE',`/shelves/${c.shelf}`,c.admin,body)).statusCode,403);
  assert.equal((await c.req('DELETE',`/shelves/${c.shelf}`,c.reader,{...body,currentPassword:'wrong'})).statusCode,403);
  assert.equal((await c.req('DELETE',`/shelves/${c.shelf}`,c.reader,{...body,confirmName:'wrong'})).statusCode,400);await access(join(c.dataDir,'uploads',item));
  assert.equal((await c.req('DELETE',`/shelves/${c.shelf}`,c.reader,body)).statusCode,200);await assert.rejects(access(join(c.dataDir,'uploads',item)),{code:'ENOENT'});
  assert(c.db.prepare('SELECT id FROM shelves WHERE id=?').get(other));assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,2);assert.deepEqual(await readFile(join(c.dataDir,'keys','download-master.key')),key);
});
