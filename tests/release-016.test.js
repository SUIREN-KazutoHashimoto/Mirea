import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import Fastify from 'fastify';
import {createApp} from '../server/app.js';
import {createJobPool} from '../server/job-pool.js';
import {thumbnailWebp} from '../server/thumbnail-webp.js';
import {createUploadBatch} from '../web/src/upload-batch.js';
import {signUpdateEnvelope} from '../server/update-manifest.js';
import {registerAppUpdates} from '../server/app-updates.js';
import {registerVideoPreviews} from '../server/video-previews.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function fixture(t,options={}){
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-016-')),settings={dataDir,rateLimit:false,...options};
  const app=await createApp(settings),db=new DatabaseSync(join(dataDir,'mirea.sqlite'));db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{await app.close();db.close();await rm(dataDir,{recursive:true,force:true});});
  const req=(method,path,user,body)=>app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},...(body===undefined?{}:{payload:body})});
  const owner=(await req('POST','/auth/register',null,{name:'Synthetic QA',email:'qa@example.test',password:'synthetic-test-password'})).json();
  const shelf=(await req('POST','/shelves',owner,{name:'Synthetic shelf'})).json().id;
  const series=async(title,parentId=null,reuseExisting=false)=>(await req('POST','/shelves/'+shelf+'/series',owner,{title,parentId,reuseExisting}));
  return {app,db,req,owner,shelf,series,settings,dataDir};
}
test('shared jobs run five concurrently, honor live limits, and cancel queued work without executing it',async()=>{
  let limit=5,peak=0,active=0;const gate=deferred(),pool=createJobPool(()=>limit);
  const work=()=>{active++;peak=Math.max(peak,active);return gate.promise.finally(()=>active--);};
  const running=Array.from({length:8},(_,n)=>pool.run(work,String(n)));await tick();assert.equal(active,5);assert.equal(pool.queued,3);
  assert.equal(pool.cancel('7'),true);assert.equal(pool.queued,2);limit=1;gate.resolve();await Promise.all(running);assert.equal(peak,5);assert.equal(pool.running,0);
});
test('next upload starts at transfer acceptance, not at conversion completion',async()=>{
  const complete=[],accepted=[],started=[];
  const batch=createUploadBatch([1,2,3,4].map(key=>({key})),{concurrency:1,start:job=>{
    const done=deferred(),sent=deferred();started.push(job.key);complete.push(done);accepted.push(sent);return {promise:done.promise,transferred:sent.promise,abort(){done.reject(Error('cancelled'));sent.reject(Error('cancelled'));}};
  }});
  await tick();assert.deepEqual(started,[1]);accepted[0].resolve({id:'1'});await tick();assert.deepEqual(started,[1,2]);
  for(let n=1;n<4;n++){accepted[n].resolve({id:String(n)});await tick();}assert.equal(started.length,4);
  complete.forEach(done=>done.resolve({item:{id:randomUUID()}}));const result=await batch.promise;assert.ok(result.rows.every(row=>row.state==='complete'));
});
test('unique sibling names, folder reuse and explicit asset moves preserve existing content',async t=>{
  const c=await fixture(t),root=(await c.series('Album')).json().series;
  assert.equal((await c.series('Album')).statusCode,409);
  const reused=await c.series('Album',null,true);assert.equal(reused.statusCode,201);assert.equal(reused.json().created,false);assert.equal(reused.json().series.id,root.id);
  const child=(await c.series('Album',root.id)).json().series;assert.notEqual(child.id,root.id);
  const second=(await c.series('Other')).json().series;
  let response=await c.req('PUT','/series/'+second.id,c.owner,{revision:second.revision,title:'Album',description:'',items:[]});assert.equal(response.statusCode,409);
  const id=randomUUID();c.db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,'fixture.pdf','application/pdf',1,?,?)").run(id,c.shelf,'Private synthetic fixture',c.owner.user.id,Date.now());
  c.db.prepare('INSERT INTO series_items VALUES(?,?,1,?)').run(root.id,id,'');
  response=await c.req('PUT','/series/'+child.id,c.owner,{revision:child.revision,title:child.title,description:'',items:[{assetId:id}],moveAssets:true});assert.equal(response.statusCode,200,response.body);
  assert.equal(c.db.prepare('SELECT series_id FROM series_items WHERE asset_id=?').get(id).series_id,child.id);
  assert.ok(c.db.prepare('SELECT 1 FROM items WHERE id=?').get(id));
});
test('recursive deletion requires an exact preview, rejects stale contents, and cleans descendants but not unrelated assets',async t=>{
  const c=await fixture(t),root=(await c.series('Root')).json().series,child=(await c.series('Child',root.id)).json().series;
  const add=series=>{const id=randomUUID();c.db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,'Synthetic','a.pdf','application/pdf',1,?,?)").run(id,c.shelf,c.owner.user.id,Date.now());if(series)c.db.prepare('INSERT INTO series_items VALUES(?,?,1,?)').run(series,id,'');return id;};
  const member=add(child.id),outside=add();let rootNow=(await c.req('GET','/series/'+root.id,c.owner)).json().series;
  const preview=(await c.req('GET','/series/'+root.id+'/delete-preview',c.owner)).json();assert.equal(preview.seriesCount,2);assert.equal(preview.assetCount,1);
  let response=await c.req('DELETE','/series/'+root.id,c.owner,{revision:rootNow.revision,deleteContents:true,previewHash:'0'.repeat(64)});assert.equal(response.statusCode,409);assert.ok(c.db.prepare('SELECT 1 FROM items WHERE id=?').get(member));
  response=await c.req('DELETE','/series/'+root.id,c.owner,{revision:rootNow.revision,deleteContents:true,previewHash:preview.previewHash});assert.equal(response.statusCode,204,response.body);
  assert.equal(c.db.prepare('SELECT 1 FROM series WHERE id=?').get(child.id),undefined);assert.equal(c.db.prepare('SELECT 1 FROM items WHERE id=?').get(member),undefined);assert.ok(c.db.prepare('SELECT 1 FROM items WHERE id=?').get(outside));
});
test('processing settings require an administrator and password; upload slots exclude server processing',async t=>{
  const c=await fixture(t);c.settings.serverAdminUserIds=[c.owner.user.id];
  const values={maxConcurrentUploads:1,maxConcurrentJobs:2,maxUploadAssets:500,currentPassword:'synthetic-test-password'};
  assert.equal((await c.req('PATCH','/admin/processing-settings',c.owner,{...values,currentPassword:'wrong'})).statusCode,403);
  assert.equal((await c.req('PATCH','/admin/processing-settings',c.owner,values)).statusCode,200);
  assert.equal((await c.req('GET','/config')).json().maxConcurrentJobs,2);
  const body={title:'Synthetic',files:[{filename:'a.pdf',mime:'application/pdf',size:10}]};
  const first=(await c.req('POST','/shelves/'+c.shelf+'/uploads',c.owner,body)).json();assert.ok(first.id);
  assert.equal((await c.req('POST','/shelves/'+c.shelf+'/uploads',c.owner,body)).statusCode,429);
  c.db.prepare("UPDATE upload_sessions SET state='processing' WHERE id=?").run(first.id);
  assert.equal((await c.req('POST','/shelves/'+c.shelf+'/uploads',c.owner,{...body,title:'Next synthetic'})).statusCode,201);
  assert.equal((await c.req('PATCH','/shelves/'+c.shelf,c.owner,{name:'Synthetic shelf',private:true})).statusCode,200);
  assert.equal((await c.req('GET','/library/catalog',c.owner)).json().shelves[0].private,1);
});
test('new installs alone get a default admin; known credentials warn and cannot perform administrative actions',async t=>{
  const c=await fixture(t,{bootstrapAdmin:true}),login=await c.req('POST','/auth/login',null,{email:'admin@example.com',password:'ChangeMe'});assert.equal(login.statusCode,200,login.body);
  const admin=login.json();assert.equal(admin.user.defaultCredentialWarning,true);assert.equal((await c.req('GET','/admin/processing-settings',admin)).statusCode,403);
  const changed=await c.req('PATCH','/account',admin,{currentPassword:'ChangeMe',email:'new-admin@example.test',newPassword:'a-new-strong-password'});assert.equal(changed.statusCode,200,changed.body);assert.ok(!changed.json().user.defaultCredentialWarning);
  assert.equal((await c.req('GET','/admin/processing-settings',changed.json())).statusCode,200);
});
test('WebP thumbnails preserve original bytes and dimensions below the cap, and bound larger images without distortion',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mirea-webp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const [width,height]of [[300,200],[1600,800],[800,1600]]){
    const source=join(dir,width+'-'+height+'.jpg'),original=await sharp({create:{width,height,channels:3,background:'#5468bf'}}).jpeg().toBuffer();await writeFile(source,original);
    const image=await thumbnailWebp(source),info=await sharp(image).metadata();assert.equal(info.format,'webp');assert.ok(Math.max(info.width,info.height)<=1024);assert.equal(info.width/info.height,width/height);if(width<1024&&height<1024){assert.equal(info.width,width);assert.equal(info.height,height);}assert.deepEqual(await readFile(source),original);
  }
});
test('unconfigured container serves only a current signed release manifest; expired or forged metadata fails closed',async t=>{
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=keys.publicKey.export({type:'spki',format:'pem'}),now=Date.now();
  const payload={schemaVersion:1,packageName:'com.suiren.mirea',versionCode:33,versionName:'0.16.0beta',apkUrl:'https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/download/v0.16.0beta/mirea-0.16.0beta-android.apk',sha256:'a'.repeat(64),signerSha256:'b'.repeat(64),size:100,minSdk:29,issuedAt:now,expiresAt:now+3600000};
  let raw=signUpdateEnvelope(payload,keys.privateKey),requested='';const app=Fastify();app.setErrorHandler((e,req,reply)=>reply.code(e.statusCode??500).send({error:e.message}));
  registerAppUpdates(app,{releaseVersion:'0.16.0-beta',publicKey,fetcher:async url=>{requested=url;return new Response(raw);}});t.after(()=>app.close());
  let response=await app.inject('/api/v1/app-updates/android/manifest');assert.equal(response.statusCode,200,response.body);assert.match(requested,/v0\.16\.0beta\/mirea-android-update\.json$/);
  response=await app.inject('/api/v1/app-updates/android/apk/33');assert.equal(response.statusCode,302);assert.equal(response.headers.location,payload.apkUrl);
  const bad=Fastify();bad.setErrorHandler((e,req,reply)=>reply.code(e.statusCode??500).send({error:e.message}));registerAppUpdates(bad,{releaseVersion:'0.16.0-beta',publicKey,fetcher:async()=>new Response('{}')});t.after(()=>bad.close());assert.equal((await bad.inject('/api/v1/app-updates/android/manifest')).statusCode,503);
});

test('history removal is per user and presentation-only; an old heartbeat does not restore it, a new viewing session does',async t=>{
  const c=await fixture(t),asset=randomUUID(),view=randomUUID(),time=Date.now()-1000;
  c.db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,'Synthetic history','a.pdf','application/pdf',1,?,?)").run(asset,c.shelf,c.owner.user.id,time);
  c.db.prepare("INSERT INTO analytics_views(id,user_id,asset_id,shelf_id,asset_kind,asset_title,page_count,context,platform,client_version,auth_session_id,opened_at,first_received_at,last_received_at,counted) VALUES(?,?,?,?,'pdf','Synthetic history',1,'viewer','web','test','test-session',?,?,?,1)").run(view,c.owner.user.id,asset,c.shelf,time,time,time);
  assert.equal((await c.req('GET','/history',c.owner)).json().items.length,1);
  assert.equal((await c.req('DELETE','/history/'+asset,c.owner)).statusCode,204);
  const hidden=c.db.prepare('SELECT hidden_at FROM history_hidden WHERE user_id=? AND asset_id=?').get(c.owner.user.id,asset).hidden_at;
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM analytics_views').get().n,1);
  c.db.prepare('UPDATE analytics_views SET last_received_at=? WHERE id=?').run(hidden+10,view);
  assert.equal((await c.req('GET','/history',c.owner)).json().items.length,0);
  c.db.prepare('UPDATE analytics_views SET first_received_at=? WHERE id=?').run(hidden+10,view);
  assert.equal((await c.req('GET','/history',c.owner)).json().items.length,1);
  assert.equal((await c.req('DELETE','/history',c.owner)).statusCode,204);
});

test('lazy preview generation waits for the same global processing pool as other jobs',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mirea-016-preview-')),app=Fastify(),pool=createJobPool(()=>1),hold=deferred(),running=pool.run(()=>hold.promise),id=randomUUID();let calls=0;
  t.after(async()=>{hold.resolve();await running;await app.close();await rm(dir,{recursive:true,force:true});});
  await registerVideoPreviews(app,{dataDir:dir,uploadDir:dir,jobPool:pool,db:{prepare:()=>({get:()=>({id})})},media:{preview:async(_source,path)=>{calls++;await writeFile(path,'preview');}},authenticate:req=>{req.user={id:'synthetic'};},findItem:()=>({id,mime_type:'video/mp4'})});
  assert.equal((await app.inject({method:'POST',url:'/api/v1/items/'+id+'/preview'})).statusCode,202);await tick();assert.equal(calls,0);assert.equal(pool.queued,1);
  hold.resolve();await running;for(let n=0;n<50&&calls===0;n++)await tick();assert.equal(calls,1);
});
