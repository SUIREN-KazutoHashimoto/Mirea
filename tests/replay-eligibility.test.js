import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openDatabase,transaction} from '../server/database.js';
import {replayEvent,projectReplayView} from '../server/replay-eligibility.js';
const fresh=()=>({seq:0,row:0,elapsed:0,end:null,to:null,watch:0,pending:{}});
const interval=(seq,elapsed,from,watch=1000,rate=1)=>({seq,type:'interval',elapsedMs:elapsed,intervalMs:watch,watchMs:watch,fromMs:from,toMs:from+watch*rate,rate,playing:true,seeking:false,buffering:false});
test('search jumps never combine short visits; exactly three seconds credits the entire qualifying run',()=>{
 const state=fresh(),bins=new Map(),add=(b,n)=>bins.set(b,(bins.get(b)??0)+n),send=e=>replayEvent(state,e,add);
 send(interval(1,1000,0));send(interval(2,2000,20000));send(interval(3,3000,40000));assert.equal(bins.size,0);
 send(interval(4,4000,41000));assert.equal(bins.size,0);send(interval(5,5000,42000));assert.deepEqual([...bins],[[40000,3000]]);
 send(interval(6,6000,43000));assert.equal(bins.get(40000),4000);
});
test('threshold is real playback time at every speed and pending coverage spans bin boundaries',()=>{
 const state=fresh(),bins=new Map(),add=(b,n)=>bins.set(b,(bins.get(b)??0)+n);
 replayEvent(state,interval(1,1000,9500,1000,2),add);replayEvent(state,interval(2,2000,11500,1000,2),add);replayEvent(state,interval(3,2999,13500,999,2),add);assert.equal(bins.size,0);
 replayEvent(state,interval(4,3000,15498,1,2),add);assert.deepEqual([...bins],[[0,500],[10000,5500]]);
});
test('pause, buffering, seek, loop, close, gaps and sequence holes interrupt provisional playback',()=>{
 for(const boundary of ['pause','buffering','seeking','seeked','loop','ended','close','error','gap','sequence','clock']){
  const state=fresh(),bins=new Map(),add=(b,n)=>bins.set(b,(bins.get(b)??0)+n);
  replayEvent(state,interval(1,1000,0),add);replayEvent(state,interval(2,2000,1000),add);
  if(boundary==='sequence')replayEvent(state,interval(4,3000,2000),add);
  else if(boundary==='clock')replayEvent(state,interval(3,4500,2000),add);
  else if(boundary==='gap')replayEvent(state,{...interval(3,3000,2000),gapMs:1000},add);
  else {replayEvent(state,{seq:3,type:boundary,elapsedMs:2000,playing:boundary!=='pause',toMs:2000},add);replayEvent(state,interval(4,3000,2000),add);}
  assert.equal(bins.size,0,boundary);
 }
 const state=fresh(),bins=[];replayEvent(state,{...interval(1,1000,0),watchMs:0},(...x)=>bins.push(x));assert.equal(state.watch,0);
});
async function fixture(t){const folder=await mkdtemp(join(tmpdir(),'mirea-replay-qualification-')),path=join(folder,'db.sqlite');let db=openDatabase(path);t.after(async()=>{db.close();await rm(folder,{recursive:true,force:true});});const view='view';db.prepare("INSERT INTO analytics_views(id,user_id,asset_id,shelf_id,asset_kind,asset_title,page_count,context,platform,client_version,auth_session_id,opened_at,first_received_at,last_received_at,counted) VALUES(?,'u','asset','s','video','Title',1,'viewer','android','test','session',1,1,1,1)").run(view);
 const insert=event=>db.prepare('INSERT INTO analytics_events(event_id,view_id,seq,event_type,client_at,received_at,elapsed_ms,interval_ms,visible_ms,active_ms,watch_ms,from_ms,to_ms,payload_json,payload_hash) VALUES(?,?,?,?,1,1,?,?,0,0,?,?,?,?,?)').run('e'+event.seq,view,event.seq,event.type,event.elapsedMs,event.intervalMs??0,event.watchMs??0,event.fromMs??null,event.toMs??null,JSON.stringify(event),'hash'+event.seq);
 return {get db(){return db;},view,insert,reopen(){db.close();db=openDatabase(path);},project:limit=>transaction(db,()=>projectReplayView(db,view,{limit})),total:()=>db.prepare('SELECT SUM(media_ms) n FROM analytics_replay_bins').get().n??0};}
test('pending playback survives restart, late events rebuild in bounded batches and retry is idempotent without changing raw rows',async t=>{
 const c=await fixture(t);c.insert(interval(1,1000,0));c.insert(interval(2,2000,1000));c.project();assert.equal(c.total(),0);c.reopen();c.insert(interval(4,4000,3000));c.insert(interval(5,5000,4000));c.project();assert.equal(c.total(),0,'missing event breaks continuity');
 c.insert(interval(3,3000,2000));const raw=c.db.prepare('SELECT * FROM analytics_events ORDER BY row_id').all(),view=c.db.prepare('SELECT * FROM analytics_views').all();let loops=0;while(c.project(2)){assert(++loops<10);}assert.equal(c.total(),5000);c.project();c.reopen();c.project();assert.equal(c.total(),5000);assert.deepEqual(c.db.prepare('SELECT * FROM analytics_events ORDER BY row_id').all(),raw);assert.deepEqual(c.db.prepare('SELECT * FROM analytics_views').all(),view);
 c.db.prepare('DELETE FROM analytics_views WHERE id=?').run(c.view);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM analytics_replay_bins').get().n,0);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM analytics_replay_state').get().n,0);
});
test('v14 additive migration preserves original bins and raw history, then derives old data rather than trusting old noisy bins',async t=>{
 const c=await fixture(t);c.insert(interval(1,1000,0));c.insert(interval(2,2000,30000));c.db.exec("INSERT INTO analytics_video_bins VALUES('view',0,1000,1000),('view',30000,1000,1000);DROP TABLE analytics_replay_state;DROP TABLE analytics_replay_bins;UPDATE schema_version SET version=14;");
 const names=c.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_version') ORDER BY name").all().map(r=>r.name),before=names.map(n=>c.db.prepare(`SELECT * FROM ${n}`).all());c.reopen();for(let n=0;n<names.length;n++)assert.deepEqual(c.db.prepare(`SELECT * FROM ${names[n]}`).all(),before[n],names[n]);assert.equal(c.db.prepare('SELECT version FROM schema_version').get().version,23);c.project();assert.equal(c.total(),0,'two isolated one-second searches must not inherit old graph weights');assert.equal(c.db.prepare('SELECT SUM(media_ms) n FROM analytics_video_bins').get().n,2000);
});
