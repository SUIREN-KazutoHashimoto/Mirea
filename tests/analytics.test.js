import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { createViewRecorder } from '../web/src/analytics-core.js';

async function setup(t) {
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-analytics-'));
  const admins=[], options={dataDir,rateLimit:false,serverAdminUserIds:admins};
  const ctx={app:await createApp(options),options};
  const db=new DatabaseSync(join(dataDir,'mirea.sqlite'));ctx.db=db;
  t.after(async()=>{db.close();await ctx.app.close();await rm(dataDir,{recursive:true,force:true});});
  ctx.req=(method,path,user,payload)=>ctx.app.inject({method,url:`/api/v1${path}`,headers:user?{authorization:`Bearer ${user.token}`}:{},...(payload?{payload}:{})});
  ctx.register=async name=>{const r=await ctx.req('POST','/auth/register',null,{name,email:`${name}@example.test`,password:'analytics-test-password'});assert.equal(r.statusCode,201,r.body);return r.json();};
  ctx.owner=await ctx.register('owner');admins.push(ctx.owner.user.id);
  ctx.viewer=await ctx.register('viewer');ctx.other=await ctx.register('other');
  ctx.shelf=(await ctx.req('POST','/shelves',ctx.owner,{name:'Analytics'})).json().id;
  ctx.member=async user=>ctx.req('POST',`/shelves/${ctx.shelf}/members`,ctx.owner,{email:user.user.email,role:'viewer'});
  await ctx.member(ctx.viewer);
  ctx.asset=mime=>{const id=randomUUID();db.prepare(`INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count,thumbnail_ready) VALUES(?,?,?,?,?,1,?,?,3,0)`).run(id,ctx.shelf,'Fixture','fixture',mime,ctx.owner.user.id,Date.now());return id;};
  ctx.video=ctx.asset('video/mp4');ctx.pdf=ctx.asset('application/pdf');ctx.images=ctx.asset('application/vnd.mirea.image-book');
  ctx.view=(assetId=ctx.video,context='viewer')=>({id:randomUUID(),assetId,context,platform:'web',clientVersion:'test'});
  ctx.event=(seq,type,data={})=>({id:randomUUID(),seq,type,at:Date.now()-86400000,elapsedMs:seq*1000,...data});
  ctx.send=(view,events,user=ctx.viewer)=>ctx.req('POST','/analytics/events',user,{view,events});
  ctx.start=(seq=1,data={})=>ctx.event(seq,'view_start',{visible:true,focused:true,playing:true,...data});
  ctx.interval=(seq=2,data={})=>ctx.event(seq,'interval',{intervalMs:1000,visibleMs:1000,activeMs:1000,watchMs:1000,fromMs:9500,toMs:10500,visible:true,focused:true,idle:false,playing:true,rate:1,...data});
  return ctx;
}

test('analytics counts actual viewer/preview sessions separately, bins replay and deduplicates retries atomically',async t=>{
  const c=await setup(t),view=c.view(), events=[c.event(1,'open'),c.start(2),c.interval(3)];
  assert.equal((await c.send(view,events)).statusCode,200);
  assert.deepEqual((await c.send(view,events)).json(),{accepted:0,duplicates:3,schemaVersion:1});
  let data=(await c.req('GET','/analytics/me/summary',c.viewer)).json();
  assert.equal(data.assets[0].viewCount,1);assert.equal(data.assets[0].watchMs,1000);
  assert.deepEqual(data.videoBins.map(row=>[row.startMs,row.watchMs]),[[0,500],[10000,500]]);
  const conflict={...events[2],watchMs:900};
  assert.equal((await c.send(view,[c.event(4,'pause'),conflict])).statusCode,409);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM analytics_events').get().n,3,'conflicting batch rolls back');
  assert.equal((await c.send(view,[c.interval(4,{elapsedMs:3500})])).statusCode,422,'overlapping interval rejected');
  assert.equal((await c.send(view,[c.interval(5,{elapsedMs:5000,fromMs:0,toMs:1000})])).statusCode,200,'disjoint out-of-order intervals allowed');
  const preview=c.view(c.video,'preview');await c.send(preview,[c.start(),c.interval()]);
  data=(await c.req('GET','/analytics/me/summary',c.viewer)).json();
  assert.deepEqual(new Set(data.assets.map(row=>row.context)),new Set(['viewer','preview']));
  assert.ok(data.assets.every(row=>row.viewCount===1));
  assert.equal((await c.send(view,[c.start(8)],c.owner)).statusCode,409,'cannot claim another actor view');
  assert.equal((await c.send(c.view(),[c.start()],c.other)).statusCode,404);
  assert.equal((await c.send(c.view(),[c.start()],null)).statusCode,401);
});

test('books store page dwell and viewport, reject invalid watch/seek/background credit and preserve personal history indefinitely',async t=>{
  const c=await setup(t);
  for(const asset of [c.pdf,c.images]){
    const view=c.view(asset);
    const events=[c.start(1,{page:2}),c.event(2,'page_enter',{page:2}),c.event(3,'interval',{page:2,intervalMs:1000,visibleMs:1000,activeMs:800,visible:true,focused:true,idle:false,x:0,y:0.5,width:1,height:0.5,visibleRatio:0.5,zoom:1.5})];
    assert.equal((await c.send(view,events)).statusCode,200);
    assert.equal((await c.send(view,[c.event(4,'page_enter',{page:4})])).statusCode,422);
    assert.equal((await c.send(view,[c.interval(4)])).statusCode,422);
  }
  const invalid=[{seeking:true},{buffering:true},{playing:false},{visible:false},{focused:false},{idle:true},{fromMs:0,toMs:1000000},{activeMs:500},{elapsedMs:500}];
  for(const change of invalid)assert.equal((await c.send(c.view(),[c.interval(2,change)])).statusCode,422,JSON.stringify(change));
  assert.equal((await c.send(c.view(c.pdf,'preview'),[c.start(1,{page:1})])).statusCode,422);
  const raw=(await c.req('GET','/analytics/me/events?limit=2',c.viewer)).json();
  assert.equal(raw.events.length,2);assert.equal(raw.hasMore,true);
  const next=await c.req('GET',`/analytics/me/events?after=${raw.nextCursor}&format=ndjson`,c.viewer);
  assert.match(next.headers['content-type'],/^application\/x-ndjson/);assert.equal(next.body.trim().split('\n').length,4);
  assert.ok(!next.body.includes(c.viewer.token));
  c.db.prepare('UPDATE analytics_views SET opened_at=1').run();
  c.db.prepare('DELETE FROM items WHERE id IN (?,?)').run(c.pdf,c.images);
  await c.req('DELETE',`/shelves/${c.shelf}/members/${c.viewer.user.id}`,c.owner);
  await c.app.close();c.app=await createApp(c.options);
  const summary=(await c.req('GET','/analytics/me/summary',c.viewer)).json();
  assert.equal(summary.pages.length,2);assert.equal(summary.assets.length,2);
  assert.ok(summary.pages.every(row=>row.activeMs===800 && row.visibleMs===1000));
  assert.equal((await c.req('GET','/analytics/me/events',c.viewer)).json().events.length,6,'no expiration or asset-deletion cascade');
});

test('only self receives personal logs; owners/global admins get delayed thresholded coarsened anonymous aggregates',async t=>{
  const c=await setup(t);
  for(let i=0;i<5;i++){
    const user=i===0?c.viewer:await c.register(`reader${i}`);if(i)await c.member(user);
    const video=c.view(),book=c.view(c.pdf);
    const response=await c.send(video,[c.start(),c.interval(2,{fromMs:0,toMs:1000})],user);assert.equal(response.statusCode,200,response.body);
    await c.send(book,[c.start(1,{page:1}),c.event(2,'page_enter',{page:1}),c.event(3,'interval',{page:1,intervalMs:1000,visibleMs:1000,activeMs:1000,visible:true,focused:true})],user);
    const summary=(await c.req('GET',`/shelves/${c.shelf}/analytics/summary?period=all`,c.owner)).json();
    assert.equal(summary.assets.length,i===4?2:0);
  }
  assert.equal((await c.req('GET','/analytics/me/events',c.owner)).json().events.length,0,'server/shelf owner has no personal reader logs');
  assert.equal((await c.req('GET',`/analytics/me/events?userId=${c.viewer.user.id}`,c.other)).json().events.length,0,'query cannot change authenticated actor');
  assert.equal((await c.req('GET',`/shelves/${c.shelf}/analytics/events`,c.owner)).statusCode,404,'no owner raw endpoint');
  assert.equal((await c.req('GET','/analytics/global/events',c.owner)).statusCode,404);
  for(const user of [c.viewer,c.other])assert.ok([403,404].includes((await c.req('GET',`/shelves/${c.shelf}/analytics/summary`,user)).statusCode));
  assert.equal((await c.req('GET','/analytics/global/summary',c.viewer)).statusCode,403);
  assert.equal((await c.req('GET',`/shelves/${c.shelf}/analytics/summary?userId=${c.viewer.user.id}`,c.owner)).statusCode,400);
  assert.equal((await c.req('GET',`/shelves/${c.shelf}/analytics/summary?from=1`,c.owner)).statusCode,400);
  assert.equal((await c.req('GET',`/analytics/global/summary?assetId=${c.video}`,c.owner)).statusCode,400);
  const summary=(await c.req('GET',`/shelves/${c.shelf}/analytics/summary?period=all`,c.owner)).json();
  assert.equal(summary.assets[0].uniqueViewers,5);assert.equal(summary.assets[0].watchMs%10000,0);
  assert.equal(summary.pages[0].visits,5);assert.equal(summary.videoBins.length,1);
  const exported=await c.req('GET','/analytics/global/export?period=all',c.owner);
  for(const forbidden of [c.viewer.user.id,c.viewer.user.email,c.video,c.shelf,'viewId','receivedAt','event_id'])assert.ok(!exported.body.includes(forbidden),forbidden);
  assert.equal((await c.req('GET','/analytics/access',c.owner)).json().canViewGlobal,true);
  assert.equal((await c.req('GET','/analytics/access',c.viewer)).json().canViewGlobal,false);
  c.db.prepare('UPDATE analytics_views SET opened_at=?').run(Date.now());
  assert.equal((await c.req('GET',`/shelves/${c.shelf}/analytics/summary?period=all`,c.owner)).json().assets.length,0,'today excluded');
});

test('disabled collection refuses ingest but keeps self history API available',async t=>{
  const c=await setup(t);await c.app.close();c.app=await createApp({...c.options,analyticsEnabled:false});
  assert.equal((await c.send(c.view(),[c.start()])).statusCode,403);
  assert.equal((await c.req('GET','/config')).json().analytics.retentionDays,0);
  assert.equal((await c.req('GET','/analytics/me/events',c.viewer)).statusCode,200);
});

test('viewer replay graph enforces current ACL, per-bin anonymity, coarsening, fixed delay and bounded data without identities',async t=>{
  const c=await setup(t),path=`/items/${c.video}/replay-heatmap`,yesterday=Date.now()-86400000;
  c.db.prepare('INSERT INTO video_assets VALUES(?,?,1)').run(c.video,JSON.stringify({duration:60}));
  assert.equal((await c.req('GET',path)).statusCode,401);
  assert.equal((await c.req('GET',path,c.other)).statusCode,404);
  assert.equal((await c.req('GET',`/items/${c.pdf}/replay-heatmap`,c.viewer)).statusCode,404);
  assert.equal((await c.req('GET',path+'?userId=other',c.viewer)).statusCode,400);
  const viewers=[];
  for(let n=0;n<5;n++){
    const user=n?await c.register('heat'+n):c.viewer;viewers.push(user);if(n)await c.member(user);
    const view=c.view();assert.equal((await c.send(view,[c.start(),c.interval(2,{fromMs:0,toMs:1000})],user)).statusCode,200);
    c.db.prepare('UPDATE analytics_video_bins SET media_ms=10000,watch_ms=5000 WHERE view_id=?').run(view.id);
    c.db.prepare('UPDATE analytics_views SET last_received_at=? WHERE id=?').run(yesterday,view.id);
    if(n===0)c.db.prepare('INSERT INTO analytics_video_bins VALUES(?,20000,1000000,1000000)').run(view.id);
    const response=await c.req('GET',path,c.viewer);assert.equal(response.json().available,true);assert.equal(response.json().scope,n===4?'anonymous':'self');
    if(n<4)assert.equal((await c.req('GET',path,c.owner)).json().available,false,'owner does not inherit another viewer’s personal fallback');
    assert.equal(response.headers['cache-control'],'no-store');
  }
  let response=await c.req('GET',path,c.viewer),data=response.json();assert.equal(data.scope,'anonymous');assert.equal(data.binSizeMs,10000);assert.deepEqual(data.points,[1,null,null,null,null,null]);
  for(const forbidden of [...viewers.map(v=>v.user.id),'userId','watchMs','mediaMs','uniqueViewers','viewId','email'])assert.ok(!response.body.includes(forbidden),forbidden);
  c.db.prepare('UPDATE analytics_views SET last_received_at=? WHERE user_id=?').run(Date.now(),c.viewer.user.id);
  assert.equal((await c.req('GET',path,c.viewer)).json().scope,'self','today excluded from anonymous, including old sessions still receiving events');
  const newcomer=await c.register('newcomer');await c.member(newcomer);assert.equal((await c.req('GET',path,newcomer)).json().available,false,'no personal fallback can reveal anybody else’s history');
  c.db.prepare('UPDATE analytics_views SET last_received_at=?').run(yesterday);
  c.db.prepare('UPDATE video_assets SET metadata_json=?').run(JSON.stringify({duration:86400}));
  assert.ok((await c.req('GET',path,c.viewer)).json().points.length<=200);
  await c.req('DELETE',`/shelves/${c.shelf}/members/${c.viewer.user.id}`,c.owner);
  assert.equal((await c.req('GET',path,c.viewer)).statusCode,404,'historical viewer loses graph access too');
});

test('actual recorder batches with fractional clock, seek, page changes and lifecycle pass server validation',async t=>{
  const c=await setup(t);
  for(const asset of [c.video,c.images]){
    const view=c.view(asset),events=[];let time=0.3;
    const state=asset===c.video?{visible:true,focused:true,idle:false,playing:true,buffering:false,seeking:false,toMs:0,rate:1}:{visible:true,focused:true,idle:false,page:1};
    const recorder=createViewRecorder({view,emit:(_,e)=>events.push(e),snapshot:()=>({...state}),clock:()=>time,wallClock:()=>Date.now(),uuid:randomUUID});
    for(let i=0;i<20;i++){time+=1000.6;if(asset===c.video)state.toMs+=1000.6;recorder.sample();}
    if(asset===c.video){
      recorder.change('seeking',()=>{state.seeking=true;state.toMs=60000;});recorder.change('seeked',()=>{state.seeking=false;});
    }else{
      recorder.change('page_loading',()=>{state.visible=false;delete state.page;});recorder.change('page_enter',()=>{state.visible=true;state.page=2;});
    }
    time+=1000.7;if(asset===c.video)state.toMs+=1000.7;recorder.sample();
    recorder.change('visibility',()=>{state.visible=false;});time+=500.6;recorder.close();
    for(let i=0;i<events.length;i+=10){const r=await c.send(view,JSON.parse(JSON.stringify(events.slice(i,i+10))));assert.equal(r.statusCode,200,r.body);}
  }
});
