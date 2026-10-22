import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlaybackOrder} from '../web/src/playback-order.js';
import { createSeriesContinuation,advanceBook,bindContinuationVideo } from '../web/src/series-continuation.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const context=(ids=['a','b','c'],series='series',current='a')=>({series:series?{id:series}:null,items:ids.map(id=>({id,title:id})),currentIndex:ids.indexOf(current)});
function harness(options={}){
  let time=0,nextTimer=0,active=true,fresh=context(),loadCount=0;
  const tasks=new Map(),moves=[],states=[];
  const c=createSeriesContinuation({assetId:'a',now:()=>time,schedule:(fn,ms)=>{tasks.set(++nextTimer,{fn,at:time+ms});return nextTimer;},unschedule:id=>tasks.delete(id),
    isActive:()=>active,loadContext:async()=>{loadCount++;return fresh;},move:async(item,options,allowed)=>{if(allowed())moves.push({id:item.id,...options});},changed:state=>states.push(state),...options});
  c.setContext(context());
  return {c,moves,states,tasks,get loadCount(){return loadCount;},set fresh(value){fresh=value;},set active(value){active=value;},
    async advance(ms){const end=time+ms;while(true){const next=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!next || next[1].at>end)break;time=next[1].at;tasks.delete(next[0]);next[1].fn();await settle();}time=end;await settle();}
  };
}

test('video end counts down once, refreshes the latest series order and starts the next asset at the beginning',async()=>{
  const h=harness();h.c.videoEnded();h.c.videoEnded();assert.equal(h.tasks.size,1);assert.equal(h.c.state.countdown,5);
  await h.advance(4000);assert.equal(h.moves.length,0);assert.equal(h.c.state.countdown,1);
  h.fresh=context(['a','c','b']);await h.advance(1000);
  assert.equal(h.loadCount,1);assert.deepEqual(h.moves,[{id:'c',startAtBeginning:true,autoplay:true}]);h.c.dispose();
});

test('cancellation, opt out, background and closing prevent automatic transitions; series end never loops',async()=>{
  for(const action of ['cancel','disable','background','dispose']){
    const h=harness();h.c.videoEnded();
    if(action==='cancel')h.c.cancel();if(action==='disable')h.c.setEnabled(false);if(action==='background')h.active=false;if(action==='dispose')h.c.dispose();
    await h.advance(10000);assert.equal(h.moves.length,0,action);assert.equal(h.tasks.size,0,action);h.c.dispose();
  }
  const h=harness();h.c.setContext(context(['a']));h.c.videoEnded();await h.advance(10000);
  assert.equal(h.loadCount,0);assert.equal(h.moves.length,0);assert.match(h.c.state.message,/最後/);h.c.dispose();
});

test('fresh access failures, removed series/current/next assets stop in place without skipping or cached fallback',async()=>{
  for(const fresh of [context([],null),context(['a','b'],'different'),context(['b','c']),context(['a'])]){
    const h=harness();h.fresh=fresh;assert.equal(await h.c.nextBook(),false);assert.equal(h.moves.length,0);assert.ok(h.c.state.message);h.c.dispose();
  }
  for(const message of ['権限がありません。','ネットワークが切断されました。']){
    let moves=0;const c=createSeriesContinuation({assetId:'a',loadContext:async()=>{throw new Error(message);},move:async()=>moves++});
    c.setContext(context());assert.equal(await c.nextBook(),false);assert.equal(moves,0);assert.equal(c.state.message,message);c.dispose();
  }
});

test('in-flight requests are single-flight and cannot move late after cancellation, opt out, background or disposal',async()=>{
  for(const action of ['cancel','disable','background','dispose']){
    let release,active=true,moves=0;const gate=new Promise(resolve=>release=resolve);
    const c=createSeriesContinuation({assetId:'a',isActive:()=>active,loadContext:()=>gate,move:async()=>moves++});c.setContext(context());
    const first=c.nextBook();assert.equal(c.state.busy,true);assert.equal(await c.nextBook(),false);
    if(action==='cancel')c.cancel();if(action==='disable')c.setEnabled(false);if(action==='background')active=false;if(action==='dispose')c.dispose();
    release(context());assert.equal(await first,false);assert.equal(moves,0,action);c.dispose();
  }
  let release,moved=false;const gate=new Promise(resolve=>release=resolve);
  const c=createSeriesContinuation({assetId:'a',loadContext:async()=>context(),move:async(item,options,allowed)=>{await gate;moved=allowed();return moved;}});
  c.setContext(context());const pending=c.nextBook();await settle();c.cancel();release();assert.equal(await pending,false);assert.equal(moved,false,'also guarded after progress checkpoint');c.dispose();
});

test('manual navigation still works with continuous mode off, preserves resume and revalidates chosen assets',async()=>{
  const h=harness();h.c.setEnabled(false);assert.equal(await h.c.nextBook(),false);
  assert.equal(await h.c.navigate({targetId:'c'}),true);assert.deepEqual(h.moves,[{id:'c',startAtBeginning:false,autoplay:false}]);
  h.fresh=context(['a','b']);assert.equal(await h.c.navigate({targetId:'c'}),false);assert.equal(h.moves.length,1);h.c.dispose();
});

test('books advance pages normally and cross the final boundary only on an explicit ready next action',()=>{
  const pages=[];let moves=0;const continuation={canContinue:true,nextBook:()=>moves++},go=page=>pages.push(page);
  advanceBook({ready:false,page:2,total:2,go,continuation});assert.equal(moves,0);
  advanceBook({ready:true,page:1,total:2,go,continuation});assert.deepEqual(pages,[2]);assert.equal(moves,0);
  advanceBook({ready:true,page:2,total:2,go,continuation});assert.equal(moves,1);
  continuation.canContinue=false;advanceBook({ready:true,page:2,total:2,go,continuation});assert.equal(moves,1);
  advanceBook({ready:true,page:1,total:1,go});assert.equal(moves,1);
});

function videoHarness(options={}){
  const video=Object.assign(new EventTarget(),{readyState:0,plays:0,play(){this.plays++;return Promise.resolve();}}),events=[];
  const dispose=bindContinuationVideo(video,{onEnded:()=>events.push('ended'),onReset:()=>events.push('reset'),onError:()=>events.push('error'),onBlocked:reason=>events.push(reason),...options});
  return {video,events,dispose,event:type=>video.dispatchEvent(new Event(type))};
}
test('only a continuation video attempts autoplay; real ended events trigger continuation, not metadata/resume/pause',async()=>{
  const initial=videoHarness();for(const event of ['loadedmetadata','canplay','pause','seeked'])initial.event(event);await settle();assert.equal(initial.video.plays,0);assert.deepEqual(initial.events,[]);
  initial.event('ended');assert.deepEqual(initial.events,['ended']);initial.dispose();initial.event('ended');assert.equal(initial.events.length,1);
  const next=videoHarness({autoplay:true});next.event('canplay');next.event('canplay');await settle();assert.equal(next.video.plays,1);
  next.event('play');next.event('seeking');next.event('error');assert.deepEqual(next.events,['reset','reset','error']);next.dispose();
});
test('autoplay policy rejection is recoverable without retry loops; hidden/disposed viewers never start late',async()=>{
  const denied=videoHarness({autoplay:true});denied.video.play=()=>{denied.video.plays++;return Promise.reject(new Error('NotAllowedError'));};
  denied.event('canplay');await settle();denied.event('canplay');await settle();assert.equal(denied.video.plays,1);assert.deepEqual(denied.events,['policy']);denied.dispose();
  const hidden=videoHarness({autoplay:true,canAutoplay:()=>false});hidden.event('canplay');await settle();assert.equal(hidden.video.plays,0);assert.deepEqual(hidden.events,['inactive']);hidden.dispose();
  const closed=videoHarness({autoplay:true});closed.event('canplay');closed.dispose();await settle();assert.equal(closed.video.plays,0);
});

test('media series repeat wraps after a short countdown, respects mode cancellation and still refreshes ACL before moving',async()=>{
  const order=createPlaybackOrder({modes:{repeat:'series'}}),ctx={...context(['b','a'],'series','a'),items:[{id:'b',kind:'audio'},{id:'a',kind:'video'}]};
  const h=harness({order});h.c.setContext(ctx);h.fresh=ctx;h.c.videoEnded();assert.equal(h.c.state.canContinue,true);await h.advance(250);assert.equal(h.loadCount,1);assert.equal(h.moves[0].id,'b');h.c.dispose();
  const k=harness({order:createPlaybackOrder({modes:{repeat:'series'}})});k.c.setContext(ctx);k.fresh=ctx;k.c.videoEnded();k.c.setEnabled(false);await k.advance(1000);assert.equal(k.moves.length,0);k.c.dispose();
});
