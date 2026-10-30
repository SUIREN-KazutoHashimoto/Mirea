import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,rm,readFile,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/app.js';
import {decryptBackup} from '../server/backup-archive.js';
import {releaseCandidate,RELEASE_PREFIX,newer} from '../server/server-updates.js';
import {makePdf,makeMp4} from './fixtures.js';
import {createMediaProcessor} from '../server/media.js';
import {createVideoTranscoder} from '../server/video-transcode.js';
import {httpError} from '../server/security.js';

const password='admin-test-password';
async function setup(t,extra={}){
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-admin-')),options={dataDir,rateLimit:false,serverAdminUserIds:[],...extra};
  const c={dataDir,options,app:await createApp(options)};c.db=new DatabaseSync(join(dataDir,'mirea.sqlite'));c.db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{await c.app.close();c.db.close();await rm(dataDir,{recursive:true,force:true});});
  c.req=(method,path,user,body,headers={})=>c.app.inject({method,url:'/api/v1'+path,headers:{...(user?{authorization:'Bearer '+user.token}:{}),...headers},...(body?{payload:body}:{})});
  c.register=async name=>{const r=await c.req('POST','/auth/register',null,{name,email:name+'@example.test',password});assert.equal(r.statusCode,201,r.body);return r.json();};
  c.login=async user=>{const r=await c.req('POST','/auth/login',null,{email:user.user.email,password});assert.equal(r.statusCode,200,r.body);return r.json();};
  c.admin=await c.register('admin');c.reader=await c.register('reader');c.other=await c.register('other');options.serverAdminUserIds.push(c.admin.user.id);
  c.shelf=(await c.req('POST','/shelves',c.reader,{name:'Private shelf'})).json().id;
  c.asset=async(mime='application/pdf',bytes=makePdf())=>{
    const id=randomUUID();await writeFile(join(dataDir,'uploads',id),bytes);
    c.db.prepare(`INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,'fixture',?,?,?,?)`).run(id,c.shelf,'Private title',mime,bytes.length,c.reader.user.id,Date.now());return id;
  };
  c.job=async id=>{for(let n=0;n<200;n++){const row=c.db.prepare('SELECT * FROM admin_jobs WHERE id=?').get(id);if(['complete','failed'].includes(row?.state))return row;await delay(50);}throw Error('Job timeout');};
  return c;
}

test('only enabled server admins see admin APIs; content ACL and personal telemetry isolation remain separate',async t=>{
  const c=await setup(t),asset=await c.asset();
  for(const path of ['/admin/overview','/admin/storage-usage','/admin/jobs','/admin/users','/admin/shelves','/admin/backups','/admin/updates/status','/admin/audit']){
    assert.equal((await c.req('GET',path,null)).statusCode,401,path);
    assert.equal((await c.req('GET',path,c.reader)).statusCode,403,path);
    assert.equal((await c.req('GET',path,c.admin)).statusCode,200,path);
  }
  assert.equal((await c.req('GET','/admin/access',c.reader)).json().isServerAdmin,false);
  assert.equal((await c.req('GET','/admin/access',c.admin)).json().isServerAdmin,true);
  assert.equal((await c.req('GET',`/items/${asset}/content`,c.admin)).statusCode,404,'admin is not implicitly a shelf member');
  const text=(await c.req('GET','/admin/overview',c.admin)).body+(await c.req('GET','/admin/users',c.admin)).body;
  assert(!text.includes('password_hash')&&!text.includes('watch_ms')&&!text.includes('auth_session_id'));
  assert.equal((await c.req('GET','/analytics/global/events',c.admin)).statusCode,404);
  assert.equal((await c.req('GET','/analytics/me/events',c.admin)).json().events.length,0);
});

test('account CRUD reauthenticates, invalidates sessions/tickets and persists explicit admin overrides without losing last admin',async t=>{
  const c=await setup(t),asset=await c.asset();
  const ticket=(await c.req('POST',`/items/${asset}/playback-ticket`,c.reader)).json().url;
  assert.equal((await c.req('PATCH','/admin/users/'+c.reader.user.id,c.admin,{currentPassword:'wrong',serverRole:'admin'})).statusCode,403);
  assert.equal((await c.req('PATCH','/admin/users/'+c.admin.user.id,c.admin,{currentPassword:password,disabled:true})).statusCode,409);
  assert.equal((await c.req('PATCH','/admin/users/'+c.reader.user.id,c.reader,{currentPassword:password,serverRole:'admin'})).statusCode,403);
  const originalHash=c.db.prepare('SELECT password_hash FROM users WHERE id=?').get(c.reader.user.id).password_hash;
  assert.equal((await c.req('PATCH','/admin/users/'+c.reader.user.id,c.admin,{currentPassword:password,serverRole:'admin',newPassword:'admin-chosen-password'})).statusCode,204);
  assert.equal(c.db.prepare('SELECT password_hash FROM users WHERE id=?').get(c.reader.user.id).password_hash,originalHash,'admin cannot reset an existing account password to impersonate it');
  assert.equal((await c.req('GET','/auth/me',c.reader)).statusCode,401);
  assert.equal((await c.app.inject({url:ticket})).statusCode,401);
  c.reader=await c.login(c.reader);
  assert.equal((await c.req('GET','/admin/overview',c.reader)).statusCode,200);
  assert.equal((await c.req('PATCH','/admin/users/'+c.admin.user.id,c.reader,{currentPassword:password,serverRole:'user'})).statusCode,204);
  c.admin=await c.login(c.admin);
  assert.equal((await c.req('GET','/admin/overview',c.admin)).statusCode,403,'database override revokes configured bootstrap admin');
  assert.equal((await c.req('PATCH','/admin/users/'+c.reader.user.id,c.reader,{currentPassword:password,serverRole:'user'})).statusCode,409);
  const created=await c.req('POST','/admin/users',c.reader,{currentPassword:password,name:'New user',email:'new@example.test',password:'new-user-password',serverRole:'user'});
  assert.equal(created.statusCode,201,created.body);const id=created.json().user.id;
  assert.equal((await c.req('PATCH','/admin/users/'+id,c.reader,{currentPassword:password,disabled:true})).statusCode,204);
  assert.equal((await c.req('POST','/auth/login',null,{email:'new@example.test',password:'new-user-password'})).statusCode,401);
  assert.equal((await c.req('DELETE','/admin/users/'+id,c.reader,{currentPassword:password,confirmEmail:'wrong@example.test'})).statusCode,400);
  assert.equal((await c.req('DELETE','/admin/users/'+id,c.reader,{currentPassword:password,confirmEmail:'new@example.test'})).statusCode,204);
  const audit=(await c.req('GET','/admin/audit',c.reader)).body;assert(audit.includes('account.delete'));assert(!audit.includes(password)&&!audit.includes('new-user-password'));
  await c.app.close();c.app=await createApp(c.options);assert.equal((await c.req('GET','/admin/overview',c.admin)).statusCode,403);assert.equal((await c.req('GET','/admin/overview',c.reader)).statusCode,200);
});

test('server admin transfers shelf ownership safely; owner deletion never removes shared assets',async t=>{
  const c=await setup(t),asset=await c.asset();
  assert.equal((await c.req('DELETE','/admin/users/'+c.reader.user.id,c.admin,{currentPassword:password,confirmEmail:c.reader.user.email})).statusCode,409);
  assert.equal((await c.req('PUT',`/admin/shelves/${c.shelf}/members/${c.reader.user.id}`,c.admin,{currentPassword:password,role:'remove'})).statusCode,409);
  assert.equal((await c.req('PUT',`/admin/shelves/${c.shelf}/members/${c.other.user.id}`,c.admin,{currentPassword:password,role:'owner'})).statusCode,204);
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM memberships WHERE shelf_id=? AND role='owner'").get(c.shelf).n,1);
  assert.equal((await c.req('DELETE','/admin/users/'+c.reader.user.id,c.admin,{currentPassword:password,confirmEmail:c.reader.user.email})).statusCode,204);
  assert.equal(c.db.prepare('SELECT uploaded_by FROM items WHERE id=?').get(asset).uploaded_by,null);
  assert.equal((await c.req('GET',`/items/${asset}/content`,c.other)).statusCode,200);
});

test('thumbnail regeneration is durable, requires admin warning acknowledgement but no password and leaves canonical media unchanged',async t=>{
  const c=await setup(t),id=await c.asset(),before=await readFile(join(c.dataDir,'uploads',id));
  assert.equal((await c.req('POST',`/admin/assets/${id}/regenerate`,c.reader,{acknowledgeCost:true,kind:'thumbnail'})).statusCode,403);
  const r=await c.req('POST',`/admin/assets/${id}/regenerate`,c.admin,{acknowledgeCost:true,kind:'thumbnail'});assert.equal(r.statusCode,202,r.body);
  const job=await c.job(r.json().job.id);assert.equal(job.state,'complete',job.error);
  const history=(await c.req('GET','/admin/jobs',c.admin)).json().history.jobs.find(row=>row.id===job.id);
  assert.equal(history.title,'Private title');assert.equal(history.shelf,'Private shelf');assert.equal(history.assetId,id);
  assert(!('requested_by' in history)&&!('filename' in history));
  assert((await readFile(join(c.dataDir,'thumbnails',id+'.jpg'))).length>100);assert.deepEqual(await readFile(join(c.dataDir,'uploads',id)),before);
  assert.equal((await c.req('POST',`/admin/assets/${id}/regenerate`,c.admin,{acknowledgeCost:true,kind:'transcode'})).statusCode,400);
});

test('video generation preserves old HLS tickets, canonical MP4 and existing encrypted download manifests',async t=>{
  const c=await setup(t),source=await makeMp4(join(c.dataDir,'source.mp4'),{duration:.4,audio:true}),id=await c.asset('video/mp4',source);
  // First regeneration also upgrades a legacy video without changing its file.
  let r=await c.req('POST',`/admin/assets/${id}/regenerate`,c.admin,{acknowledgeCost:true,kind:'transcode'});assert.equal(r.statusCode,202,r.body);assert.equal((await c.job(r.json().job.id)).state,'complete');
  const ticket=(await c.req('POST',`/items/${id}/playback-ticket`,c.reader)).json();
  const manifest=(await c.req('POST',`/items/${id}/download`,c.reader)).json().manifest;
  const first=(await c.req('GET',`/downloads/${manifest.id}/files/0/parts/0`,c.reader)).rawPayload;
  r=await c.req('POST',`/admin/assets/${id}/regenerate`,c.admin,{acknowledgeCost:true,kind:'transcode'});assert.equal((await c.job(r.json().job.id)).state,'complete');
  const oldHls=await c.app.inject({url:ticket.hlsUrl});assert.equal(oldHls.statusCode,200,oldHls.body);assert(oldHls.body.includes('generation='+manifest.files[0].generation));
  assert.equal((await c.req('POST',`/downloads/${manifest.id}/open`,c.reader)).statusCode,200,'old encrypted registration remains valid');
  assert.equal((await c.req('GET',`/downloads/${manifest.id}/files/0/parts/0`,c.reader)).statusCode,200);assert(first.length>source.length/10);
  assert.deepEqual(await readFile(join(c.dataDir,'uploads',id)),source);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM video_generations WHERE item_id=?').get(id).n,2);
  const committedJob=r.json().job.id,current=JSON.parse(c.db.prepare('SELECT metadata_json FROM video_assets WHERE item_id=?').get(id).metadata_json);
  const generated=join(c.dataDir,'videos',id,current.generation,current.renditions[0].quality+'.mp4'),beforeRestart=await readFile(generated);
  c.db.prepare("UPDATE admin_jobs SET state='running' WHERE id=?").run(committedJob);
  await c.app.close();c.app=await createApp(c.options);
  const recovered=await c.job(committedJob);assert.equal(recovered.state,'complete',recovered.error);assert.equal(JSON.parse(recovered.progress_json).recovered,true);
  assert.deepEqual(await readFile(generated),beforeRestart,'committed generation is never deleted when recovering an unfinished status transition');
  assert.equal((await c.req('POST',`/downloads/${manifest.id}/open`,c.reader)).statusCode,200);
});

test('metadata/full backups are authenticated encrypted, bounded/range downloadable and recoverable; wrong passwords/tampering leave no plaintext',async t=>{
  const c=await setup(t),id=await c.asset();
  const config=join(c.dataDir,'test.env');await writeFile(config,'TEST_CONFIG_SECRET=not-for-display\n');c.options.backupConfigFile=config;
  for(const mode of ['metadata','full']){
    const r=await c.req('POST','/admin/backups',c.admin,{currentPassword:password,mode,backupPassword:'backup-specific-password',acknowledgeSensitive:true});assert.equal(r.statusCode,202,r.body);
    const job=await c.job(r.json().id);assert.equal(job.state,'complete',job.error);
    const archive=join(c.dataDir,'admin-backups',job.id+'.mireabackup'),encrypted=await readFile(archive);
    assert(!encrypted.includes(Buffer.from('not-for-display'))&&!encrypted.includes(Buffer.from('SQLite format')));
    assert.equal((await c.req('GET',`/admin/backups/${job.id}/content`,c.reader)).statusCode,403);
    const part=await c.req('GET',`/admin/backups/${job.id}/content`,c.admin,null,{Range:'bytes=0-31'});assert.equal(part.statusCode,206);assert.deepEqual(part.rawPayload,encrypted.subarray(0,32));
    const output=join(c.dataDir,mode+'.tar.gz');await decryptBackup(archive,output,'backup-specific-password');
    const tar=process.platform==='win32'?join(process.env.SystemRoot,'System32','tar.exe'):'tar';const names=execFileSync(tar,['-tf',output],{encoding:'utf8',windowsHide:true});
    assert(names.includes('data/mirea.sqlite')&&names.includes('data/keys/download-master.key')&&names.includes('configuration/server.env'));assert.equal(names.includes('data/uploads/'+id),mode==='full');assert(!names.includes('admin-backups/'));
    const restored=join(c.dataDir,'restored-'+mode);await mkdir(restored);execFileSync(tar,['-xf',output,'-C',restored],{windowsHide:true});
    const db=new DatabaseSync(join(restored,'data','mirea.sqlite'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,3);assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n,1);}finally{db.close();}
    assert.deepEqual(await readFile(join(restored,'data','keys','download-master.key')),await readFile(join(c.dataDir,'keys','download-master.key')));
    await assert.rejects(decryptBackup(archive,join(c.dataDir,'wrong.tar.gz'),'incorrect-password'));await assert.rejects(access(join(c.dataDir,'wrong.tar.gz')));await assert.rejects(access(join(c.dataDir,'wrong.tar.gz.partial')));
    const changed=Buffer.from(encrypted);changed[changed.length-20]^=1;const tampered=join(c.dataDir,'tampered');await writeFile(tampered,changed);await assert.rejects(decryptBackup(tampered,join(c.dataDir,'tampered.tar.gz'),'backup-specific-password'));await assert.rejects(access(join(c.dataDir,'tampered.tar.gz')));
  }
  assert(!JSON.stringify(c.db.prepare('SELECT * FROM admin_jobs').all()).includes('backup-specific-password'));
});

test('server updates reject downgrade/untrusted URL/digest and remain disabled without external helper',async t=>{
  const candidate={tag_name:'v99.0.0beta',draft:false,assets:[{id:42,name:'mirea-99.0.0beta-server.tar.gz',state:'uploaded',size:100,digest:'sha256:'+'a'.repeat(64),browser_download_url:RELEASE_PREFIX+'v99.0.0beta/mirea-99.0.0beta-server.tar.gz'}]};
  assert(releaseCandidate(candidate,'v0.2.3beta'));assert(!releaseCandidate(candidate,'v99.0.0beta'));assert(newer('v0.3.0beta','v0.2.99'));assert(newer('v1.0.0','v1.0.0beta'));
  assert(!releaseCandidate({...candidate,assets:[{...candidate.assets[0],browser_download_url:'https://evil.test/package'}]},'v0.2.3beta'));
  assert(!releaseCandidate({...candidate,assets:[{...candidate.assets[0],digest:null}]},'v0.2.3beta'));
  const c=await setup(t,{releaseFetch:async()=>new Response(JSON.stringify([candidate]),{headers:{'Content-Type':'application/json'}})});
  assert.equal((await c.req('GET','/admin/updates/status',c.admin)).json().enabled,false);
  assert.equal((await c.req('POST','/admin/updates/check',c.admin)).json().candidates[0].tag,'v99.0.0beta');
  assert.equal((await c.req('POST','/admin/updates/apply',c.admin,{currentPassword:password,tag:'v99.0.0beta',confirmTag:'v99.0.0beta',acknowledgeRestart:true})).statusCode,409);
});

test('simple history contains only the caller’s currently accessible works, not preview sessions or detailed telemetry',async t=>{
  const c=await setup(t),id=await c.asset(),privateId=await c.asset();
  const otherShelf=(await c.req('POST','/shelves',c.other,{name:'Not shared'})).json().id;c.db.prepare('UPDATE items SET shelf_id=? WHERE id=?').run(otherShelf,privateId);
  const insert=(user,asset,context='viewer')=>c.db.prepare(`INSERT INTO analytics_views(id,user_id,asset_id,shelf_id,asset_kind,asset_title,page_count,context,platform,client_version,auth_session_id,opened_at,first_received_at,last_received_at,counted) VALUES(?,?,?,?, 'pdf','Old title',1,?,'web','test','session',1,1,1,1)`).run(randomUUID(),user.user.id,asset,c.shelf,context);
  insert(c.reader,id);insert(c.reader,privateId);insert(c.other,id);insert(c.reader,id,'preview');
  const history=(await c.req('GET','/history',c.reader)).json();assert.deepEqual(history.items.map(i=>i.id),[id]);assert.equal(history.items[0].title,'Private title');assert(!JSON.stringify(history).includes('watchMs'));assert.equal((await c.req('GET','/history',c.admin)).json().items.length,0);
});

test('backup refuses active media jobs and releases the maintenance gate without creating a misleading completed backup',async t=>{
  const real=createMediaProcessor();let enter,finish;const entered=new Promise(r=>{enter=r;}),wait=new Promise(r=>{finish=r;});
  const media={...real,thumbnail:async(...args)=>{enter();await wait;return real.thumbnail(...args);}};
  const c=await setup(t,{mediaProcessor:media}),id=await c.asset();t.after(()=>finish());
  const r=await c.req('POST',`/admin/assets/${id}/regenerate`,c.admin,{acknowledgeCost:true,kind:'thumbnail'});await entered;
  const backup=await c.req('POST','/admin/backups',c.admin,{currentPassword:password,mode:'full',backupPassword:'backup-password-test',acknowledgeSensitive:true});assert.equal(backup.statusCode,409,backup.body);
  assert.equal((await c.req('GET','/auth/me',c.reader)).statusCode,200);
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM admin_jobs WHERE kind LIKE 'backup_%'").get().n,0);finish();assert.equal((await c.job(r.json().job.id)).state,'complete');
});

test('admin retries failed processing after uploader logout; the published original remains recoverable',async t=>{
  const real=createVideoTranscoder();let fail=true;
  const c=await setup(t,{videoTranscoder:{convert(...args){if(fail)throw httpError(422,'Synthetic conversion failure');return real.convert(...args);},close(){real.close();}}});
  const bytes=await makeMp4(join(c.dataDir,'retry.mp4'),{duration:.3,audio:true}),boundary='mirea-admin-retry';
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="retry.mp4"\r\nContent-Type: video/mp4\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const published=await c.req('POST',`/shelves/${c.shelf}/items`,c.reader,body,{'content-type':`multipart/form-data; boundary=${boundary}`});assert.equal(published.statusCode,201,published.body);
  const id=published.json().item.id;for(let n=0;n<200;n++){if(c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(id).state==='failed')break;await delay(50);}
  const upload=c.db.prepare("SELECT * FROM upload_sessions WHERE id=? AND state='failed'").get(id);assert(upload);assert.deepEqual(await readFile(join(c.dataDir,'originals',upload.id)),bytes);
  await c.req('POST','/auth/logout',c.reader);fail=false;
  const retried=await c.req('POST',`/admin/uploads/${upload.id}/retry`,c.admin,{acknowledgeCost:true});assert.equal(retried.statusCode,202,retried.body);
  for(let n=0;n<100;n++){if(c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(upload.id).state==='complete')break;await delay(50);}
  assert.equal(c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(upload.id).state,'complete');await access(join(c.dataDir,'uploads',upload.id));
  // Cleanup follows the publication commit and may complete one tick later.
  for(let n=0;n<50;n++){try{await access(join(c.dataDir,'uploads','transfers',upload.id));await delay(20);}catch{break;}}
  await assert.rejects(access(join(c.dataDir,'uploads','transfers',upload.id)));
});

test('shutdown interrupts an admin encoder before awaiting its queue and resumes the same durable job after restart',async t=>{
  let entered,interrupt;const started=new Promise(resolve=>{entered=resolve;});
  const transcoder={convert(){entered();return new Promise((_resolve,reject)=>{interrupt=()=>reject(Object.assign(Error('Closing'),{code:'SERVER_CLOSING'}));});},close(){interrupt?.();}};
  const c=await setup(t,{videoTranscoder:transcoder}),bytes=await makeMp4(join(c.dataDir,'shutdown.mp4'),{duration:.3,audio:true}),id=await c.asset('video/mp4',bytes);
  const result=await c.req('POST',`/admin/assets/${id}/regenerate`,c.admin,{acknowledgeCost:true,kind:'transcode'});await started;
  try{await Promise.race([c.app.close(),delay(3000).then(()=>{throw Error('Encoder must close before the queue drain');})]);}finally{transcoder.close();}
  assert.equal(c.db.prepare('SELECT state FROM admin_jobs WHERE id=?').get(result.json().job.id).state,'queued');
  delete c.options.videoTranscoder;c.app=await createApp(c.options);const resumed=await c.job(result.json().job.id);assert.equal(resumed.state,'complete',resumed.error);assert.deepEqual(await readFile(join(c.dataDir,'uploads',id)),bytes);
});
