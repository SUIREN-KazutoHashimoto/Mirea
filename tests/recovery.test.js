import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir,stat} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../server/database.js';
import {storagePaths,initializeStorage} from '../server/storage.js';
import {openRecoveryStore,restoreRecoveryPoint,fileHash,validateManifest} from '../server/recovery-store.js';
import {prepareRecovery} from '../server/recovery.js';
import {recoverySettings} from '../server/recovery-settings.js';
import {createApp} from '../server/app.js';
import Fastify from 'fastify';
import {registerRecovery} from '../server/recovery.js';
import {createMaintenanceGate} from '../server/maintenance-gate.js';

async function fixture(t,{separate=false}={}){
 const directory=await mkdtemp(join(tmpdir(),'mirea-recovery-test-'));const dataDir=join(directory,'data'),mediaDir=separate?join(directory,'media'):dataDir;
 if(separate)await mkdir(mediaDir);const storage=storagePaths(dataDir,mediaDir);await initializeStorage(storage);
 const db=openDatabase(join(dataDir,'mirea.sqlite')),storageId=JSON.parse(await readFile(join(dataDir,'storage-layout.json'),'utf8')).id;
 const store=await openRecoveryStore({dataDir,mediaDir,storageId});await mkdir(join(dataDir,'keys'));const key=randomBytes(32);await writeFile(join(dataDir,'keys','download-master.key'),key);
 const user=randomUUID(),shelf=randomUUID(),asset=randomUUID();db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user,'reader@example.test','Reader','synthetic-hash',Date.now());db.prepare('INSERT INTO shelves(id,name,created_at) VALUES(?,?,?)').run(shelf,'Synthetic shelf',Date.now());db.prepare('INSERT INTO memberships VALUES(?,?,?)').run(shelf,user,'owner');db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(asset,shelf,'Synthetic book','synthetic.pdf','application/pdf',9,user,Date.now());await writeFile(join(storage.uploadDir,asset),'%PDF-test');
 t.after(async()=>{if(db.isOpen)db.close();assert(resolve(directory).startsWith(resolve(tmpdir())+sep+'mirea-recovery-test-'));await rm(directory,{recursive:true,force:true});});
 return {directory,dataDir,mediaDir,storage,db,store,key,user,shelf,asset};
}
for(const separate of [false,true])test('full recovery restores DB, media, metadata and the unchanged encryption key '+(separate?'separated':'combined'),async t=>{
 const f=await fixture(t,{separate}),before=await stat(join(f.storage.uploadDir,f.asset));
 const longName='thumbnails/custom/'+f.asset+'/'+('表'.repeat(70))+'.webp';await mkdir(join(f.dataDir,'thumbnails/custom',f.asset),{recursive:true});await writeFile(join(f.dataDir,longName),'synthetic long PAX path');
 const snapshot=await f.store.capture({db:f.db,scope:'full',reason:'manual',version:'2.1.0-beta',reserveMiB:0});
 await f.store.verify(snapshot.id);await writeFile(join(f.storage.uploadDir,f.asset),'changed after checkpoint');f.db.prepare('DELETE FROM items').run();
 const destination=join(f.directory,'restored');await restoreRecoveryPoint({directory:f.store.directory,id:snapshot.id,destination});
 const restoredDb=new DatabaseSync(join(destination,'data','mirea.sqlite'),{readOnly:true});try{assert.equal(restoredDb.prepare('SELECT id FROM items').get().id,f.asset);}finally{restoredDb.close();}
 assert.deepEqual(await readFile(join(destination,'data','keys','download-master.key')),f.key);
 assert.equal(await readFile(join(destination,'data',longName),'utf8'),'synthetic long PAX path');
 const media=join(destination,separate?'media':'data','uploads',f.asset);assert.equal(await readFile(media,'utf8'),'%PDF-test');assert.equal((await stat(media)).mtimeMs,before.mtimeMs,'restore must preserve encrypted-download source identity');
 assert.equal(JSON.parse(await readFile(join(destination,'restore-result.json'),'utf8')).verified,true);
 assert(!(await readdir(join(destination,'data'))).includes('.mirea-restore-incomplete'));
});
test('online database snapshot includes WAL commits and refuses full restoration without media',async t=>{
 const f=await fixture(t),snapshot=await f.store.capture({db:f.db,scope:'database',version:'2.1.0-beta',reserveMiB:0});
 const manifest=await f.store.verify(snapshot.id);assert.equal(manifest.database.users,1);assert(!manifest.files.some(file=>file.name.startsWith('data/uploads/')));
 await assert.rejects(restoreRecoveryPoint({directory:f.store.directory,id:snapshot.id,destination:join(f.directory,'restore')}),{code:'RECOVERY_MEDIA_NOT_INCLUDED'});
});
test('damaged backup is detected and live media and nonempty destinations are preserved',async t=>{
 const f=await fixture(t),snapshot=await f.store.capture({db:f.db,scope:'full',version:'2.1.0-beta',reserveMiB:0});
 const destination=join(f.directory,'nonempty');await mkdir(destination);await writeFile(join(destination,'keep'),'keep');
 await assert.rejects(restoreRecoveryPoint({directory:f.store.directory,id:snapshot.id,destination}),{code:'RECOVERY_DESTINATION_NOT_EMPTY'});
 const file=snapshot.files.find(file=>file.name.endsWith(f.asset));await writeFile(f.store.objectPath(file.sha256),'damaged');
 await assert.rejects(f.store.verify(snapshot.id),{code:'RECOVERY_CHECKSUM_MISMATCH'});
 await assert.rejects(restoreRecoveryPoint({directory:f.store.directory,id:snapshot.id,destination:join(f.directory,'empty')}),{code:'RECOVERY_CHECKSUM_MISMATCH'});
 assert.equal(await readFile(join(f.storage.uploadDir,f.asset),'utf8'),'%PDF-test');assert.equal(await readFile(join(destination,'keep'),'utf8'),'keep');
});
test('identical media is deduplicated independently from the mutable live file',async t=>{
 const f=await fixture(t),first=await f.store.capture({db:f.db,scope:'full',version:'2.1.0-beta',reserveMiB:0});
 const second=await f.store.capture({db:f.db,scope:'full',version:'2.1.0-beta',reserveMiB:0});
 const hash=first.files.find(file=>file.name.endsWith(f.asset)).sha256;assert.equal(second.files.find(file=>file.name.endsWith(f.asset)).sha256,hash);
 assert.equal((await stat(f.store.objectPath(hash))).nlink,1);assert((await stat(f.store.objectPath(hash))).ino!==(await stat(join(f.storage.uploadDir,f.asset))).ino);
});
test('pre-upgrade checkpoint happens before migration and interrupted upgrades fail closed',async t=>{
 const f=await fixture(t);await writeFile(join(f.dataDir,'recovery-runtime.json'),JSON.stringify({format:1,version:'2.0.0-beta'}));
 const prepared=await prepareRecovery({storage:f.storage,version:'2.1.0-beta'});assert.equal(prepared.checkpoint.scope,'full');assert.equal(prepared.checkpoint.previousVersion,'2.0.0-beta');
 await assert.rejects(prepareRecovery({storage:f.storage,version:'2.1.0-beta'}),{code:'RECOVERY_STARTUP_INCOMPLETE'});
 await prepared.commit();await assert.rejects(prepareRecovery({storage:f.storage,version:'2.0.0-beta'}),{code:'RECOVERY_DOWNGRADE_BLOCKED'});
});
test('missing or corrupt live database never becomes an empty collection',async t=>{
 const f=await fixture(t);f.db.close();await writeFile(join(f.dataDir,'mirea.sqlite'),'corrupt synthetic database');
 await assert.rejects(prepareRecovery({storage:f.storage,version:'2.1.0-beta'}));
 const {unlink}=await import('node:fs/promises');await unlink(join(f.dataDir,'mirea.sqlite'));
 await assert.rejects(prepareRecovery({storage:f.storage,version:'2.1.0-beta'}),{code:'RECOVERY_DATABASE_MISSING'});
});
test('newer database schema is rejected before modifying its contents',async t=>{
 const f=await fixture(t);f.db.exec('UPDATE schema_version SET version=999');f.db.close();const file=join(f.dataDir,'mirea.sqlite'),before=await fileHash(file);assert.throws(()=>openDatabase(file),/Unsupported database schema/);assert.equal(await fileHash(file),before);
});
test('a failing historical migration rolls back every earlier schema step',async t=>{
 const f=await fixture(t);f.db.exec('CREATE TABLE items_v10(block INTEGER); UPDATE schema_version SET version=1;');f.db.close();const file=join(f.dataDir,'mirea.sqlite');assert.throws(()=>openDatabase(file));
 const db=new DatabaseSync(file,{readOnly:true});try{assert.equal(db.prepare('SELECT version FROM schema_version').get().version,1);assert.equal(db.prepare('SELECT id FROM items').get().id,f.asset);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='items_v2'").get(),undefined);}finally{db.close();}
});
test('retention never deletes manual or upgrade recovery points or the last two snapshots',async t=>{
 const f=await fixture(t),now=Date.now(),ids=[];
 for(const [days,reason]of [[60,'pre-upgrade'],[59,'manual'],[58,'scheduled'],[57,'scheduled'],[1,'scheduled'],[0,'scheduled']])ids.push((await f.store.capture({db:f.db,version:'2.1.0-beta',reason,now:now-days*86400000,reserveMiB:0})).id);
 await f.store.prune({now,retentionDays:30});const remaining=(await f.store.list()).map(s=>s.id);assert(remaining.includes(ids[0]));assert(remaining.includes(ids[1]));assert(!remaining.includes(ids[2]));assert(!remaining.includes(ids[3]));assert(remaining.includes(ids[4]));assert(remaining.includes(ids[5]));
});
test('recovery mounts, settings overrides and invalid manifests fail safely',async t=>{
 const f=await fixture(t);await assert.rejects(openRecoveryStore({dataDir:f.dataDir,mediaDir:f.mediaDir,directory:join(f.directory,'absent-mount'),storageId:'wrong'}),{code:'ENOENT'});
 const settings=recoverySettings(f.db,{RECOVERY_INTERVAL_MINUTES:'10'});assert.equal(settings.value.intervalMinutes,10);settings.update({intervalMinutes:2,retentionDays:40});assert.equal(settings.value.intervalMinutes,10);assert.equal(settings.value.retentionDays,40);assert.throws(()=>settings.update({reserveMiB:1}));assert.throws(()=>validateManifest({manifest:{format:1,files:[{name:'data/../escape'}]}}));
});
test('capacity failure preserves older recovery points and does not poison the next attempt',async t=>{
 const f=await fixture(t),first=await f.store.capture({db:f.db,version:'2.1.0-beta',reserveMiB:0});await assert.rejects(f.store.capture({db:f.db,version:'2.1.0-beta',reserveMiB:Number.MAX_SAFE_INTEGER}),{code:'RECOVERY_SPACE_LOW'});assert.equal((await f.store.list())[0].id,first.id);await f.store.verify(first.id);await f.store.capture({db:f.db,version:'2.1.0-beta',reserveMiB:0});
});
test('busy media work postpones only the full checkpoint and database protection continues',async t=>{
 const f=await fixture(t),app=Fastify(),gate=createMaintenanceGate(app);gate.setBusy(()=>true);const recovery=await registerRecovery(app,{db:f.db,prepared:{store:f.store,configuration:()=>[]},version:'2.1.0-beta',adminAccess:{requireAdmin(){},reauthenticate(){},audit(){}},maintenance:gate});t.after(()=>app.close());recovery.state.lastDatabaseAt=Date.now()-10*60000;recovery.state.lastFullAt=Date.now()-48*3600000;const previousFull=recovery.state.lastFullAt;await recovery.tick();assert(recovery.state.lastDatabaseAt>0);assert(recovery.state.fullDeferredAt>0);assert.equal(recovery.state.lastFullAt,previousFull);assert.equal(recovery.state.lastError,null);assert.equal(gate.locked,false);assert((await f.store.list()).every(s=>s.scope==='database'));
});
test('only server administrators can create and inspect recovery points',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mirea-recovery-api-')),admins=[];const app=await createApp({dataDir:join(directory,'data'),serverAdminUserIds:admins,rateLimit:false});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const registration=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Synthetic admin',email:'recovery@example.test',password:'synthetic-password'}}),account=registration.json(),headers={authorization:'Bearer '+account.token};
 assert.equal((await app.inject({method:'GET',url:'/api/v1/admin/recovery',headers})).statusCode,403);admins.push(account.user.id);
 assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/recovery',headers,payload:{currentPassword:'wrong',scope:'database',acknowledgePause:false}})).statusCode,403);
 const started=await app.inject({method:'POST',url:'/api/v1/admin/recovery',headers,payload:{currentPassword:'synthetic-password',scope:'database',acknowledgePause:false}});assert.equal(started.statusCode,202,started.body);
 const deadline=Date.now()+30000;while(Date.now()<deadline){const status=(await app.inject({method:'GET',url:'/api/v1/admin/recovery',headers})).json();if(status.lastError)assert.fail(JSON.stringify(status.lastError));if(!status.active&&status.snapshots.length){assert.equal(status.snapshots[0].scope,'database');return;}await new Promise(r=>setTimeout(r,100));}assert.fail('Recovery snapshot did not finish');
});
