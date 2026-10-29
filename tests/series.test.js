import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

async function setup(t){
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-series-')),options={dataDir,rateLimit:false};
  const c={app:await createApp(options),options};c.db=new DatabaseSync(join(dataDir,'mirea.sqlite'));c.db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{c.db.close();await c.app.close();await rm(dataDir,{recursive:true,force:true});});
  c.req=(method,path,user=c.owner,body)=>c.app.inject({method,url:`/api/v1${path}`,headers:user?{authorization:`Bearer ${user.token}`}:{},...(body?{payload:body}:{})});
  for(const name of ['owner','editor','viewer','other'])c[name]=(await c.req('POST','/auth/register',null,{name,email:`${name}@example.test`,password:'series-test-password'})).json();
  c.shelf=(await c.req('POST','/shelves',c.owner,{name:'Series shelf'})).json().id;
  c.otherShelf=(await c.req('POST','/shelves',c.other,{name:'Other shelf'})).json().id;
  for(const role of ['editor','viewer'])await c.req('POST',`/shelves/${c.shelf}/members`,c.owner,{email:c[role].user.email,role});
  c.asset=(mime,title,shelf=c.shelf,user=c.owner)=>{const id=randomUUID();c.db.prepare(`INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count) VALUES(?,?,?,?,?,1,?,?,10)`).run(id,shelf,title,'fixture',mime,user.user.id,Date.now());return id;};
  c.pdf=c.asset('application/pdf','Volume 10');c.images=c.asset('application/vnd.mirea.image-book','Volume 2');c.video=c.asset('video/mp4','Episode 1');
  c.create=async(title='Mixed series',user=c.owner)=>(await c.req('POST',`/shelves/${c.shelf}/series`,user,{title,description:'A collection'})).json().series;
  c.read=(id,user=c.owner)=>c.req('GET',`/series/${id}`,user);
  c.save=(series,items,user=c.owner,extra={})=>c.req('PUT',`/series/${series.id}`,user,{revision:series.revision,title:series.title,description:series.description,items:items.map(assetId=>({assetId,label:''})),orderMode:'manual',...extra});
  return c;
}

test('mixed-media series keep explicit order/labels, self-only progress and survive restart',async t=>{
  const c=await setup(t),series=await c.create();
  const r=await c.save(series,[c.images,c.video,c.pdf],c.editor,{items:[{assetId:c.images,label:'第2巻'},{assetId:c.video,label:'第1話'},{assetId:c.pdf,label:'外伝'}]});
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().series.revision,2);
  assert.deepEqual(r.json().items.map(i=>i.id),[c.images,c.video,c.pdf]);
  const shelf=(await c.req('GET',`/shelves/${c.shelf}/items`,c.viewer)).json();
  assert.equal(shelf.series[0].assetCount,3);assert.equal(shelf.series[0].coverId,c.images);
  assert.equal(shelf.items.find(i=>i.id===c.pdf).series.label,'外伝');
  await c.req('PUT',`/items/${c.images}/progress`,c.viewer,{revision:0,updateId:randomUUID(),page:4,scrollY:0.5});
  const viewer=(await c.read(series.id,c.viewer)).json();assert.equal(viewer.items[0].progress.page,4);
  assert.ok((await c.read(series.id,c.owner)).json().items.every(i=>i.progress===null));
  for(const [id,index] of [[c.images,0],[c.video,1],[c.pdf,2]]){
    const context=(await c.req('GET',`/items/${id}/series`,c.viewer)).json();assert.equal(context.currentIndex,index);assert.equal(context.items.length,3);
  }
  await c.app.close();c.app=await createApp(c.options);
  assert.deepEqual((await c.read(series.id)).json().items.map(i=>i.series.label),['第2巻','第1話','外伝']);
});

test('series use bookshelf permissions, conceal inaccessible metadata and recheck revoked membership',async t=>{
  const c=await setup(t),series=await c.create();await c.save(series,[c.pdf]);
  for(const path of [`/series/${series.id}`,`/shelves/${c.shelf}/series`,`/items/${c.pdf}/series`]){
    assert.equal((await c.req('GET',path,c.viewer)).statusCode,200);
    assert.equal((await c.req('GET',path,c.other)).statusCode,404);
    assert.equal((await c.req('GET',path,null)).statusCode,401);
  }
  assert.equal((await c.req('POST',`/shelves/${c.shelf}/series`,c.viewer,{title:'Forbidden'})).statusCode,403);
  assert.equal((await c.save(series,[],c.viewer)).statusCode,403);
  assert.equal((await c.req('DELETE',`/series/${series.id}`,c.viewer,{revision:2})).statusCode,403);
  assert.equal((await c.save(series,[],c.other)).statusCode,404);
  await c.req('DELETE',`/shelves/${c.shelf}/members/${c.viewer.user.id}`,c.owner);
  assert.equal((await c.read(series.id,c.viewer)).statusCode,404);
  assert.equal((await c.req('GET',`/items/${c.pdf}/series`,c.viewer)).statusCode,404);
});

test('atomic edits reject duplicates, other shelves, other series and stale updates without losing members',async t=>{
  const c=await setup(t);let series=await c.create();const another=await c.create('Another');
  series=(await c.save(series,[c.pdf,c.images])).json().series;
  await c.save(another,[c.video]);
  const foreign=c.asset('application/pdf','Private',c.otherShelf,c.other);
  for(const [ids,status] of [[[c.pdf,c.pdf],422],[[foreign],422],[[randomUUID()],422],[[c.video],409]]){
    const r=await c.save(series,ids);assert.equal(r.statusCode,status,r.body);
    assert.deepEqual((await c.read(series.id)).json().items.map(i=>i.id),[c.pdf,c.images]);
  }
  assert.equal((await c.save(series,[],c.owner,{title:'   '})).statusCode,422);
  assert.equal((await c.save(series,[],c.owner,{items:[{assetId:c.pdf,label:'x'.repeat(81)}]})).statusCode,400);
  assert.equal((await c.save(series,[],c.owner,{items:Array.from({length:1001},()=>({assetId:c.pdf}))})).statusCode,400);
  const updated=(await c.save(series,[c.images,c.pdf],c.editor)).json().series;
  assert.equal((await c.save(series,[])).statusCode,409);
  assert.equal((await c.req('DELETE',`/series/${series.id}`,c.owner,{revision:series.revision})).statusCode,409);
  assert.deepEqual((await c.read(series.id)).json().items.map(i=>i.id),[c.images,c.pdf]);
  assert.equal((await c.save(updated,[c.images])).statusCode,200);
  const otherNow=(await c.read(another.id)).json().series;
  assert.equal((await c.save(otherNow,[c.pdf,c.video])).statusCode,200,'explicitly removed member can move to a different series');
});

test('deleting assets invalidates stale series edits; removing a series preserves media/progress/download registrations/history',async t=>{
  const c=await setup(t);let series=await c.create();series=(await c.save(series,[c.pdf,c.images,c.video])).json().series;
  c.db.prepare('DELETE FROM items WHERE id=?').run(c.pdf);
  assert.equal((await c.save(series,[c.images,c.video])).statusCode,409);
  let detail=(await c.read(series.id)).json();assert.deepEqual(detail.items.map(i=>i.id),[c.images,c.video]);
  const context=(await c.req('GET',`/items/${c.images}/series`)).json();assert.equal(context.currentIndex,0,'navigation uses current list index even after position gaps');
  assert.equal(context.items[0].series.position,1);
  assert.equal((await c.req('GET',`/shelves/${c.shelf}/items`)).json().items.find(i=>i.id===c.images).series.position,1);
  await c.req('PUT',`/items/${c.images}/progress`,c.viewer,{revision:0,updateId:randomUUID(),page:7});
  c.db.prepare('INSERT INTO encrypted_downloads(id,user_id,asset_id,manifest_json,created_at) VALUES(?,?,?,?,1)').run(randomUUID(),c.viewer.user.id,c.images,'{}');
  c.db.prepare(`INSERT INTO analytics_views(id,user_id,asset_id,shelf_id,asset_kind,asset_title,page_count,context,platform,client_version,auth_session_id,opened_at,first_received_at,last_received_at)
    VALUES('view',?,?,?,'image-book','Preserved',10,'viewer','web','test','session',1,1,1)`).run(c.viewer.user.id,c.images,c.shelf);
  const before=c.db.prepare('SELECT COUNT(*) n FROM items').get().n;
  assert.equal((await c.req('DELETE',`/series/${series.id}`,c.editor,{revision:detail.series.revision})).statusCode,204);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM items').get().n,before);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM asset_progress').get().n,1);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM encrypted_downloads').get().n,1);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM analytics_views').get().n,1);
  assert.deepEqual((await c.req('GET',`/items/${c.images}/series`)).json(),{series:null,items:[],currentIndex:-1});
  assert.equal((await c.read(series.id)).statusCode,404);
});

test('database enforces same-shelf membership even outside the API',async t=>{
  const c=await setup(t),series=await c.create(),foreign=c.asset('application/pdf','Other',c.otherShelf,c.other);
  assert.throws(()=>c.db.prepare('INSERT INTO series_items VALUES(?,?,1,?)').run(series.id,foreign,''),/share a shelf/);
  await c.save(series,[c.images]);
  assert.throws(()=>c.db.prepare('UPDATE series_items SET asset_id=? WHERE series_id=?').run(foreign,series.id),/share a shelf/);
  assert.throws(()=>c.db.prepare('UPDATE items SET shelf_id=? WHERE id=?').run(c.otherShelf,c.images),/before moving/);
  assert.throws(()=>c.db.prepare('UPDATE series SET shelf_id=? WHERE id=?').run(c.otherShelf,series.id),/before moving/);
  assert.deepEqual(c.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
