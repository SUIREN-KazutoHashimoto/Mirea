import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {createApp} from '../server/app.js';

async function setup(t){
 const dataDir=await mkdtemp(join(tmpdir(),'mirea-custom-cover-')),app=await createApp({dataDir,rateLimit:false}),db=new DatabaseSync(join(dataDir,'mirea.sqlite'));db.exec('PRAGMA foreign_keys=ON');
 t.after(async()=>{db.close();await app.close();await rm(dataDir,{recursive:true,force:true});});
 const c={app,db,dataDir};c.req=(method,path,user=c.owner,body)=>app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},...(body?{payload:body}:{})});
 for(const name of ['owner','viewer','other'])c[name]=(await c.req('POST','/auth/register',null,{name,email:name+'@example.test',password:'thumbnail-test-password'})).json();
 c.shelf=(await c.req('POST','/shelves',c.owner,{name:'Media'})).json().id;
 await c.req('POST','/shelves/'+c.shelf+'/members',c.owner,{email:c.viewer.user.email,role:'viewer'});
 c.asset=(shelf=c.shelf)=>{const id=randomUUID();db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count,thumbnail_ready) VALUES(?,?,?,'fixture.pdf','application/pdf',7,?,1,1,1)").run(id,shelf,'Cover '+id,c.owner.user.id);return id;};
 c.one=c.asset();c.two=c.asset();c.original=await sharp({create:{width:24,height:24,channels:3,background:'#558855'}}).jpeg().toBuffer();
 for(const id of [c.one,c.two])await writeFile(join(dataDir,'thumbnails',id+'.jpg'),c.original);
 c.image={mime:'image/png',base64:(await sharp({create:{width:120,height:80,channels:4,background:'#7744ffaa'}}).png().toBuffer()).toString('base64')};
 return c;
}
test('custom thumbnails enforce ACL, validate decoded static images, update bulk atomically and preserve auto-generated originals',async t=>{
 const c=await setup(t),body={assetIds:[c.one,c.two],image:c.image};
 assert.equal((await c.req('POST','/thumbnails/custom',c.viewer,body)).statusCode,403);
 assert.equal((await c.req('POST','/thumbnails/custom',c.other,body)).statusCode,404);
 assert.equal((await c.req('POST','/thumbnails/custom',c.owner,{...body,assetIds:[c.one,randomUUID()]})).statusCode,404);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM thumbnail_overrides').get().n,0);
 for(const image of [{mime:'image/png',base64:Buffer.from('<svg/>').toString('base64')},{...c.image,base64:'!!invalid!!'},{mime:'image/svg+xml',base64:c.image.base64}]){
  assert.ok([400,422].includes((await c.req('POST','/thumbnails/custom',c.owner,{...body,image})).statusCode));
 }
 const set=await c.req('POST','/thumbnails/custom',c.owner,body);assert.equal(set.statusCode,200,set.body);assert.equal(set.json().updated,2);
 const rows=c.db.prepare('SELECT * FROM thumbnail_overrides ORDER BY asset_id').all();assert.equal(rows.length,2);assert.equal(rows[0].image_id,rows[1].image_id);
 const cover=await c.req('GET','/items/'+c.one+'/thumbnail',c.viewer);assert.equal(cover.statusCode,200);assert.equal((await sharp(cover.rawPayload).metadata()).format,'webp');assert.notDeepEqual(cover.rawPayload,c.original);
 assert.deepEqual(await readFile(join(c.dataDir,'thumbnails',c.one+'.jpg')),c.original);
 // Regenerated base cover does not remove the selected override.
 const regenerated=await sharp({create:{width:80,height:120,channels:3,background:'#33aa77'}}).jpeg().toBuffer();await writeFile(join(c.dataDir,'thumbnails',c.one+'.jpg'),regenerated);
 assert.deepEqual((await c.req('GET','/items/'+c.one+'/thumbnail')).rawPayload,cover.rawPayload);
 await c.req('DELETE','/thumbnails/custom',c.owner,{assetIds:[c.one]});const base=(await c.req('GET','/items/'+c.one+'/thumbnail')).rawPayload;assert.equal((await sharp(base).metadata()).format,'webp');assert.notDeepEqual(base,cover.rawPayload);assert.deepEqual(await readFile(join(c.dataDir,'thumbnails',c.one+'.jpg')),regenerated);
 let files=await readdir(join(c.dataDir,'thumbnails','custom'));assert.equal(files.filter(name=>name.endsWith('.jpg')).length,1,'shared image survives while another asset references it');const input=files.find(name=>name.endsWith('.input'));assert(input,'custom source is retained');assert.deepEqual(await readFile(join(c.dataDir,'thumbnails','custom',input)),Buffer.from(c.image.base64,'base64'));
 await c.req('DELETE','/thumbnails/custom',c.owner,{assetIds:[c.two]});files=await readdir(join(c.dataDir,'thumbnails','custom'));assert.deepEqual(files,[input],'resetting selection removes only derivatives, not the uploaded source');
});
test('series thumbnail change includes nested series, but not unrelated or foreign assets',async t=>{
 const c=await setup(t);
 const root=(await c.req('POST','/shelves/'+c.shelf+'/series',c.owner,{title:'Parent'})).json().series;
 const child=(await c.req('POST','/shelves/'+c.shelf+'/series',c.owner,{title:'Child',parentId:root.id})).json().series;
 c.db.prepare("INSERT INTO series_items VALUES(?,?,1,'')").run(root.id,c.one);c.db.prepare("INSERT INTO series_items VALUES(?,?,1,'')").run(child.id,c.two);const untouched=c.asset();
 const r=await c.req('POST','/thumbnails/custom',c.owner,{seriesId:root.id,image:c.image});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().updated,2);assert.equal(c.db.prepare('SELECT * FROM thumbnail_overrides WHERE asset_id=?').get(untouched),undefined);
 assert.equal((await c.req('DELETE','/thumbnails/custom',c.viewer,{seriesId:root.id})).statusCode,403);
});
test('history returns individual authorized assets in last-viewed order with shelf role and progress',async t=>{
 const c=await setup(t),insert=c.db.prepare("INSERT INTO analytics_views(id,user_id,asset_id,shelf_id,asset_kind,asset_title,page_count,context,platform,client_version,auth_session_id,opened_at,first_received_at,last_received_at,counted,active_ms) VALUES(?,?,?,?,'pdf','Fixture',1,'viewer','web','test','test',1,1,?,1,1000)");
 insert.run(randomUUID(),c.owner.user.id,c.one,c.shelf,200);insert.run(randomUUID(),c.owner.user.id,c.two,c.shelf,400);insert.run(randomUUID(),c.owner.user.id,c.one,c.shelf,300);
 const rows=(await c.req('GET','/history')).json().items;assert.deepEqual(rows.map(r=>r.id),[c.two,c.one]);assert(rows.every(r=>r.role==='owner'&&r.shelfName==='Media'&&r.thumbnailUrl));assert.deepEqual((await c.req('GET','/history',c.viewer)).json().items,[]);
});
