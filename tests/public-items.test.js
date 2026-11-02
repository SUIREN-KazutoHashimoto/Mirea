import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPublicItemSerializer} from '../server/public-items.js';
import {customThumbnailRevision} from '../server/custom-thumbnails.js';

test('batched public items preserve cover priority and processing states with bounded queries at ten thousand assets',t=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`CREATE TABLE thumbnail_overrides(asset_id TEXT,image_id TEXT,updated_at INTEGER);CREATE TABLE video_thumbnail_state(asset_id TEXT,updated_at INTEGER);CREATE TABLE admin_jobs(asset_id TEXT,kind TEXT,state TEXT,updated_at INTEGER);CREATE TABLE media_ingest(asset_id TEXT,canonical_ready INTEGER,source_mime TEXT,metadata_json TEXT);CREATE TABLE media_tasks(asset_id TEXT,kind TEXT,state TEXT);INSERT INTO thumbnail_overrides VALUES('a0','custom',1);INSERT INTO video_thumbnail_state VALUES('a0',999),('a1',100);INSERT INTO admin_jobs VALUES('a1','thumbnail','complete',200),('a2','repair','running',300),('private','thumbnail','complete',999);INSERT INTO media_ingest VALUES('a0',1,'video/quicktime','{"duration":10}'),('a1',0,'video/quicktime','{}'),('a2',0,'audio/wav','{}'),('a3',0,'audio/wav','{}'),('a4',0,'audio/wav','{}');INSERT INTO media_tasks VALUES('a1','transcode','queued'),('a1','thumbnail','complete'),('a2','transcode','failed'),('a3','transcode','failed');`);
  let queries=0;const tracked={prepare(sql){const statement=db.prepare(sql);return {all(...args){queries++;return statement.all(...args);}};}},serialize=createPublicItemSerializer(tracked,item=>({...item,mimeType:'video/mp4'}));
  const items=Array.from({length:10000},(_,n)=>({id:'a'+n,title:'Synthetic '+n})),start=performance.now(),output=serialize.batch(items),elapsed=performance.now()-start;
  assert.equal(output.length,10000);assert(queries<=10,'catalog metadata queries must be bounded independently of the number of items');assert.equal(output[0].thumbnailUrl,'/api/v1/items/a0/thumbnail?revision='+customThumbnailRevision({image_id:'custom',updated_at:1}));assert.equal(output[1].thumbnailUrl,'/api/v1/items/a1/thumbnail?revision='+customThumbnailRevision({image_id:'a1',updated_at:200}));
  assert.deepEqual(output.slice(0,5).map(row=>row.processingState),['ready','queued','running','failed','incomplete']);assert.equal(output[1].mimeType,'video/quicktime');assert.equal(output[0].downloadReady,true);assert.equal(output[1].downloadReady,false);assert.equal(output[1].processingTasks.length,2);assert(!JSON.stringify(output).includes('private'));
  const count=queries;assert.deepEqual(serialize(items[2]),output[2]);assert.equal(queries-count,count);assert.deepEqual(serialize.batch([]),[]);
  t.diagnostic(`10000 synthetic public items: ${elapsed.toFixed(1)} ms, ${count} metadata queries`);
 }finally{db.close();}
});
