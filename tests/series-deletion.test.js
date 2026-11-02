import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.js';

for(const withStoryboard of [false,true])test('recursive deletion of 35 series and 101 published assets with retained upload records'+(withStoryboard?' and large storyboard cascade':''),async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-delete-regression-'));
  const app=await createApp({dataDir,rateLimit:false}),db=new DatabaseSync(join(dataDir,'mirea.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{await app.close();db.close();await rm(dataDir,{recursive:true,force:true});});
  const errors=[];app.addHook('onError',async(_req,_reply,error)=>{errors.push(error.stack);});
  let token;
  const req=(method,path,payload)=>app.inject({method,url:'/api/v1'+path,headers:token?{authorization:'Bearer '+token}:{},...(payload?{payload}:{})});
  const owner=(await req('POST','/auth/register',{name:'Synthetic owner',email:'delete-test@example.test',password:'synthetic-test-password'})).json();token=owner.token;
  const shelf=(await req('POST','/shelves',{name:'Synthetic shelf'})).json().id;
  const series=[];
  for(let n=0;n<35;n++){
    const response=await req('POST','/shelves/'+shelf+'/series',{title:'Series '+n,parentId:n?series[Math.floor((n-1)/3)].id:null,requestId:randomUUID()});
    assert.equal(response.statusCode,201,response.body);series.push(response.json().series);
  }
  for(let n=0;n<101;n++){
    const id=randomUUID(),parent=series[n%35].id,now=Date.now();
    db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,'fixture.pdf','application/pdf',1,?,?)").run(id,shelf,'Asset '+n,owner.user.id,now);
    db.prepare('INSERT INTO series_items VALUES(?,?,?,?)').run(parent,id,Math.floor(n/35)+1,'');
    if(withStoryboard&&n===0)db.prepare("INSERT INTO video_navigation(item_id,state,storyboard,updated_at) VALUES(?,'ready',?,?)").run(id,Buffer.alloc(8*1024*1024,7),now);
    db.prepare("INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at,target_series_id,series_requested) VALUES(?,?,?,'synthetic',?,'[]',8388608,'complete',?,?,?,1)").run(id,shelf,owner.user.id,'Asset '+n,now,now+86400000,parent);
  }
  const root=(await req('GET','/series/'+series[0].id)).json().series,previewResponse=await req('GET','/series/'+root.id+'/delete-preview');
  assert.equal(previewResponse.statusCode,200,previewResponse.body);
  const preview=previewResponse.json();assert.deepEqual([preview.seriesCount,preview.assetCount,preview.pendingCount],[35,101,0]);
  const response=await req('DELETE','/series/'+root.id,{revision:root.revision,deleteContents:true,previewHash:preview.previewHash});
  assert.equal(response.statusCode,204,response.body+'\n'+errors.join('\n'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM series').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM video_navigation').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM upload_sessions').get().n,0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

async function deletionFixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-delete-membership-')),app=await createApp({dataDir,rateLimit:false}),db=new DatabaseSync(join(dataDir,'mirea.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');t.after(async()=>{await app.close();db.close();await rm(dataDir,{recursive:true,force:true});});
  let token;const req=(method,path,payload)=>app.inject({method,url:'/api/v1'+path,headers:token?{authorization:'Bearer '+token}:{},...(payload?{payload}:{})});
  const owner=(await req('POST','/auth/register',{name:'Synthetic owner',email:'membership-delete@example.test',password:'synthetic-test-password'})).json();token=owner.token;
  const shelf=(await req('POST','/shelves',{name:'Synthetic shelf'})).json().id;
  const create=async(title,parentId=null)=>{const result=await req('POST','/shelves/'+shelf+'/series',{title,parentId});assert.equal(result.statusCode,201,result.body);return result.json().series;};
  const upload=(title,targetSeries,{published=true,memberSeries=targetSeries,state='processing'}={})=>{
    const id=randomUUID(),now=Date.now();
    if(published){db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,'fixture.pdf','application/pdf',1,?,?)").run(id,shelf,title,owner.user.id,now);if(memberSeries){const position=db.prepare('SELECT COALESCE(MAX(position),0)+1 position FROM series_items WHERE series_id=?').get(memberSeries).position;db.prepare("INSERT INTO series_items VALUES(?,?,?,'')").run(memberSeries,id,position);}}
    db.prepare("INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at,target_series_id,series_requested) VALUES(?,?,?,'synthetic',?,'[]',8388608,?,?,?,?,1)").run(id,shelf,owner.user.id,title,state,now,now+86400000,targetSeries);
    return id;
  };
  return {app,db,dataDir,req,create,upload};
}

test('deleting the former upload destination preserves assets and job sources moved elsewhere',async t=>{
  const c=await deletionFixture(t),source=await c.create('Source'),destination=await c.create('Destination');
  const keep=[c.upload('Moved processing',source.id,{memberSeries:destination.id}),c.upload('Moved complete',source.id,{memberSeries:destination.id,state:'complete'}),c.upload('Detached processing',source.id,{memberSeries:null})];
  const movedIn=c.upload('Moved into deleted series',destination.id,{memberSeries:source.id}),pending=c.upload('Unpublished transfer',source.id,{published:false,state:'uploading'});
  for(const id of keep){await mkdir(join(c.dataDir,'uploads','staging',id),{recursive:true});await writeFile(join(c.dataDir,'uploads','staging',id,'source'),'preserve synthetic job source');}
  const preview=(await c.req('GET','/series/'+source.id+'/delete-preview')).json();assert.equal(preview.assetCount,1);assert.equal(preview.pendingCount,2);
  const current=(await c.req('GET','/series/'+source.id)).json().series;
  const deleted=await c.req('DELETE','/series/'+source.id,{revision:current.revision,deleteContents:true,previewHash:preview.previewHash});assert.equal(deleted.statusCode,204,deleted.body);
  for(const id of keep){assert(c.db.prepare('SELECT 1 FROM items WHERE id=?').get(id));assert.notEqual(c.db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(id)?.state,'cancelled');assert(c.db.prepare('SELECT 1 FROM upload_sessions WHERE id=?').get(id),'historical upload remains');assert.equal(await readFile(join(c.dataDir,'uploads','staging',id,'source'),'utf8'),'preserve synthetic job source');}
  for(const id of [movedIn,pending]){assert.equal(c.db.prepare('SELECT 1 FROM items WHERE id=?').get(id),undefined);assert.equal(c.db.prepare('SELECT 1 FROM upload_sessions WHERE id=?').get(id),undefined);}
  assert(c.db.prepare('SELECT 1 FROM series WHERE id=?').get(destination.id));assert.deepEqual(c.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('shallow bulk deletion rejects a changed preview and preserves newly added contents',async t=>{
  const c=await deletionFixture(t),parent=await c.create('Parent'),before=(await c.req('POST','/series/bulk/preview',{ids:[parent.id]})).json();
  const child=await c.create('Child',parent.id),asset=c.upload('Added after preview',parent.id,{state:'complete'});
  const stale=await c.req('POST','/series/bulk',{ids:[parent.id],action:'delete',deleteContents:false,previewHash:before.previewHash});assert.equal(stale.statusCode,409,stale.body);
  assert(c.db.prepare('SELECT 1 FROM series WHERE id=?').get(parent.id));assert.equal(c.db.prepare('SELECT parent_id FROM series WHERE id=?').get(child.id).parent_id,parent.id);assert.equal(c.db.prepare('SELECT series_id FROM series_items WHERE asset_id=?').get(asset).series_id,parent.id);
  const fresh=(await c.req('POST','/series/bulk/preview',{ids:[parent.id]})).json(),deleted=await c.req('POST','/series/bulk',{ids:[parent.id],action:'delete',deleteContents:false,previewHash:fresh.previewHash});assert.equal(deleted.statusCode,200,deleted.body);
  assert.equal(c.db.prepare('SELECT parent_id FROM series WHERE id=?').get(child.id).parent_id,null);assert(c.db.prepare('SELECT 1 FROM items WHERE id=?').get(asset));assert(c.db.prepare('SELECT 1 FROM upload_sessions WHERE id=?').get(asset));assert.deepEqual(c.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
