import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/app.js';
import {createVideoTranscoder} from '../server/video-transcode.js';
import {createJobLanes} from '../server/job-pool.js';
import {openDatabase} from '../server/database.js';
import {makeMp4,makePdf} from './fixtures.js';
import sharp from 'sharp';
import {createMediaProcessor} from '../server/media.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
test('schema20 migration is additive and preserves every existing row and download manifest',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mirea-0200-migration-')),path=join(dir,'library.sqlite');let db=openDatabase(path);t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 db.exec(`INSERT INTO users VALUES('u','keep@example.test','Keep','opaque',1);INSERT INTO shelves(id,name,created_at) VALUES('s','Keep',1);INSERT INTO memberships VALUES('s','u','owner');INSERT INTO items VALUES('i','s','Keep','keep.mp4','video/mp4',123,'u',1,1,1);INSERT INTO encrypted_downloads VALUES('d','u','i','{"unchanged":true}',1);DROP TABLE shelf_challenges;DROP TABLE shelf_unlocks;DROP TABLE shelf_biometric_keys;DROP TABLE media_tasks;DROP TABLE media_ingest;UPDATE schema_version SET version=20;`);
 const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_version') ORDER BY name").all().map(r=>r.name),before=names.map(n=>db.prepare('SELECT * FROM '+n).all());db.close();db=openDatabase(path);assert.equal(db.prepare('SELECT version FROM schema_version').get().version,21);for(let n=0;n<names.length;n++)assert.deepEqual(db.prepare('SELECT * FROM '+names[n]).all(),before[n],names[n]);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
async function until(check){for(let n=0;n<1500;n++){if(await check())return;await delay(10);}throw Error('Timed out');}
async function fixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'mirea-0200-')),c={dir,app:await createApp({dataDir:dir,rateLimit:false,chunkSize:65536,...options})};
 c.req=(method,path,payload,headers={},user=c.user)=>c.app.inject({method,url:'/api/v1'+path,headers:{...(user?{authorization:'Bearer '+user.token}:{}),...headers},...(payload===undefined?{}:{payload})});
 c.user=(await c.req('POST','/auth/register',{email:'pipeline@example.test',name:'Fixture',password:'pipeline-fixture-password'})).json();c.shelf=(await c.req('POST','/shelves',{name:'Fixture'})).json().id;
 c.db=new DatabaseSync(join(dir,'mirea.sqlite'));t.after(async()=>{await c.app.close();c.db.close();await rm(dir,{recursive:true,force:true});});
 c.upload=async(bytes,title='Video',mime='video/mp4')=>{
  const r=await c.req('POST','/shelves/'+c.shelf+'/uploads',{title,retainOriginal:true,files:[{filename:title+'.mp4',mime,size:bytes.length}]});assert.equal(r.statusCode,201,r.body);const s=r.json();
  for(let n=0;n<Math.ceil(bytes.length/s.chunkSize);n++){const part=bytes.subarray(n*s.chunkSize,(n+1)*s.chunkSize),put=await c.req('PUT',`/uploads/${s.id}/files/0/parts/${n}`,part,{'content-type':'application/octet-stream','x-chunk-sha256':hash(part)});assert.equal(put.statusCode,204,put.body);}
  assert.equal((await c.req('POST','/uploads/'+s.id+'/complete')).statusCode,202);return s.id;
 };return c;
}
test('thumbnail, encoder and preview lanes reserve capacity independently',async()=>{
 const pool=createJobLanes(()=>({maxConcurrentJobs:1}));let release;const held=new Promise(r=>release=r),started=[];
 const encoder=pool.run(()=>held,'encode','transcode'),second=pool.run(async()=>started.push('second'),'e2','transcode');
 await pool.run(async()=>started.push('cover'),'cover','thumbnail');await pool.run(async()=>started.push('preview'),'p','preview');assert.deepEqual(started,['cover','preview']);release();await Promise.all([encoder,second]);assert.equal(started.at(-1),'second');
});
test('verified original publishes before a blocked encoder; next upload and cover complete, source ticket remains immutable',async t=>{
 const real=createVideoTranscoder();let release,entered=false;const held=new Promise(r=>release=r);
 const c=await fixture(t,{videoTranscoder:{async convert(...args){entered=true;await held;return real.convert(...args);},close(){release();real.close();}}});t.after(()=>release());
 const bytes=await makeMp4(join(c.dir,'source.mp4'),{duration:1,audio:true}),id=await c.upload(bytes);
 await until(()=>entered);const listing=(await c.req('GET','/shelves/'+c.shelf+'/items')).json();assert.equal(listing.items[0].originalPlayback,true);assert.equal(listing.items[0].downloadReady,false);
 const cover=await c.req('GET','/items/'+id+'/thumbnail');assert.equal(cover.statusCode,200,cover.body);assert.equal((await c.req('POST','/items/'+id+'/download')).statusCode,409);
 const ticket=(await c.req('POST','/items/'+id+'/playback-ticket')).json();assert.equal(ticket.hlsUrl,undefined);const before=await c.app.inject({url:ticket.url,headers:{range:'bytes=0-31'}});assert.deepEqual(before.rawPayload,bytes.subarray(0,32));
 const pdf=await c.upload(makePdf(),'Document','application/pdf');await until(()=>c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(pdf).state==='complete');assert.equal(entered,true);
 release();await until(()=>c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(id).state==='complete');
 const after=await c.app.inject({url:ticket.url,headers:{range:'bytes=0-31'}});assert.deepEqual(after.rawPayload,bytes.subarray(0,32));assert.equal((await c.req('POST','/items/'+id+'/playback-ticket')).json().renditions.length,1);
 assert.equal(c.db.prepare("SELECT COUNT(*) n FROM media_tasks WHERE asset_id=? AND state='complete'").get(id).n,3);assert.equal((await c.req('POST','/items/'+id+'/download')).statusCode,200);
});
test('acknowledged duplicate parts do not rewrite disk, and missing persisted parts can be repaired',async t=>{
 const c=await fixture(t),bytes=makePdf(),r=await c.req('POST','/shelves/'+c.shelf+'/uploads',{title:'Book',files:[{filename:'book.pdf',mime:'application/pdf',size:bytes.length}]}),id=r.json().id;
 const put=()=>c.req('PUT',`/uploads/${id}/files/0/parts/0`,bytes,{'content-type':'application/octet-stream','x-chunk-sha256':hash(bytes)});assert.equal((await put()).statusCode,204);const path=join(c.dir,'uploads','transfers',id,'0-0'),stamp=(await stat(path)).mtimeMs;assert.equal((await put()).statusCode,204);assert.equal((await stat(path)).mtimeMs,stamp);
 await unlink(path);assert.equal((await put()).statusCode,204);assert.deepEqual(await readFile(path),bytes);
});
test('manual thumbnail regeneration is not trapped behind a full transcode execution window',async t=>{
 let release,entered=false,closed=false;const held=new Promise(r=>release=r),c=await fixture(t,{videoTranscoder:{async convert(){entered=true;await held;throw Object.assign(Error('Stopped fixture'),{code:'SERVER_CLOSING'});},close(){closed=true;release();}}});
 c.db.prepare("INSERT INTO user_access VALUES(?,'admin',0)").run(c.user.user.id);const settings=await c.req('PATCH','/admin/processing-settings',{maxConcurrentUploads:3,maxConcurrentJobs:1,maxUploadAssets:1000,currentPassword:'pipeline-fixture-password'});assert.equal(settings.statusCode,200,settings.body);
 const raw=await makeMp4(join(c.dir,'manual.mp4'),{duration:.2}),add=async()=>{const id=randomUUID();await writeFile(join(c.dir,'uploads',id),raw);c.db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,'manual.mp4','video/mp4',?,?,?)").run(id,c.shelf,id,raw.length,c.user.user.id,Date.now());return id;};
 for(let n=0;n<22;n++)await add();const bulk=await c.req('POST','/admin/assets/regenerate-all',{kind:'transcode',acknowledgeCost:true});assert.equal(bulk.statusCode,202,bulk.body);await until(()=>entered);
 try{const id=await add(),cover=await c.req('POST','/admin/assets/'+id+'/regenerate',{kind:'thumbnail',acknowledgeCost:true});assert.equal(cover.statusCode,202,cover.body);await until(()=>c.db.prepare('SELECT state FROM admin_jobs WHERE id=?').get(cover.json().job.id).state==='complete');assert.equal(c.db.prepare("SELECT COUNT(*) n FROM admin_jobs WHERE kind='transcode' AND state IN ('queued','running')").get().n,22);assert.equal(closed,false);}finally{release();}
});
test('a custom cover chosen during original thumbnail generation remains authoritative and keeps its uploaded bytes',async t=>{
 const media=createMediaProcessor();let release,entered=false;const held=new Promise(r=>release=r);
 const c=await fixture(t,{mediaProcessor:{...media,async thumbnail(...args){if(args[1].startsWith('video/')){entered=true;await held;}return media.thumbnail(...args);}}});t.after(()=>release());
 const original=await makeMp4(join(c.dir,'blue.mp4'),{duration:.3}),id=await c.upload(original);await until(()=>entered);
 try{
  const png=await sharp({create:{width:128,height:64,channels:3,background:'#ff2200'}}).png().toBuffer(),custom=await c.req('POST','/thumbnails/custom',{assetIds:[id],image:{mime:'image/png',base64:png.toString('base64')}});assert.equal(custom.statusCode,200,custom.body);
  release();await until(()=>c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(id).state==='complete');const image=await c.req('GET','/items/'+id+'/thumbnail');assert.equal(image.statusCode,200,image.body);const pixel=await sharp(image.rawPayload).resize(1,1).raw().toBuffer();assert(pixel[0]>200&&pixel[2]<80);
  const override=c.db.prepare('SELECT image_id FROM thumbnail_overrides WHERE asset_id=?').get(id);assert.deepEqual(await readFile(join(c.dir,'thumbnails','custom',override.image_id+'.input')),png);
 }finally{release();}
});
test('private shelves require separate password or signed biometric grant, bound to session and shelf',async t=>{
 const c=await fixture(t);c.db.prepare('UPDATE shelves SET private=1 WHERE id=?').run(c.shelf);
 assert.equal((await c.req('GET','/shelves/'+c.shelf+'/items')).statusCode,423);assert.equal((await c.req('POST','/shelves/'+c.shelf+'/unlock',{password:'wrong'})).statusCode,403);
 const grant=(await c.req('POST','/shelves/'+c.shelf+'/unlock',{password:'pipeline-fixture-password'})).json(),headers={'x-mirea-shelf-unlock':grant.token};assert.equal((await c.req('GET','/shelves/'+c.shelf+'/items',undefined,headers)).statusCode,200);
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),enroll=await c.req('POST','/shelves/'+c.shelf+'/biometric/enroll',{password:'pipeline-fixture-password',publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64')});assert.equal(enroll.statusCode,200,enroll.body);
 const keyId=enroll.json().keyId,challenge=(await c.req('POST','/shelves/'+c.shelf+'/biometric/challenge',{keyId})).json().challenge;
 const body={challenge,signature:sign('sha256',Buffer.from(challenge),privateKey).toString('base64')};assert.equal((await c.req('POST','/shelves/'+c.shelf+'/biometric/unlock',body)).statusCode,200);assert.equal((await c.req('POST','/shelves/'+c.shelf+'/biometric/unlock',body)).statusCode,403,'challenge cannot replay');
 const other=(await c.req('POST','/auth/login',{email:'pipeline@example.test',password:'pipeline-fixture-password'})).json();assert.equal((await c.req('GET','/shelves/'+c.shelf+'/items',undefined,headers,other)).statusCode,423,'another session cannot use grant');
 c.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run('changed',c.user.user.id);assert.equal((await c.req('GET','/shelves/'+c.shelf+'/items',undefined,headers)).statusCode,423,'password change invalidates grants');
});
