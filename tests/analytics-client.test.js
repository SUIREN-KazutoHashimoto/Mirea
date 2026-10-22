import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewRecorder, pageViewport } from '../web/src/analytics-core.js';
import { createOutbox, memoryStore } from '../web/src/analytics-outbox.js';

function recorder(initial={}){
  let time=0,state={visible:true,focused:true,idle:false,playing:true,seeking:false,buffering:false,toMs:0,rate:1,...initial};const events=[];
  const r=createViewRecorder({view:{id:'view'},emit:(_,e)=>events.push(e),snapshot:()=>({...state}),clock:()=>time,wallClock:()=>1700000000000+time,uuid:()=>`e${events.length}`});
  return {r,events,tick:(ms,data={})=>{time+=ms;Object.assign(state,data);r.sample();},change:(type,update)=>r.change(type,()=>Object.assign(state,update))};
}
test('recorder counts once, measures actual video progression and excludes pause/seek/buffer/hidden time',()=>{
  const c=recorder();c.tick(1000,{toMs:1000});c.change('pause',{playing:false});c.tick(1000);
  c.change('seeking',{playing:true,seeking:true});c.tick(1000,{toMs:60000});c.change('seeked',{seeking:false});
  c.tick(1000,{toMs:61000});c.change('visibility',{visible:false});c.tick(1000,{toMs:62000});
  c.change('visibility',{visible:true});c.change('buffering',{buffering:true});c.tick(1000,{toMs:62000});
  c.r.close();c.r.close();
  assert.equal(c.events.filter(e=>e.type==='view_start').length,1);assert.equal(c.events.filter(e=>e.type==='close').length,1);
  assert.equal(c.events.reduce((sum,e)=>sum+(e.watchMs || 0),0),2000);
  assert.ok(c.events.every(e=>!e.watchMs || !e.seeking&&!e.buffering&&e.visible));
  assert.deepEqual(c.events.map(e=>e.seq),c.events.map((_,i)=>i+1));
});
test('recorder records speed, loop, unknown suspended gap, book pages and idle without invented time',()=>{
  const c=recorder({rate:2});c.tick(1000,{toMs:2000});assert.equal(c.events.at(-1).watchMs,1000);
  c.tick(1000,{toMs:0});assert.equal(c.events.at(-1).watchMs,0);assert.ok(c.events.some(e=>e.type==='loop'));
  c.tick(60000,{toMs:120000});assert.equal(c.events.at(-1).watchMs,0);assert.equal(c.events.at(-1).gapMs,58000);
  const b=recorder({playing:undefined,toMs:undefined,page:1});b.tick(1000);b.change('page_enter',{page:2});b.tick(1000);b.change('idle',{idle:true});b.tick(1000);
  const intervals=b.events.filter(e=>e.type==='interval');assert.deepEqual(intervals.map(e=>e.page),[1,2,2]);assert.equal(intervals.at(-1).activeMs,0);assert.equal(intervals.at(-1).visibleMs,1000);
  assert.deepEqual(pageViewport({left:0,top:-50,right:100,bottom:150,width:100,height:200},{left:0,top:0,right:100,bottom:100}),{x:0,y:0.25,width:1,height:0.5,visibleRatio:0.5});
});
test('fractional browser timer ticks never produce overlapping or negative intervals',()=>{
  let time=0.3;const events=[];
  const recorder=createViewRecorder({view:{id:'fractional'},emit:(_,event)=>events.push(event),snapshot:()=>({visible:true,focused:true,page:1}),clock:()=>time,wallClock:()=>1700000000000,uuid:()=>String(events.length)});
  for(let i=0;i<100;i++){time+=1000.6;recorder.sample();}
  let lastEnd=0;
  for(const event of events.filter(event=>event.type==='interval')){assert.ok(event.elapsedMs-event.intervalMs>=lastEnd,JSON.stringify(event));lastEnd=event.elapsedMs;}
});
test('outbox survives a lost acknowledgement, keeps exact IDs on retry and batches by view',async()=>{
  const store=memoryStore(),sent=[];let now=1000,fail=true;
  const box=createOutbox({store,partition:'user-A',now:()=>now,send:async body=>{sent.push(body);return {ok:!fail,status:fail?503:200};}});
  for(let i=0;i<45;i++)box.enqueue({id:'v1'},{id:`e${i}`,seq:i+1});box.enqueue({id:'v2'},{id:'other',seq:1});
  await box.flush();assert.equal((await store.list()).length,46);fail=false;now+=60000;await box.flush();
  assert.deepEqual(sent[0],sent[1]);assert.ok(sent.every(body=>body.events.length<=40));assert.equal((await store.list()).length,0);
  await box.dispose();
});
test('outbox isolates accounts, reopens pending storage, keeps old/high-count offline events and removes rejected batches',async()=>{
  const store=memoryStore(),statuses=[];let now=10*86400000;
  await store.put({key:'other-user',partition:'other',queuedAt:now,view:{id:'other'},event:{id:'other',seq:1}});
  for(let i=0;i<10005;i++)await store.put({key:`p|${i}`,partition:'p',queuedAt:i===10004?0:now,view:{id:'v'},event:{id:String(i),seq:i+1}});
  const box=createOutbox({store,partition:'p',now:()=>now,status:s=>statuses.push(s),send:async()=>({ok:false,status:422})});
  await box.flush();assert.ok(!statuses.includes('pending-dropped'));assert.ok(statuses.includes('batch-rejected'));assert.equal((await store.list()).length,9606,'only the 400 explicitly rejected events are removed');await box.dispose();
  assert.ok((await store.list()).some(row=>row.partition==='other'),'other account pending events stay isolated');
  const first=createOutbox({store,partition:'p',now:()=>now,send:async()=>({ok:false,status:401})});first.enqueue({id:'pending'},{id:'pending',seq:1});await first.flush();await first.dispose();
  const reopened=createOutbox({store,partition:'p',now:()=>now,send:async()=>({ok:true,status:200})});await reopened.flush();assert.ok((await store.list()).length>0,'bounded work per flush');await reopened.dispose();
});
