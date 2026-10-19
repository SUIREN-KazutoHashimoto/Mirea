import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

async function setup(t){
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-progress-')),options={dataDir,rateLimit:false,analyticsEnabled:false};
  const c={app:await createApp(options),options};const db=new DatabaseSync(join(dataDir,'mirea.sqlite'));c.db=db;
  t.after(async()=>{db.close();await c.app.close();await rm(dataDir,{recursive:true,force:true});});
  c.req=(method,path,user,body)=>c.app.inject({method,url:`/api/v1${path}`,headers:user?{authorization:`Bearer ${user.token}`}:{},...(body?{payload:body}:{})});
  c.register=async name=>(await c.req('POST','/auth/register',null,{name,email:`${name}@example.test`,password:'progress-test-password'})).json();
  c.owner=await c.register('owner');c.viewer=await c.register('viewer');c.other=await c.register('other');
  c.shelf=(await c.req('POST','/shelves',c.owner,{name:'Resume'})).json().id;
  await c.req('POST',`/shelves/${c.shelf}/members`,c.owner,{email:c.viewer.user.email,role:'viewer'});
  c.asset=mime=>{const id=randomUUID();db.prepare(`INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count) VALUES(?,?,?,?,?,1,?,?,10)`).run(id,c.shelf,'Progress','fixture',mime,c.owner.user.id,Date.now());return id;};
  c.video=c.asset('video/mp4');c.pdf=c.asset('application/pdf');c.images=c.asset('application/vnd.mirea.image-book');
  c.read=(asset=c.video,user=c.viewer)=>c.req('GET',`/items/${asset}/progress`,user);
  c.save=(body,asset=c.video,user=c.viewer)=>c.req('PUT',`/items/${asset}/progress`,user,{revision:0,updateId:randomUUID(),...body});
  return c;
}

test('video progress is per account, available with analytics disabled, survives login/server restart and is scoped by membership',async t=>{
  const c=await setup(t);assert.deepEqual((await c.read()).json(),{progress:null,revision:0});
  const result=await c.save({positionMs:123456,durationMs:600000});assert.equal(result.statusCode,200,result.body);
  assert.equal(result.json().progress.positionMs,123456);assert.equal(result.json().progress.revision,1);
  assert.equal((await c.read(c.video,c.owner)).json().progress,null,'owner does not see viewer progress');
  const items=(await c.req('GET',`/shelves/${c.shelf}/items`,c.viewer)).json().items;
  assert.equal(items.find(item=>item.id===c.video).progress.positionMs,123456);
  assert.ok((await c.req('GET',`/shelves/${c.shelf}/items`,c.owner)).json().items.every(item=>item.progress===null));
  assert.equal((await c.req('GET',`/items/${c.video}/progress?userId=${c.viewer.user.id}`,c.owner)).json().progress,null);
  assert.equal((await c.read(c.video,c.other)).statusCode,404);assert.equal((await c.read(c.video,null)).statusCode,401);
  assert.equal((await c.save({positionMs:3,durationMs:10},c.video,c.other)).statusCode,404);
  await c.req('POST','/auth/logout',c.viewer);
  const newLogin=(await c.req('POST','/auth/login',null,{email:c.viewer.user.email,password:'progress-test-password'})).json();
  await c.app.close();c.app=await createApp(c.options);
  assert.equal((await c.read(c.video,newLogin)).json().progress.positionMs,123456);
  await c.req('DELETE',`/shelves/${c.shelf}/members/${c.viewer.user.id}`,c.owner);
  assert.equal((await c.read(c.video,newLogin)).statusCode,404);
  assert.equal((await c.save({revision:1,positionMs:1,durationMs:2},c.video,newLogin)).statusCode,404);
});

test('PDF/image books keep page, zoom and normalized scroll; invalid mixed/out-of-range positions cannot overwrite',async t=>{
  const c=await setup(t);
  for(const asset of [c.pdf,c.images]){
    const r=await c.save({page:7,scrollX:0.3,scrollY:0.65,zoom:'1.5'},asset);assert.equal(r.statusCode,200,r.body);
    const p=(await c.read(asset)).json().progress;assert.equal(p.page,7);assert.equal(p.scrollY,0.65);assert.equal(p.scrollX,0.3);assert.equal(p.zoom,'1.5');
    for(const state of [{page:11},{page:0},{page:2,scrollY:2},{page:1,zoom:'100'},{page:1,positionMs:2,durationMs:4},{positionMs:0,durationMs:1000}]){
      const invalid=await c.save({revision:1,...state},asset);assert.ok([400,422].includes(invalid.statusCode),invalid.body);
    }
    assert.equal((await c.read(asset)).json().progress.page,7);
  }
  for(const state of [{positionMs:11,durationMs:10},{positionMs:-1,durationMs:10},{page:1},{positionMs:0,durationMs:0},{positionMs:0,durationMs:100,page:1}]){
    assert.ok([400,422].includes((await c.save(state)).statusCode));
  }
});

test('save retries are idempotent and stale concurrent devices cannot rewind newer progress, including explicit restart',async t=>{
  const c=await setup(t),first={revision:0,updateId:randomUUID(),positionMs:10000,durationMs:100000};
  const response=await c.save(first);assert.equal(response.statusCode,200);
  assert.deepEqual((await c.save(first)).json(),response.json(),'lost acknowledgement retry');
  assert.equal((await c.save({...first,positionMs:11000})).statusCode,409,'same ID different payload');
  const stale={revision:0,positionMs:2000,durationMs:100000};assert.equal((await c.save(stale)).statusCode,409);
  assert.equal((await c.read()).json().progress.positionMs,10000);
  assert.equal((await c.save({revision:1,positionMs:100000,durationMs:100000})).json().progress.completed,true);
  assert.equal((await c.save({revision:2,positionMs:0,durationMs:100000})).json().progress.completed,false,'restart is intentional not a max-position merge');
  assert.equal((await c.save(first)).statusCode,409,'very late retry cannot undo restart');
  c.db.prepare('DELETE FROM items WHERE id=?').run(c.video);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM asset_progress').get().n,0,'deleted asset cleans resume state (not analytics logs)');
});
