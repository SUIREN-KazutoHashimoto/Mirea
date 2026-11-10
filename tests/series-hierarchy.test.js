import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import {openDatabase} from '../server/database.js';
import {makePdf,makeMp4} from './fixtures.js';
import {createHash} from 'node:crypto';
import {assertUploadName,MAX_SERIES_ASSETS} from '../server/name-integrity.js';
import {attachUploadSeries} from '../server/upload-series.js';

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
  c.save=(series,items,user=c.owner,extra={})=>c.req('PUT',`/series/${series.id}`,user,{revision:series.revision,title:series.title,description:series.description,items:items.map(assetId=>({assetId,label:''})),...extra});
  return c;
}


test('nested series preserve mixed-media membership while enforcing same-shelf, cycles, depth, revision and safe parent deletion',async t=>{
 const c=await setup(t),root=await c.create('Parent'),child=await c.create('Child'),other=await c.create('Sibling');
 const saved=await c.save(root,[c.pdf],c.owner,{children:[child.id,other.id]});assert.equal(saved.statusCode,200,saved.body);
 assert.deepEqual(new Set(saved.json().children.map(s=>s.id)),new Set([child.id,other.id]));
 const current=()=>c.read(root.id).then(r=>r.json().series),freshChild=(await c.read(child.id)).json().series;
 assert.equal(freshChild.parentId,root.id);assert.equal((await c.save(freshChild,[c.images,c.video])).statusCode,200);
 const summary=(await c.req('GET',`/shelves/${c.shelf}/series`)).json().series.find(s=>s.id===root.id);
 assert.equal(summary.assetCount,3);assert.equal(summary.directAssetCount,1);assert.equal(summary.childCount,2);
 for(const extra of [{parentId:child.id},{children:[root.id]},{children:[child.id,child.id]}]){const r=await c.save(await current(),[c.pdf],c.owner,extra);assert.ok([400,422].includes(r.statusCode),r.body);}
 assert.equal((await c.save(root,[])).statusCode,409);
 const foreign=(await c.req('POST',`/shelves/${c.otherShelf}/series`,c.other,{title:'Private'})).json().series;
 for(const extra of [{parentId:foreign.id},{children:[foreign.id]}])assert.equal((await c.save(await current(),[c.pdf],c.owner,extra)).statusCode,422);
 assert.throws(()=>c.db.prepare('UPDATE series SET parent_id=? WHERE id=?').run(child.id,root.id),/cycle/);
 assert.throws(()=>c.db.prepare('UPDATE series SET parent_id=? WHERE id=?').run(foreign.id,root.id),/Invalid series parent/);
 const post={title:'Created once',parentId:child.id,requestId:randomUUID()},once=await c.req('POST',`/shelves/${c.shelf}/series`,c.editor,post),twice=await c.req('POST',`/shelves/${c.shelf}/series`,c.editor,post);
 assert.equal(once.statusCode,201,once.body);assert.equal(twice.json().series.id,once.json().series.id);
 let parent=once.json().series.id;
 for(let depth=4;depth<=16;depth++){const r=await c.req('POST',`/shelves/${c.shelf}/series`,c.owner,{title:'Depth '+depth,parentId:parent});assert.equal(r.statusCode,201,r.body);parent=r.json().series.id;}
 assert.equal((await c.req('POST',`/shelves/${c.shelf}/series`,c.owner,{title:'Too deep',parentId:parent})).statusCode,422);
 assert.equal((await c.req('DELETE',`/series/${root.id}`,c.owner,{revision:(await current()).revision})).statusCode,204);
 assert.equal((await c.read(child.id)).json().series.parentId,null);assert.equal((await c.read(other.id)).json().series.parentId,null);
 assert.equal((await c.read(child.id)).json().items.length,2);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM items').get().n,3);
 assert.equal(c.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('durable series upload assignment publishes atomically and preserves valid media if destination is deleted',async t=>{
 const c=await setup(t),series=await c.create('Uploads');
 async function begin(seriesId,title='PDF'){const bytes=makePdf(),r=await c.req('POST',`/shelves/${c.shelf}/uploads`,c.owner,{title,seriesId,files:[{filename:'a.pdf',mime:'application/pdf',size:bytes.length}]});assert.equal(r.statusCode,201,r.body);return {bytes,id:r.json().id};}
 async function complete({id,bytes}){
  const part=await c.app.inject({method:'PUT',url:`/api/v1/uploads/${id}/files/0/parts/0`,headers:{authorization:'Bearer '+c.owner.token,'content-type':'application/octet-stream','x-chunk-sha256':createHash('sha256').update(bytes).digest('hex')},payload:bytes});assert.equal(part.statusCode,204,part.body);
  assert.equal((await c.req('POST',`/uploads/${id}/complete`)).statusCode,202);
  for(let n=0;n<150;n++){const r=(await c.req('GET',`/uploads/${id}`)).json();if(r.state!=='processing'){assert.equal(r.state,'complete',r.error);return r;}await new Promise(r=>setTimeout(r,30));}throw Error('Upload timeout');
 }
 const job=await begin(series.id);const pending=(await c.req('GET',`/shelves/${c.shelf}/items`)).json().pendingUploads.find(i=>i.id===job.id);assert.equal(pending.series.id,series.id);
 const published=await complete(job);assert.equal(published.seriesId,series.id);assert.equal(published.seriesWarning,'');assert.deepEqual((await c.read(series.id)).json().items.map(i=>i.id),[job.id]);
 const removed=await begin(series.id,'Survives deletion');await c.req('DELETE',`/series/${series.id}`,c.owner,{revision:(await c.read(series.id)).json().series.revision});
 const independent=await complete(removed);assert.match(independent.seriesWarning,/単独/);assert.equal(independent.item.id,removed.id);assert.equal((await c.req('GET',`/items/${removed.id}/series`)).json().series,null);
 const foreign=(await c.req('POST',`/shelves/${c.otherShelf}/series`,c.other,{title:'Hidden'})).json().series.id;
 const denied=await c.req('POST',`/shelves/${c.shelf}/uploads`,c.owner,{title:'No leak',seriesId:foreign,files:[{filename:'a.pdf',mime:'application/pdf',size:100}]});assert.equal(denied.statusCode,422);assert(!denied.body.includes('Hidden'));
 const {readFile}=await import('node:fs/promises');for(const file of ['upload-publish','video-publish','audio-publish'])assert((await readFile(new URL('../server/'+file+'.js',import.meta.url),'utf8')).includes('attachUploadSeries(db,upload)'));
});

test('series above a single upload batch keep their destination and remain editable with non-ASCII labels',async t=>{
 const c=await setup(t),series=await c.create('Large series'),ids=[];
 c.db.exec('BEGIN');try{for(let n=0;n<1500;n++)ids.push(c.asset('application/pdf','Book '+String(n).padStart(4,'0')));c.db.exec('COMMIT');}catch(error){c.db.exec('ROLLBACK');throw error;}
 const body={revision:series.revision,title:series.title,description:'',items:ids.map(assetId=>({assetId,label:'巻'.repeat(80)}))};
 assert(Buffer.byteLength(JSON.stringify(body))>256*1024);
 const saved=await c.req('PUT','/series/'+series.id,c.owner,body);assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().items.length,1500);
 const bytes=makePdf(),begun=await c.req('POST',`/shelves/${c.shelf}/uploads`,c.owner,{title:'New book',seriesId:series.id,files:[{filename:'book.pdf',mime:'application/pdf',size:bytes.length}]});assert.equal(begun.statusCode,201,begun.body);const upload=begun.json();
 assert.equal((await c.req('GET','/uploads/'+upload.id)).json().seriesId,series.id);
 const part=await c.app.inject({method:'PUT',url:`/api/v1/uploads/${upload.id}/files/0/parts/0`,headers:{authorization:'Bearer '+c.owner.token,'content-type':'application/octet-stream','x-chunk-sha256':createHash('sha256').update(bytes).digest('hex')},payload:bytes});assert.equal(part.statusCode,204,part.body);
 assert.equal((await c.req('POST','/uploads/'+upload.id+'/complete')).statusCode,202);
 let result;for(let n=0;n<300;n++){result=(await c.req('GET','/uploads/'+upload.id)).json();if(result.state!=='processing')break;await new Promise(r=>setTimeout(r,30));}
 assert.equal(result.state,'complete',result.error);assert.equal(result.seriesWarning,'');assert.equal(c.db.prepare('SELECT series_id FROM series_items WHERE asset_id=?').get(upload.id).series_id,series.id);
 assert.equal((await c.req('GET','/shelves/'+c.shelf+'/items')).json().items.find(item=>item.id===upload.id).series.id,series.id);
});

test('a full series rejects admission and publication instead of spilling a new asset into its shelf',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`CREATE TABLE series(id TEXT,shelf_id TEXT);CREATE TABLE series_items(series_id TEXT,asset_id TEXT,position INTEGER);CREATE TABLE upload_sessions(id TEXT,target_series_id TEXT,series_requested INTEGER,state TEXT,expires_at INTEGER);CREATE TABLE items(id TEXT);INSERT INTO series VALUES('series','shelf');WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${MAX_SERIES_ASSETS}) INSERT INTO series_items SELECT 'series','asset-'||x,x FROM n;INSERT INTO upload_sessions VALUES('new','series',1,'uploading',9999999999999);`);
  const upload={id:'new',shelf_id:'shelf',title:'New book'};
  assert.throws(()=>assertUploadName(db,upload),error=>error.statusCode===409&&error.message.includes('100,000'));
  assert.throws(()=>attachUploadSeries(db,upload),error=>error.statusCode===409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM series_items').get().n,MAX_SERIES_ASSETS);assert.equal(db.prepare("SELECT COUNT(*) n FROM series_items WHERE asset_id='new'").get().n,0);
 }finally{db.close();}
});

test('upload preview is editor-only, unlocks private shelves, and never creates a series or transfer',async t=>{
 const c=await setup(t),series=await c.create('Existing');assert.equal((await c.save(series,[c.pdf])).statusCode,200);
 const body={assets:[{key:'existing',title:'Volume 10',shelfId:c.shelf,folderPath:'Existing'},{key:'new',title:'New asset',shelfId:c.shelf,newSeriesTitle:'Proposed/Parent',folderPath:'Child'}]},preview=actor=>c.req('POST','/transfers/upload-preview',actor,body);
 assert.equal((await c.req('GET','/config',null)).json().uploadPreview,true);assert.equal((await preview(null)).statusCode,401);assert.equal((await preview(c.viewer)).statusCode,403);assert.equal((await preview(c.other)).statusCode,404);
 const sizes=()=>['items','series','upload_sessions','upload_queue'].map(table=>c.db.prepare('SELECT COUNT(*) n FROM '+table).get().n),before=sizes(),response=await preview(c.editor);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().assets[0].reason,'asset');assert.equal(response.json().assets[1].conflict,false);assert.deepEqual(sizes(),before);
 assert.equal((await c.req('POST','/transfers/upload-preview',c.editor,{assets:Array(1001).fill(body.assets[0])})).statusCode,400);
 c.db.prepare('UPDATE shelves SET private=1 WHERE id=?').run(c.shelf);assert.equal((await preview(c.owner)).statusCode,423);
 const grant=(await c.req('POST','/shelves/'+c.shelf+'/unlock',c.owner,{password:'series-test-password'})).json();
 const unlocked=await c.app.inject({method:'POST',url:'/api/v1/transfers/upload-preview',headers:{authorization:'Bearer '+c.owner.token,'x-mirea-shelf-unlock':grant.token},payload:body});assert.equal(unlocked.statusCode,200,unlocked.body);assert.deepEqual(sizes(),before);
});

test('real v15 additive migration preserves all prior columns and records and reopens idempotently',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'mirea-tree-migration-')),path=join(folder,'db.sqlite');let db=openDatabase(path);
 t.after(async()=>{db.close();await rm(folder,{recursive:true,force:true});});
 db.exec(`INSERT INTO users VALUES('u','keep@example.test','Keep','hash',1);INSERT INTO shelves(id,name,description,created_at) VALUES('s','Shelf','',1);INSERT INTO memberships VALUES('s','u','owner');INSERT INTO items VALUES('a','s','Keep','a.pdf','application/pdf',50,'u',1,1,1);INSERT INTO series(id,shelf_id,title,description,revision,created_at,updated_at) VALUES('old','s','Old','Keep description',9,1,1);INSERT INTO series_items VALUES('old','a',1,'Keep label');INSERT INTO encrypted_downloads VALUES('d','u','a','{"keyBinding":"unchanged"}',1);`);
 db.exec("DROP TRIGGER series_unique_path_insert;DROP TRIGGER series_unique_path_update;DROP TRIGGER series_parent_insert;DROP TRIGGER series_parent_update;DROP TRIGGER series_tree_shelf_update;DROP TRIGGER series_parent_changed;DROP INDEX series_parent;DROP TABLE series_create_requests;ALTER TABLE upload_sessions DROP COLUMN target_series_id;ALTER TABLE upload_sessions DROP COLUMN series_requested;ALTER TABLE upload_sessions DROP COLUMN series_warning;ALTER TABLE series DROP COLUMN parent_id;UPDATE schema_version SET version=15;");
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_version','sqlite_sequence') ORDER BY name").all().map(s=>s.name),before=new Map();
 for(const table of tables){const columns=db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);before.set(table,{columns,rows:db.prepare('SELECT '+columns.join(',')+' FROM '+table+' ORDER BY 1').all()});}
 db.close();db=openDatabase(path);assert.equal(db.prepare('SELECT version FROM schema_version').get().version,26);
 for(const [table,value]of before)assert.deepEqual(db.prepare('SELECT '+value.columns.join(',')+' FROM '+table+' ORDER BY 1').all(),value.rows,table);
 assert.equal(db.prepare("SELECT parent_id FROM series WHERE id='old'").get().parent_id,null);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 db.close();db=openDatabase(path);assert.equal(db.prepare("SELECT revision FROM series WHERE id='old'").get().revision,9);
});
