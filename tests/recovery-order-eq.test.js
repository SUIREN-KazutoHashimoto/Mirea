import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/app.js';
import {openDatabase,transaction} from '../server/database.js';
import {orderSeriesItems} from '../server/series-order.js';
import {PeakLimiter} from '../web/src/eq-limiter.js';
import {EQ_FREQUENCIES,equalizerSettings} from '../web/src/equalizer.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ffmpegPath} from '../server/media.js';
import sharp from 'sharp';
import {makePdf,makeMp4} from './fixtures.js';
const password='recovery-fixture-password';
async function until(check){for(let n=0;n<1500;n++){if(await check())return;await delay(20);}throw Error('Fixture deadline');}
async function setup(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'mirea-recovery-order-')),c={dir,config:{dataDir:dir,rateLimit:false,...options}};c.app=await createApp(c.config);c.db=new DatabaseSync(join(dir,'mirea.sqlite'));c.db.exec('PRAGMA foreign_keys=ON');
 t.after(async()=>{await c.app.close();c.db.close();await rm(dir,{recursive:true,force:true});});
 c.req=(method,path,payload,user=c.owner)=>c.app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},...(payload===undefined?{}:{payload})});
 c.owner=(await c.req('POST','/auth/register',{name:'Fixture',email:'fixture@example.test',password})).json();c.db.prepare("INSERT INTO user_access VALUES(?,'admin',0)").run(c.owner.user.id);c.shelf=(await c.req('POST','/shelves',{name:'Fixture'})).json().id;
 c.asset=async(title,mime='application/pdf',bytes=makePdf())=>{const id=randomUUID();await writeFile(join(dir,'uploads',id),bytes);c.db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,1)').run(id,c.shelf,title,'fixture'+(mime.startsWith('video')?'.mp4':'.pdf'),mime,bytes.length,c.owner.user.id);return id;};
 c.series=async title=>(await c.req('POST','/shelves/'+c.shelf+'/series',{title})).json().series;
 c.save=(series,ids,extra={})=>c.req('PUT','/series/'+series.id,{title:series.title,description:series.description,revision:series.revision,items:ids.map(assetId=>({assetId,label:assetId})),...extra});
 c.wait=async id=>{await until(()=>['complete','failed'].includes(c.db.prepare('SELECT state FROM admin_jobs WHERE id=?').get(id)?.state));return c.db.prepare('SELECT * FROM admin_jobs WHERE id=?').get(id);};return c;
}

test('v22 migration resets existing member order once without changing labels, membership, accounts or downloads; later manual order survives restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mirea-order-migration-')),path=join(dir,'db.sqlite');let db=openDatabase(path);t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 db.exec("INSERT INTO users VALUES('u','keep@example.test','Keep','opaque',1);INSERT INTO shelves(id,name,created_at) VALUES('s','Keep',1);INSERT INTO memberships VALUES('s','u','owner');INSERT INTO series(id,shelf_id,title,description,created_at,updated_at) VALUES('series','s','Keep','Keep',1,1)");
 const titles=['第10巻','第2巻','第1巻'];for(let n=0;n<3;n++){db.prepare("INSERT INTO items VALUES(?,'s',?,'f.pdf','application/pdf',123,'u',1,1,1)").run('i'+n,titles[n]);db.prepare("INSERT INTO series_items VALUES('series',?,?,?)").run('i'+n,n+1,'label'+n);}
 db.exec("INSERT INTO encrypted_downloads VALUES('d','u','i0','{\"unchanged\":true}',1);ALTER TABLE series DROP COLUMN order_mode;UPDATE schema_version SET version=22");
 const users=db.prepare('SELECT * FROM users').all(),downloads=db.prepare('SELECT * FROM encrypted_downloads').all();db.close();db=openDatabase(path);
 assert.equal(db.prepare('SELECT version FROM schema_version').get().version,23);assert.equal(db.prepare("SELECT order_mode FROM series WHERE id='series'").get().order_mode,'name');
 assert.deepEqual(db.prepare("SELECT asset_id,label FROM series_items ORDER BY position").all().map(r=>[r.asset_id,r.label]),[['i2','label2'],['i1','label1'],['i0','label0']]);assert.deepEqual(db.prepare('SELECT * FROM users').all(),users);assert.deepEqual(db.prepare('SELECT * FROM encrypted_downloads').all(),downloads);
 transaction(db,()=>{db.exec("UPDATE series SET order_mode='manual';UPDATE series_items SET position=position+10");for(let n=0;n<3;n++)db.prepare("UPDATE series_items SET position=? WHERE asset_id=?").run(n+1,'i'+n);});const manual=db.prepare('SELECT * FROM series_items ORDER BY position').all();db.close();db=openDatabase(path);assert.deepEqual(db.prepare('SELECT * FROM series_items ORDER BY position').all(),manual);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('default name order, manual order and one-click reset are authoritative for membership and playback; renaming preserves labels',async t=>{
 const c=await setup(t),ids=[await c.asset('Track 10'),await c.asset('Track 2'),await c.asset('Track 1')];let series=await c.series('Ordered');let r=await c.save(series,ids);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().series.orderMode,'name');assert.deepEqual(r.json().items.map(x=>x.id),[ids[2],ids[1],ids[0]]);series=r.json().series;
 r=await c.req('GET','/items/'+ids[1]+'/series');assert.equal(r.json().currentIndex,1);assert.deepEqual(r.json().items.map(x=>x.id),[ids[2],ids[1],ids[0]]);
 r=await c.req('PATCH','/items/'+ids[0],{title:'Track 0',expectedTitle:'Track 10'});assert.equal(r.statusCode,200,r.body);r=await c.req('GET','/series/'+series.id);series=r.json().series;assert.deepEqual(r.json().items.map(x=>x.id),[ids[0],ids[2],ids[1]]);assert(r.json().items.every(item=>item.series.label===item.id));
 r=await c.save(series,[ids[1],ids[0],ids[2]],{orderMode:'manual'});assert.equal(r.statusCode,200,r.body);series=r.json().series;assert.deepEqual(r.json().items.map(x=>x.id),[ids[1],ids[0],ids[2]]);
 r=await c.save(series,[ids[1],ids[0],ids[2]],{orderMode:'name'});assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().items.map(x=>x.id),[ids[0],ids[2],ids[1]]);assert.deepEqual(c.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('repair targets incomplete current assets only, skips busy assets, preserves custom originals and ignores historical failures',async t=>{
 const c=await setup(t),broken=await c.asset('Broken'),healthy=await c.asset('Healthy'),busy=await c.asset('Busy');
 let r=await c.req('POST','/admin/assets/'+healthy+'/regenerate',{kind:'thumbnail',acknowledgeCost:true});assert.equal((await c.wait(r.json().job.id)).state,'complete');
 c.db.prepare("INSERT INTO admin_jobs(id,kind,asset_id,state,requested_by,created_at,updated_at) VALUES(?,'thumbnail',?,'failed',?,1,1)").run(randomUUID(),healthy,c.owner.user.id);
 const image=await sharp({create:{width:200,height:100,channels:3,background:'#7050aa'}}).png().toBuffer();assert.equal((await c.req('POST','/thumbnails/custom',{assetIds:[broken],image:{mime:'image/png',base64:image.toString('base64')}})).statusCode,200);const custom=c.db.prepare('SELECT image_id FROM thumbnail_overrides WHERE asset_id=?').get(broken).image_id,base=join(c.dir,'thumbnails','custom',custom);await unlink(base+'.webp');await unlink(base+'.jpg');
 // A durable unfinished task is excluded even if its worker has not started.
 c.db.prepare("INSERT INTO admin_jobs(id,kind,asset_id,state,requested_by,created_at,updated_at) VALUES(?,'fixture-held',?,'queued',?,1,1)").run(randomUUID(),busy,c.owner.user.id);
 const reader=(await c.req('POST','/auth/register',{name:'Reader',email:'reader@example.test',password},null)).json();assert.equal((await c.req('GET','/admin/assets/repair-preview',undefined,reader)).statusCode,403);assert.equal((await c.req('POST','/admin/assets/repair-incomplete',{},c.owner)).statusCode,400);
 r=await c.req('GET','/admin/assets/repair-preview');assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().assets.map(x=>x.id),[broken]);assert.equal(r.json().healthy,1);assert.equal(r.json().busy,1);
 const original=await readFile(join(c.dir,'uploads',broken));r=await c.req('POST','/admin/assets/repair-incomplete',{acknowledgeCost:true});assert.equal(r.statusCode,202,r.body);assert.equal(r.json().accepted,1);assert.equal(r.json().skipped,1);const job=c.db.prepare("SELECT id FROM admin_jobs WHERE kind='repair'").get();assert.equal((await c.wait(job.id)).state,'complete');assert.deepEqual(await readFile(join(c.dir,'uploads',broken)),original);assert.deepEqual(await readFile(base+'.input'),image);assert.equal(c.db.prepare('SELECT image_id FROM thumbnail_overrides WHERE asset_id=?').get(broken).image_id,custom);assert.equal((await c.req('GET','/admin/assets/repair-preview')).json().count,0);assert.equal(c.db.prepare("SELECT COUNT(*) n FROM admin_jobs WHERE asset_id=?").get(healthy).n,2);
});

test('phantom conversion state with no task is repaired, source playback tickets and retained raw bytes remain valid, and restart is durable',async t=>{
 const c=await setup(t),bytes=await makeMp4(join(c.dir,'fixture.mp4'),{duration:.4,audio:true}),id=await c.asset('Phantom','video/mp4',bytes);await writeFile(join(c.dir,'originals',id),bytes);
 c.db.prepare("INSERT INTO media_ingest(asset_id,source_mime,source_filename,source_size,retain_original,canonical_ready,metadata_json,created_at) VALUES(?,'video/mp4','fixture.mp4',?,1,0,'{\"duration\":0.4}',1)").run(id,bytes.length);
 let item=(await c.req('GET','/shelves/'+c.shelf+'/items')).json().items.find(x=>x.id===id);assert.equal(item.processingState,'incomplete');assert.equal(item.originalPlayback,true);
 const ticket=(await c.req('POST','/items/'+id+'/playback-ticket')).json();assert.equal(ticket.original,true);
 // Simulate a coordinator interrupted by restart before it could create tasks.
 await c.app.close();const job=randomUUID();c.db.prepare("INSERT INTO admin_jobs(id,kind,asset_id,state,requested_by,created_at,updated_at) VALUES(?,'repair',?,'running',?,1,1)").run(job,id,c.owner.user.id);c.app=await createApp(c.config);assert.equal((await c.wait(job)).state,'complete');
 item=(await c.req('GET','/shelves/'+c.shelf+'/items')).json().items.find(x=>x.id===id);assert.equal(item.originalPlayback,false);assert.equal(item.downloadReady,true);assert.equal(item.processingState,'ready');assert.equal(c.db.prepare("SELECT COUNT(*) n FROM media_tasks WHERE asset_id=? AND state='complete'").get(id).n,3);assert.deepEqual(await readFile(join(c.dir,'originals',id)),bytes);const before=await c.app.inject({url:ticket.url,headers:{range:'bytes=0-31'}});assert.deepEqual(before.rawPayload,bytes.subarray(0,32));
 const preview=await c.req('GET','/admin/assets/repair-preview');assert.equal(preview.json().count,0,preview.body);
 // Loss of only the preview must not force a second transcode.
 const generation=c.db.prepare('SELECT metadata_json FROM video_assets WHERE item_id=?').get(id).metadata_json;await unlink(join(c.dir,'previews',id+'.mp4'));let r=await c.req('POST','/admin/assets/repair-incomplete',{acknowledgeCost:true});assert.equal(r.statusCode,202,r.body);assert.equal(r.json().accepted,1);const repair=c.db.prepare("SELECT id FROM admin_jobs WHERE kind='repair' AND id!=?").get(job);assert.equal((await c.wait(repair.id)).state,'complete');assert.equal(c.db.prepare('SELECT metadata_json FROM video_assets WHERE item_id=?').get(id).metadata_json,generation);
 await unlink(join(c.dir,'thumbnails',id+'.jpg'));await unlink(join(c.dir,'thumbnails',id+'.webp'));r=await c.req('POST','/admin/assets/repair-incomplete',{acknowledgeCost:true});assert.equal(r.json().accepted,1);const coverRepair=c.db.prepare("SELECT id FROM admin_jobs WHERE kind='repair' ORDER BY created_at DESC LIMIT 1").get();assert.equal((await c.wait(coverRepair.id)).state,'complete');assert.equal(c.db.prepare('SELECT preview_version FROM video_thumbnail_state WHERE asset_id=?').get(id).preview_version,2);assert.equal((await c.req('GET','/admin/assets/repair-preview')).json().count,0);
});

test('individual transcode publishes canonical file and clears stale ingest readiness instead of leaving original-only playback',async t=>{
 const c=await setup(t),bytes=await makeMp4(join(c.dir,'retry.mp4'),{duration:.3}),id=await c.asset('Retry','video/mp4',bytes);await writeFile(join(c.dir,'originals',id),bytes);c.db.prepare("INSERT INTO media_ingest(asset_id,source_mime,source_filename,source_size,retain_original,canonical_ready,metadata_json,created_at) VALUES(?,'video/mp4','retry.mp4',?,1,0,'{}',1)").run(id,bytes.length);c.db.prepare("INSERT INTO media_tasks(id,asset_id,kind,state,created_at,updated_at) VALUES(?,?,'transcode','failed',1,1)").run(randomUUID(),id);
 const r=await c.req('POST','/admin/assets/'+id+'/regenerate',{kind:'transcode',acknowledgeCost:true});assert.equal(r.statusCode,202,r.body);assert.equal((await c.wait(r.json().job.id)).state,'complete');assert.equal(c.db.prepare('SELECT canonical_ready FROM media_ingest WHERE asset_id=?').get(id).canonical_ready,1);assert.equal(c.db.prepare("SELECT state FROM media_tasks WHERE asset_id=? AND kind='transcode'").get(id).state,'complete');const ticket=(await c.req('POST','/items/'+id+'/playback-ticket')).json();assert(ticket.hlsUrl);assert.deepEqual(await readFile(join(c.dir,'originals',id)),bytes);
});

test('legacy audio with no task metadata is adopted and repaired from its existing media without requiring the original uploader to retain editor access',async t=>{
 const c=await setup(t),length=4800,bytes=Buffer.alloc(44+length*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(length*2,40);for(let n=0;n<length;n++)bytes.writeInt16LE(Math.round(Math.sin(n*Math.PI*2*440/16000)*5000),44+n*2);
 await writeFile(join(c.dir,'audio.wav'),bytes);await promisify(execFile)(ffmpegPath(),['-hide_banner','-loglevel','error','-y','-i',join(c.dir,'audio.wav'),'-c:a','aac',join(c.dir,'audio.m4a')],{windowsHide:true,timeout:15000});const encoded=await readFile(join(c.dir,'audio.m4a'));
 const id=await c.asset('Legacy audio','audio/mp4',encoded),uploader=(await c.req('POST','/auth/register',{name:'Former',email:'former@example.test',password},null)).json();c.db.prepare('UPDATE items SET uploaded_by=? WHERE id=?').run(uploader.user.id,id);
 const r=await c.req('POST','/admin/assets/repair-incomplete',{acknowledgeCost:true});assert.equal(r.statusCode,202,r.body);assert.equal(r.json().accepted,1);const job=c.db.prepare("SELECT id FROM admin_jobs WHERE kind='repair'").get();assert.equal((await c.wait(job.id)).state,'complete');assert.equal(c.db.prepare('SELECT canonical_ready FROM media_ingest WHERE asset_id=?').get(id).canonical_ready,1);assert(c.db.prepare('SELECT 1 FROM audio_assets WHERE item_id=?').get(id));assert.deepEqual(await readFile(join(c.dir,'originals',id)),encoded);assert.equal((await c.req('GET','/admin/assets/repair-preview')).json().count,0);
});

test('peak protection is transparent for quiet signals, linked across channels, bounded for all-band boosts and never silences sustained content',()=>{
 const rate=48000,limiter=new PeakLimiter(rate,2),length=rate,input=[new Float32Array(length),new Float32Array(length)],output=[new Float32Array(length),new Float32Array(length)];for(let n=0;n<length;n++){input[0][n]=Math.sin(n*2*Math.PI*1000/rate)*.1;input[1][n]=input[0][n]/2;}limiter.process(input,output);for(let n=limiter.delay;n<length;n++){assert(Math.abs(output[0][n]-input[0][n-limiter.delay])<1e-6);assert.equal(output[1][n],output[0][n]/2);}
 const boosted=new PeakLimiter(rate,2);for(let n=0;n<length;n++){input[0][n]=Math.sin(n*2*Math.PI*1000/rate)*16;input[1][n]=input[0][n]/2;}input[0][1000]=100;boosted.process(input,output);let energy=0;for(let n=0;n<length;n++){assert(Number.isFinite(output[0][n]));assert(Math.abs(output[0][n])<=1);assert(Math.abs(output[1][n])<=1);if(n>rate/2)energy+=output[0][n]**2;}assert(Math.sqrt(energy/(rate/2))>.5);
 const mono=new PeakLimiter(rate,2);mono.process([Float32Array.from([NaN,Infinity,1])],[new Float32Array(3),new Float32Array(3)]);assert.equal(EQ_FREQUENCIES.length,15);const migrated=equalizerSettings({enabled:true,gains:[6,3,0,-3,-6]});assert.equal(migrated.gains.length,15);assert.equal(migrated.gains[0],6);assert.equal(migrated.gains.at(-1),-6);
});
