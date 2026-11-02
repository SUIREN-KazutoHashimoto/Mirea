import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,rm,readFile,writeFile,access,rename,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {RESET_CONFIRMATION,createMediaReset} from '../server/admin-reset.js';
import {storagePaths,MEDIA_GROUPS,STATE_MEDIA_GROUPS} from '../server/storage.js';
import {makePdf} from './fixtures.js';
import {setTimeout as delay} from 'node:timers/promises';

const password='reset-isolated-password';
async function setup(t,{separate=false,...extra}={}){
  const root=await mkdtemp(join(tmpdir(),'mirea-reset-test-')),dataDir=join(root,'state'),mediaDir=separate?join(root,'media'):undefined;
  if(mediaDir)await mkdir(mediaDir);
  const options={dataDir,mediaDir,rateLimit:false,serverAdminUserIds:[],...extra},c={root,dataDir,options,app:await createApp(options),storage:storagePaths(dataDir,mediaDir)};
  c.db=new DatabaseSync(join(dataDir,'mirea.sqlite'));c.db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{await c.app.close();c.db.close();await rm(root,{recursive:true,force:true});});
  c.req=(method,path,user=c.admin,body)=>c.app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},...(body?{payload:body}:{})});
  for(const name of ['admin','reader']){const r=await c.req('POST','/auth/register',null,{name,email:name+'@example.invalid',password});assert.equal(r.statusCode,201,r.body);c[name]=r.json();}
  options.serverAdminUserIds.push(c.admin.user.id);
  c.shelf=(await c.req('POST','/shelves',c.reader,{name:'Private shelf'})).json().id;
  c.asset=randomUUID();await writeFile(join(c.storage.uploadDir,c.asset),makePdf());
  c.db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,'private','fixture.pdf','application/pdf',1,?,?)").run(c.asset,c.shelf,c.reader.user.id,Date.now());
  c.preview=async()=>{const r=await c.req('POST','/admin/reset/preview');assert.equal(r.statusCode,200,r.body);return r.json();};
  c.body=plan=>({previewId:plan.previewId,confirmText:RESET_CONFIRMATION,currentPassword:password,acknowledgeBackup:true,acknowledgeOffline:true});
  return c;
}
test('reset requires enabled admin, fresh session-bound preview, password and explicit destructive acknowledgements',async t=>{
  const c=await setup(t);
  for(const user of [null,c.reader])for(const [method,path,body] of [['GET','/admin/reset'],['POST','/admin/reset/preview'],['POST','/admin/reset/apply',{}],['POST','/admin/reset/recover',{currentPassword:password,confirmText:RESET_CONFIRMATION}]])assert.equal((await c.req(method,path,user,body)).statusCode,user?403:401,path);
  const plan=await c.preview();assert.equal(plan.accounts,2);assert.equal(plan.assets,1);assert(!JSON.stringify(plan).includes('private'));
  assert.equal((await c.req('POST','/admin/reset/apply',c.admin,{...c.body(plan),currentPassword:'wrong'})).statusCode,403);
  for(const patch of [{confirmText:'DELETE'},{acknowledgeBackup:false},{acknowledgeOffline:false}])assert.equal((await c.req('POST','/admin/reset/apply',c.admin,{...c.body(plan),...patch})).statusCode,400);
  assert.equal((await c.req('POST','/admin/reset/apply',c.admin,{currentPassword:password,path:c.dataDir})).statusCode,400,'no arbitrary path-only delete API');
  const second=(await c.req('POST','/auth/login',null,{email:c.admin.user.email,password})).json();assert.equal((await c.req('POST','/admin/reset/apply',second,c.body(plan))).statusCode,409);
  await writeFile(join(c.storage.uploadDir,randomUUID()),'new file');assert.equal((await c.req('POST','/admin/reset/apply',c.admin,c.body(plan))).statusCode,409);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM items').get().n,1);await access(join(c.storage.uploadDir,c.asset));
});

for(const separate of [false,true])test(`reset removes all media/metadata, preserves accounts/security/backups and accepts fresh uploads (${separate?'separate':'combined'})`,async t=>{
  const c=await setup(t,{separate});
  c.db.prepare("INSERT INTO user_access VALUES(?,'user',1)").run(c.reader.user.id);
  const before=JSON.stringify({users:c.db.prepare('SELECT * FROM users ORDER BY id').all(),access:c.db.prepare('SELECT * FROM user_access ORDER BY user_id').all(),sessions:c.db.prepare('SELECT * FROM sessions ORDER BY id').all()}),key=await readFile(join(c.dataDir,'keys','download-master.key')),layout=await readFile(join(c.dataDir,'storage-layout.json'));
  await writeFile(join(c.dataDir,'server.env'),'PRIVATE_CONFIG_FIXTURE');await writeFile(join(c.dataDir,'admin-backups','saved.mireabackup'),'ENCRYPTED_BACKUP_FIXTURE');
  for(const group of [...MEDIA_GROUPS,...STATE_MEDIA_GROUPS,'admin-work']){const base=MEDIA_GROUPS.includes(group)?c.storage.mediaDir:c.dataDir;await writeFile(join(base,group,randomUUID()),'orphan fixture');}
  const parent=randomUUID(),child=randomUUID();for(const id of [parent,child])c.db.prepare("INSERT INTO series(id,shelf_id,parent_id,title,created_at,updated_at) VALUES(?,?,?,'series',1,1)").run(id,c.shelf,id===child?parent:null);
  c.db.prepare('UPDATE series SET parent_id=? WHERE id=?').run(parent,child);c.db.prepare('INSERT INTO series_items VALUES(?,?,1,?)').run(child,c.asset,'');
  c.db.prepare("INSERT INTO thumbnail_overrides VALUES(?,? ,1)").run(c.asset,randomUUID());
  c.db.prepare("INSERT INTO admin_jobs(id,kind,state,created_at,updated_at) VALUES(?,'thumbnail','failed',1,1)").run(randomUUID());
  const backupJob=randomUUID();c.db.prepare("INSERT INTO admin_jobs(id,kind,state,created_at,updated_at,progress_json) VALUES(?,'backup_full','complete',?,?,?)").run(backupJob,Date.now(),Date.now(),JSON.stringify({expiresAt:Date.now()+86400000}));
  c.db.prepare("INSERT INTO analytics_views(id,user_id,asset_id,shelf_id,asset_kind,asset_title,page_count,context,platform,client_version,auth_session_id,opened_at,first_received_at,last_received_at) VALUES(?,?,?,?, 'pdf','private',1,'viewer','web','test','fixture',1,1,1)").run(randomUUID(),c.reader.user.id,c.asset,c.shelf);
  c.db.prepare("INSERT INTO encrypted_downloads VALUES(?,?,?,'{}',1)").run(randomUUID(),c.reader.user.id,c.asset);
  const plan=await c.preview(),result=await c.req('POST','/admin/reset/apply',c.admin,c.body(plan));assert.equal(result.statusCode,200,result.body);assert.equal(result.json().complete,true);
  for(const table of ['shelves','memberships','series','series_items','series_create_requests','items','image_pages','thumbnail_overrides','asset_progress','playback_tickets','encrypted_downloads','analytics_views','analytics_events','analytics_replay_bins','upload_sessions','upload_parts','admin_upload_retries','video_navigation','video_assets','audio_assets'])assert.equal(c.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
  assert.equal(JSON.stringify({users:c.db.prepare('SELECT * FROM users ORDER BY id').all(),access:c.db.prepare('SELECT * FROM user_access ORDER BY user_id').all(),sessions:c.db.prepare('SELECT * FROM sessions ORDER BY id').all()}),before);
  assert.deepEqual(await readFile(join(c.dataDir,'keys','download-master.key')),key);assert.deepEqual(await readFile(join(c.dataDir,'storage-layout.json')),layout);assert.equal(await readFile(join(c.dataDir,'server.env'),'utf8'),'PRIVATE_CONFIG_FIXTURE');assert.equal(await readFile(join(c.dataDir,'admin-backups','saved.mireabackup'),'utf8'),'ENCRYPTED_BACKUP_FIXTURE');assert.equal(c.db.prepare('SELECT id FROM admin_jobs').get().id,backupJob);assert.equal(c.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='media.reset'").get().n,1);assert.deepEqual(c.db.prepare('PRAGMA foreign_key_check').all(),[]);
  await assert.rejects(access(join(c.storage.uploadDir,c.asset)),{code:'ENOENT'});assert(!(await readdir(c.dataDir)).some(n=>n.startsWith('.mirea-reset-')));assert.equal((await c.req('GET','/auth/me')).statusCode,200);
  const shelf=(await c.req('POST','/shelves',c.admin,{name:'Fresh'})).json().id,bytes=makePdf(),boundary='reset-upload';
  const r=await c.req('POST',`/shelves/${shelf}/uploads`,c.admin,{title:'Fresh PDF',files:[{filename:'fresh.pdf',mime:'application/pdf',size:bytes.length}]});assert.equal(r.statusCode,201,r.body);
  const upload=r.json();const {createHash}=await import('node:crypto');const part=await c.app.inject({method:'PUT',url:`/api/v1/uploads/${upload.id}/files/0/parts/0`,headers:{authorization:'Bearer '+c.admin.token,'content-type':'application/octet-stream','x-chunk-sha256':createHash('sha256').update(bytes).digest('hex')},payload:bytes});assert.equal(part.statusCode,204,part.body);assert.equal((await c.req('POST',`/uploads/${upload.id}/complete`)).statusCode,202);
  for(let n=0;n<300&&c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(upload.id)?.state==='processing';n++)await delay(20);
  assert.equal(c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(upload.id)?.state,'complete',JSON.stringify(c.db.prepare('SELECT state,error FROM upload_sessions WHERE id=?').get(upload.id)));
  await c.app.close();c.app=await createApp(c.options);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM items').get().n,1,'fresh upload committed and survived restart');
});

test('interrupted resets roll back before commit and finish cleanup after commit on startup',async t=>{
  for(const committed of [false,true])await t.test(String(committed),async t=>{
    const c=await setup(t),id=randomUUID();await c.app.close();
    await writeFile(join(c.dataDir,'media-reset.json'),JSON.stringify({version:1,id}));await rename(c.storage.uploadDir,join(c.storage.mediaDir,`.mirea-reset-${id}-uploads`));
    if(committed){c.db.exec('DELETE FROM shelves');c.db.prepare("INSERT INTO admin_audit(action,target_id,created_at) VALUES('media.reset',?,1)").run(id);}
    c.app=await createApp(c.options);await assert.rejects(access(join(c.dataDir,'media-reset.json')),{code:'ENOENT'});
    if(committed)await assert.rejects(access(join(c.storage.uploadDir,c.asset)),{code:'ENOENT'});else assert.deepEqual(await readFile(join(c.storage.uploadDir,c.asset)),makePdf());
    assert.equal((await c.req('GET','/auth/me')).statusCode,200);
  });
});

test('reset rejects links and corrupt journals instead of reaching files outside media storage',async t=>{
  const c=await setup(t),outside=join(c.root,'protected');await mkdir(outside);await writeFile(join(outside,'keep'),'private');
  let linked=false;try{await symlink(outside,join(c.storage.uploadDir,'escape'),process.platform==='win32'?'junction':'dir');linked=true;}catch(e){if(e.code!=='EPERM')throw e;}
  if(linked)assert.equal((await c.req('POST','/admin/reset/preview')).statusCode,409);assert.equal(await readFile(join(outside,'keep'),'utf8'),'private');
  await writeFile(join(c.dataDir,'media-reset.json'),'{}');await assert.rejects(createMediaReset({db:c.db,storage:c.storage}).recover(),/Invalid/);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM items').get().n,1);
});

test('busy decoders reject resets, release the maintenance gate and preserve every account and asset',async t=>{
  let busy=false;const c=await setup(t,{mediaProcessor:{get busy(){return busy;}}});busy=true;
  assert.equal((await c.req('POST','/admin/reset/preview')).statusCode,409);assert.equal((await c.app.inject('/api/health')).json().maintenanceLocked,false);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM items').get().n,1);
  busy=false;assert.equal((await c.req('POST','/admin/reset/preview')).statusCode,200);
});

test('a failure between root moves rolls back all moved media before returning an error',async t=>{
  const c=await setup(t),store=createMediaReset({db:c.db,storage:c.storage}),key=await readFile(join(c.dataDir,'keys','download-master.key'));let n=0;
  await assert.rejects(store.execute(()=>assert.fail('must not commit'),()=>{if(++n===3)throw Error('injected authorization loss');}),/authorization loss/);
  assert.equal(await store.readJournal(),null);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM items').get().n,1);assert.deepEqual(await readFile(join(c.storage.uploadDir,c.asset)),makePdf());assert.deepEqual(await readFile(join(c.dataDir,'keys','download-master.key')),key);
});

test('recovery never overwrites media created outside the interrupted operation',async t=>{
  const c=await setup(t),id=randomUUID();await c.app.close();await writeFile(join(c.dataDir,'media-reset.json'),JSON.stringify({version:1,id}));await rename(c.storage.uploadDir,join(c.storage.mediaDir,`.mirea-reset-${id}-uploads`));await mkdir(c.storage.uploadDir);await writeFile(join(c.storage.uploadDir,'new-data'),'do not overwrite');
  await assert.rejects(createMediaReset({db:c.db,storage:c.storage}).recover(),/overwrite new data/);assert.equal(await readFile(join(c.storage.uploadDir,'new-data'),'utf8'),'do not overwrite');assert.deepEqual(await readFile(join(c.storage.mediaDir,`.mirea-reset-${id}-uploads`,c.asset)),makePdf());assert.equal(c.db.prepare('SELECT COUNT(*) n FROM items').get().n,1);
});
