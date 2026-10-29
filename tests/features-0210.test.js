import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {createApp} from '../server/app.js';
import {openDatabase} from '../server/database.js';
import {createMediaProcessor} from '../server/media.js';
import {makePdf} from './fixtures.js';
import {EQ_PRESETS,createEqualizer,equalizerSettings,equalizerHeadroom} from '../web/src/equalizer.js';
import {createUploadBatch} from '../web/src/upload-batch.js';
import {recordUploadTransfer,transferRows,clearTransferRecords,serverUploadTransfer,mergeTransferRows} from '../web/src/transfer-manager.js';
const password='isolated-feature-test-password';
async function setup(t,options={}){
 const dataDir=await mkdtemp(join(tmpdir(),'mirea-feature-0210-')),config={dataDir,rateLimit:false,chunkSize:256,...options},c={dataDir,config,app:await createApp(config)},db=openDatabase(join(dataDir,'mirea.sqlite'));c.db=db;
 t.after(async()=>{await c.app.close();db.close();await rm(dataDir,{recursive:true,force:true});});
 c.req=(method,path,user,payload,headers={})=>c.app.inject({method,url:'/api/v1'+path,headers:{...(user?{authorization:'Bearer '+user.token}:{}),...headers},...(payload===undefined?{}:{payload})});
 c.register=async name=>(await c.req('POST','/auth/register',null,{name,email:name+'@example.test',password})).json();c.owner=await c.register('owner');c.shelf=(await c.req('POST','/shelves',c.owner,{name:'Fixture'})).json().id;
 return c;
}
async function waitForJob(c,id){const deadline=Date.now()+30000;while(Date.now()<deadline){const row=c.db.prepare('SELECT * FROM admin_jobs WHERE id=?').get(id);if(['complete','failed'].includes(row?.state))return row;await delay(20);}throw Error('Synthetic job deadline');}

test('616 queued asset records are visible from another login before transfer slots are used; real byte progress and completion survive restart',async t=>{
 let release,blocked=false;const gate=new Promise(r=>release=r),media=createMediaProcessor(),thumbnail=media.thumbnail;media.thumbnail=async(...args)=>{blocked=true;await gate;return thumbnail(...args);};
 t.after(()=>release());const c=await setup(t,{mediaProcessor:media});const pdf=makePdf(),assets=Array.from({length:616},(_,n)=>({id:randomUUID(),shelfId:c.shelf,title:'Fixture '+n,mimeType:'application/pdf',totalBytes:pdf.length}));
 const login=await c.req('POST','/auth/login',null,{email:'owner@example.test',password}),other=await c.register('other');assert.equal(login.statusCode,200,login.body);const second=login.json();assert.notEqual(second.token,c.owner.token);
 let r=await c.req('POST','/transfers/upload-queue',c.owner,{assets});assert.equal(r.statusCode,200,r.body);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM upload_sessions').get().n,0);
 r=await c.req('GET','/transfers/uploads',second);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().queue.length,616);assert(r.json().queue.every(row=>row.state==='queued'&&row.receivedBytes===0));assert.equal((await c.req('GET','/transfers/uploads',other)).json().queue.length,0);
 const started=await c.req('POST','/shelves/'+c.shelf+'/uploads',c.owner,{title:assets[0].title,clientTransferId:assets[0].id,files:[{filename:'fixture.pdf',mime:'application/pdf',size:pdf.length}],resume:true});assert.equal(started.statusCode,201,started.body);const upload=started.json();
 for(let index=0;index<Math.ceil(pdf.length/upload.chunkSize);index++){const bytes=pdf.subarray(index*upload.chunkSize,(index+1)*upload.chunkSize),part=await c.req('PUT',`/uploads/${upload.id}/files/0/parts/${index}`,c.owner,bytes,{'content-type':'application/octet-stream','x-chunk-sha256':createHash('sha256').update(bytes).digest('hex')});assert.equal(part.statusCode,204,part.body);if(index===0){const row=(await c.req('GET','/transfers/uploads',second)).json().queue.find(row=>row.clientTransferId===assets[0].id);assert.equal(row.receivedBytes,bytes.length);assert.equal(row.id,upload.id);assert.equal(row.state,'uploading');}}
 r=await c.req('POST','/uploads/'+upload.id+'/complete',c.owner);assert.equal(r.statusCode,202,r.body);for(let n=0;n<300&&!blocked;n++)await delay(10);assert(blocked);
 const processing=(await c.req('GET','/transfers/uploads',second)).json().queue.find(row=>row.clientTransferId===assets[0].id);assert.equal(processing.state,'processing');assert.equal(processing.receivedBytes,pdf.length);release();
 for(let n=0;n<500&&c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(upload.id).state!=='complete';n++)await delay(20);assert.equal(c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(upload.id).state,'complete');
 await c.app.close();c.app=await createApp(c.config);r=await c.req('GET','/transfers/uploads',second);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().queue.length,615);assert.equal(r.json().uploads.find(row=>row.id===upload.id).receivedBytes,pdf.length);assert.equal(c.db.prepare('SELECT version FROM schema_version').get().version,24);
 c.db.prepare("UPDATE memberships SET role='viewer' WHERE shelf_id=? AND user_id=?").run(c.shelf,c.owner.user.id);r=await c.req('GET','/transfers/uploads',second);assert.deepEqual(r.json().queue,[]);assert.deepEqual(r.json().uploads,[]);
 c.db.prepare("UPDATE memberships SET role='owner' WHERE shelf_id=? AND user_id=?").run(c.shelf,c.owner.user.id);r=await c.req('POST','/transfers/upload-queue/cancel',second,{ids:assets.map(a=>a.id)});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().uploads.length,1);assert.equal((await c.req('GET','/transfers/uploads',second)).json().queue.length,0);assert.equal(c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(upload.id).state,'complete');
});

test('queue registration is idempotent, all-or-nothing, scoped to current edit rights, and history pages are stable',async t=>{
 const c=await setup(t),other=await c.register('other'),asset={id:randomUUID(),shelfId:c.shelf,title:'A',mimeType:'application/pdf',totalBytes:10};
 for(let n=0;n<2;n++)assert.equal((await c.req('POST','/transfers/upload-queue',c.owner,{assets:[asset]})).statusCode,200);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM upload_queue').get().n,1);
 assert.equal((await c.req('POST','/transfers/upload-queue',other,{assets:[asset]})).statusCode,404);assert.equal((await c.req('GET','/transfers/upload-queue/'+asset.id,other)).statusCode,404);
 const own=(await c.req('POST','/shelves',other,{name:'Other'})).json().id;const atomic=await c.req('POST','/transfers/upload-queue',other,{assets:[{...asset,id:randomUUID(),shelfId:own},{...asset,id:randomUUID()}]});assert([403,404].includes(atomic.statusCode));assert.equal(c.db.prepare('SELECT COUNT(*) n FROM upload_queue').get().n,1);
 c.db.prepare('UPDATE upload_queue SET expires_at=0 WHERE id=?').run(asset.id);assert.equal((await c.req('GET','/transfers/uploads',c.owner)).json().queue.length,0);
 const session=c.db.prepare('SELECT id FROM sessions WHERE user_id=?').get(c.owner.user.id).id;
 c.db.exec('BEGIN');for(let n=0;n<125;n++)c.db.prepare("INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at) VALUES(?,?,?,?,?,'[{\"filename\":\"f.pdf\",\"mime\":\"application/pdf\",\"size\":10}]',256,'failed',?,0)").run(randomUUID(),c.shelf,c.owner.user.id,session,'History '+n,n);c.db.exec('COMMIT');
 const first=(await c.req('GET','/transfers/uploads',c.owner)).json(),next=(await c.req('GET','/transfers/uploads?cursor='+encodeURIComponent(first.nextCursor),c.owner)).json();assert.equal(first.uploads.length,100);assert.equal(next.uploads.length,25);assert.equal(new Set([...first.uploads,...next.uploads].map(r=>r.id)).size,125);assert.equal(next.nextCursor,null);assert.equal((await c.req('GET','/transfers/uploads?cursor=not-a-cursor',c.owner)).statusCode,400);assert.deepEqual((await c.req('GET','/transfers/uploads',other)).json().uploads,[]);
});

test('ordinary uploaders and shelf owners regenerate custom covers from their retained original; unrelated editors and revoked users cannot',async t=>{
 const c=await setup(t),uploader=await c.register('uploader'),editor=await c.register('editor'),reader=await c.register('reader');
 for(const [user,role]of [[uploader,'editor'],[editor,'editor'],[reader,'viewer']])c.db.prepare('INSERT INTO memberships VALUES(?,?,?)').run(c.shelf,user.user.id,role);
 const id=randomUUID(),pdf=makePdf();await writeFile(join(c.dataDir,'uploads',id),pdf);c.db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,'Owned','f.pdf','application/pdf',?,?,1)").run(id,c.shelf,pdf.length,uploader.user.id);
 assert.equal((await c.req('GET','/items/'+id+'/thumbnail-job',uploader)).json().allowed,true);assert.equal((await c.req('GET','/items/'+id+'/thumbnail-job',c.owner)).json().allowed,true);
 for(const user of [editor,reader]){assert.equal((await c.req('GET','/items/'+id+'/thumbnail-job',user)).json().allowed,false);assert.equal((await c.req('POST','/items/'+id+'/thumbnail-job',user,{acknowledgeCost:true})).statusCode,403);}
 assert.equal((await c.req('POST','/items/'+id+'/thumbnail-job',uploader,{})).statusCode,400);assert.equal((await c.req('GET','/admin/jobs',uploader)).statusCode,403);
 const png=await sharp({create:{width:1200,height:600,channels:3,background:'#5b72b0'}}).png().toBuffer();let r=await c.req('POST','/thumbnails/custom',uploader,{assetIds:[id],image:{mime:'image/png',base64:png.toString('base64')}});assert.equal(r.statusCode,200,r.body);
 const imageId=c.db.prepare('SELECT image_id FROM thumbnail_overrides WHERE asset_id=?').get(id).image_id,base=join(c.dataDir,'thumbnails','custom',imageId),before=(await c.req('GET','/shelves/'+c.shelf+'/items',uploader)).json().items.find(item=>item.id===id).thumbnailUrl;
 r=await c.req('POST','/items/'+id+'/thumbnail-job',uploader,{acknowledgeCost:true});assert.equal(r.statusCode,202,r.body);assert.equal((await waitForJob(c,r.json().job.id)).state,'complete');assert.equal(c.db.prepare('SELECT kind FROM admin_jobs WHERE id=?').get(r.json().job.id).kind,'owner_thumbnail');
 assert.deepEqual(await readFile(base+'.input'),png);const info=await sharp(base+'.webp').metadata();assert.equal(info.width,1024);assert.equal(info.height,512);assert.notEqual((await c.req('GET','/shelves/'+c.shelf+'/items',uploader)).json().items.find(item=>item.id===id).thumbnailUrl,before);
 c.db.prepare("UPDATE memberships SET role='viewer' WHERE shelf_id=? AND user_id=?").run(c.shelf,uploader.user.id);assert.equal((await c.req('POST','/items/'+id+'/thumbnail-job',uploader,{acknowledgeCost:true})).statusCode,403);assert.deepEqual(c.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('Web equalizer is lazy, bounds unsafe values, reuses its media graph and never reloads or pauses playback',async()=>{
 let created=0,sources=0,closed=0;const filters=[];function parameter(){return {value:0,setTargetAtTime(v){this.value=v;}};}function graph(){return {connect(){},disconnect(){},gain:parameter()};}
 class Context{constructor(){created++;this.state='suspended';this.currentTime=0;this.destination={};}async resume(){this.state='running';}createGain(){return graph();}createMediaElementSource(){sources++;return graph();}createBiquadFilter(){const node={...graph(),frequency:parameter(),Q:parameter()};filters.push(node);return node;}async close(){closed++;}}
 const media=new EventTarget(),store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},eq=createEqualizer(media,{Context,storage,protection:async()=>graph()});assert.equal(created,0);await eq.set({enabled:false,gains:[99,-99,NaN,2.1,Infinity,...Array(10).fill(0)]});assert.deepEqual(eq.settings.gains,[12,-12,0,2,0,...Array(10).fill(0)]);assert.equal(created,0);
 await eq.set({enabled:true,gains:EQ_PRESETS.bass.gains});assert.equal(sources,1);assert(filters[0].gain.value>0);assert.equal(equalizerHeadroom(eq.settings),1);await eq.set({enabled:false,gains:EQ_PRESETS.bass.gains});assert(filters.every(f=>f.gain.value===0));assert.equal(equalizerHeadroom(eq.settings),1);await eq.set({enabled:true,gains:EQ_PRESETS.voice.gains});assert.equal(sources,1);eq.dispose();assert.equal(closed,1);
 const saved=createEqualizer(new EventTarget(),{Context,storage});assert.deepEqual(saved.settings,{enabled:true,gains:EQ_PRESETS.voice.gains});saved.dispose();assert.deepEqual(equalizerSettings(null),{enabled:false,gains:Array(15).fill(0)});
});

test('owner regeneration rechecks access before promotion and resumes its durable running record after server restart',async t=>{
 let release,block=false,entered=false;const held=new Promise(r=>release=r),media=createMediaProcessor(),thumbnail=media.thumbnail;media.thumbnail=async(...args)=>{if(block){entered=true;await held;}return thumbnail(...args);};t.after(()=>release());const c=await setup(t,{mediaProcessor:media}),user=await c.register('editor');c.db.prepare("INSERT INTO memberships VALUES(?,?,'editor')").run(c.shelf,user.user.id);
 const id=randomUUID(),pdf=makePdf();await writeFile(join(c.dataDir,'uploads',id),pdf);c.db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,'Retained','f.pdf','application/pdf',?,?,1)").run(id,c.shelf,pdf.length,user.user.id);
 const png=await sharp({create:{width:800,height:400,channels:3,background:'#5f41b3'}}).png().toBuffer();assert.equal((await c.req('POST','/thumbnails/custom',user,{assetIds:[id],image:{mime:'image/png',base64:png.toString('base64')}})).statusCode,200);const image=c.db.prepare('SELECT image_id FROM thumbnail_overrides WHERE asset_id=?').get(id).image_id,base=join(c.dataDir,'thumbnails','custom',image),before=await readFile(base+'.webp');
 block=true;let r=await c.req('POST','/items/'+id+'/thumbnail-job',user,{acknowledgeCost:true});assert.equal(r.statusCode,202,r.body);const waiting=Date.now()+30000;while(!entered&&Date.now()<waiting)await delay(20);assert(entered);assert.equal((await c.req('POST','/items/'+id+'/thumbnail-job',user,{acknowledgeCost:true})).statusCode,409);
 c.db.prepare("UPDATE memberships SET role='viewer' WHERE shelf_id=? AND user_id=?").run(c.shelf,user.user.id);release();assert.equal((await waitForJob(c,r.json().job.id)).state,'failed');assert.deepEqual(await readFile(base+'.webp'),before);assert.deepEqual(await readFile(base+'.input'),png);
 await c.app.close();c.db.prepare("UPDATE memberships SET role='editor' WHERE shelf_id=? AND user_id=?").run(c.shelf,user.user.id);const resumeId=randomUUID();c.db.prepare("INSERT INTO admin_jobs(id,kind,asset_id,state,requested_by,created_at,updated_at) VALUES(?,'owner_thumbnail',?,'running',?,1,1)").run(resumeId,id,user.user.id);c.config.mediaProcessor=createMediaProcessor();c.app=await createApp(c.config);assert.equal((await waitForJob(c,resumeId)).state,'complete');assert.deepEqual(await readFile(base+'.input'),png);assert.equal((await c.req('GET','/admin/jobs',user)).statusCode,403);
});

test('asset transfer records deduplicate remote progress, preserve callbacks, and cannot reappear after logout',()=>{
 clearTransferRecords();let cancelled=0;const local=recordUploadTransfer({clientTransferId:'client',title:'Asset',cancel:()=>cancelled++});local.update({state:'running',percent:25,serverId:'server'});const remote=serverUploadTransfer({id:'server',clientTransferId:'client',title:'Asset',state:'processing',receivedBytes:100,totalBytes:100,createdAt:1,processing:{stage:'encode'}});const merged=mergeTransferRows(transferRows(),[remote]);assert.equal(merged.length,1);assert.equal(merged[0].state,'processing');merged[0].cancel();assert.equal(cancelled,1);clearTransferRecords();local.update({state:'complete'});assert.deepEqual(transferRows(),[]);
});

test('cancelling one queued asset never starts it and does not cancel another active transfer',async()=>{
 let release;const held=new Promise(r=>release=r),starts=[],batch=createUploadBatch([{key:'a'},{key:'b'},{key:'c'}],{concurrency:1,start:job=>{starts.push(job.key);return {promise:job.key==='a'?held:Promise.resolve(),abort(){throw Error('another asset must not be aborted');}};}});await delay(0);batch.cancelAsset('b');release();const result=await batch.promise;assert.deepEqual(starts,['a','c']);assert.equal(result.rows[1].state,'cancelled');
});

test('cancelling one active upload cannot become failed/complete on late callbacks or stop another asset',async()=>{
 let fail,finish,late;const first=new Promise((_,r)=>fail=r),second=new Promise(r=>finish=r);let aborts=0;const batch=createUploadBatch([{key:'a'},{key:'b'}],{concurrency:2,start:(job,progress)=>job.key==='a'?(late=progress,{promise:first,abort(){aborts++;fail(new DOMException('cancelled','AbortError'));}}):{promise:second,abort(){throw Error('wrong asset');}}});await delay(0);batch.cancelAsset('a');late(99);finish();const result=await batch.promise;assert.equal(aborts,1);assert.equal(result.rows[0].state,'cancelled');assert.equal(result.rows[1].state,'complete');
});
