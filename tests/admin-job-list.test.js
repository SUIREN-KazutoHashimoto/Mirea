import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {adminJobPage} from '../server/admin-job-list.js';

test('job paging searches every queue and old history while totals remain unfiltered',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`CREATE TABLE items(id TEXT,title TEXT,shelf_id TEXT);CREATE TABLE shelves(id TEXT,name TEXT);CREATE TABLE admin_jobs(id TEXT,asset_id TEXT,kind TEXT,state TEXT,created_at INTEGER,updated_at INTEGER);CREATE TABLE media_tasks(id TEXT,asset_id TEXT,kind TEXT,state TEXT,created_at INTEGER,updated_at INTEGER);CREATE TABLE upload_sessions(id TEXT,title TEXT,shelf_id TEXT,state TEXT,expires_at INTEGER,created_at INTEGER,processing_json TEXT);CREATE TABLE job_timings(id TEXT,scope TEXT,started_at INTEGER,finished_at INTEGER);CREATE TABLE media_ingest(asset_id TEXT);INSERT INTO shelves VALUES('s','Synthetic shelf');INSERT INTO items VALUES('a','Synthetic asset','s');`);
  const insert=db.prepare('INSERT INTO admin_jobs VALUES(?,?,?,?,?,?)');for(let n=0;n<245;n++)insert.run('a-'+String(n).padStart(3,'0'),'a','thumbnail','queued',n,n);
  const media=db.prepare('INSERT INTO media_tasks VALUES(?,?,?,?,?,?)');for(let n=0;n<120;n++)media.run('m-'+String(n).padStart(3,'0'),'a','transcode','failed',n,n);
  const upload=db.prepare('INSERT INTO upload_sessions VALUES(?,?,?,?,?,?,?)');upload.run('u-active','Receiving','s','uploading',99999,999,'{}');upload.run('u-queued','Waiting ingest','s','processing',99999,1000,'{"stage":"queued"}');upload.run('u-running','Processing book','s','processing',99999,1001,'{"stage":"assembling"}');upload.run('u-expired','Expired receive','s','uploading',1,1002,'{}');upload.run('u-pipeline','In pipeline','s','processing',99999,1003,'{}');db.exec("INSERT INTO media_ingest VALUES('u-pipeline')");
  const first=adminJobPage(db,{},10000);assert.equal(first.total,248);assert.deepEqual({...first.summary},{running:2,queued:246,failed:120});assert.equal(first.rows.length,100);assert.equal(first.nextOffset,100);
  const second=adminJobPage(db,{offset:first.nextOffset},10000),third=adminJobPage(db,{offset:second.nextOffset},10000);assert.equal(third.rows.length,48);assert.equal(third.nextOffset,null);assert.equal(third.previousOffset,100);assert.equal(new Set([...first.rows,...second.rows,...third.rows].map(r=>r.source+':'+r.id)).size,248);
  const old=adminJobPage(db,{view:'history',q:'m-000'},10000);assert.equal(old.total,1);assert.equal(old.rows[0].id,'m-000');assert.equal(old.summary.failed,120);
  assert.equal(adminJobPage(db,{q:'表紙'},10000).total,245);assert.equal(adminJobPage(db,{state:'queued',q:'Waiting ingest'},10000).rows[0].id,'u-queued');assert.equal(adminJobPage(db,{state:'running'},10000).total,2);
  assert.equal(adminJobPage(db,{q:"' OR 1=1 --"},10000).total,0);assert.equal(adminJobPage(db,{offset:99999},10000).offset,200);assert.equal(adminJobPage(db,{sort:'oldest'},10000).rows[0].id,'a-000');
 }finally{db.close();}
});
