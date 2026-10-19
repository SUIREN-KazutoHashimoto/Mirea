import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressSync,bookPosition,restoreBookPosition,resumeVideoMs } from '../web/src/progress-core.js';
import { bindVideoProgress } from '../web/src/progress.js';

test('progress retries use identical update ID/revision and preserve a newer local snapshot until acknowledged',async()=>{
  let persisted,calls=0,revision=0;const sent=[],saved=[],status=[];
  const sync=createProgressSync({revision:0,uuid:()=>`id-${calls}`,persist:value=>persisted=value,status:s=>status.push(s),saved:p=>saved.push(p),send:async body=>{
    sent.push({...body});calls++;if(calls===1)throw new Error('Lost response');
    revision++;return {progress:{revision,positionMs:body.positionMs}};
  }});
  sync.update({positionMs:1000,durationMs:10000});await sync.flush();
  assert.equal(persisted.pending.positionMs,1000);assert.ok(status.includes('pending'));
  sync.update({positionMs:3000,durationMs:10000});await sync.flush();
  assert.deepEqual(sent[0],sent[1]);assert.equal(sent[2].revision,1);assert.equal(sent[2].positionMs,3000);assert.equal(persisted,null);assert.equal(saved.at(-1).positionMs,3000);
});
test('pending resume state can reopen after reload, conflicts stop saves and detached/unchanged content does not reset position',async()=>{
  let record;const send=async()=>{throw new Error('Offline');};
  const sync=createProgressSync({revision:4,send,persist:r=>record=r,uuid:()=> 'persistent-id'});
  sync.update({page:5,scrollX:0,scrollY:0.4,zoom:'fit'});await sync.flush();
  let sent,cleared=false;const resumed=createProgressSync({revision:4,pending:record.pending,desired:record.desired,send:async body=>{sent=body;return {progress:{revision:5}};},persist:value=>cleared=value===null});
  await resumed.flush();assert.equal(sent.updateId,'persistent-id');assert.equal(sent.page,5);assert.equal(cleared,true);
  const warnings=[];let count=0;
  const conflict=createProgressSync({revision:1,send:async()=>{count++;throw Object.assign(new Error('New device'),{status:409});},status:s=>warnings.push(s)});
  conflict.update({positionMs:5000,durationMs:10000});await conflict.flush();conflict.update({positionMs:0,durationMs:10000});await conflict.flush();
  assert.equal(count,1);assert.equal(conflict.stopped,true);assert.ok(warnings.includes('conflict'));
  const unchanged=createProgressSync({revision:1,lastValue:{page:5,scrollX:0,scrollY:0.4,zoom:'fit'},send:async()=>assert.fail('unchanged initial render must not overwrite another viewer')});
  unchanged.update({page:5,scrollX:0,scrollY:0.4,zoom:'fit'});unchanged.update(null);await unchanged.flush();
});
test('saves serialize/coalesce across slow responses and acquire revision after a failed initial read',async()=>{
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);const requests=[];
  const sync=createProgressSync({revision:null,read:async()=>({revision:7}),send:async body=>{requests.push(body);if(requests.length===1){entered();await gate;}return {progress:{revision:body.revision+1}};}});
  sync.update({positionMs:1000,durationMs:10000});const running=sync.flush();await started;
  sync.update({positionMs:2000,durationMs:10000});sync.update({positionMs:3000,durationMs:10000});const concurrent=sync.flush();release();await Promise.all([running,concurrent]);
  assert.deepEqual(requests.map(row=>[row.revision,row.positionMs]),[[7,1000],[8,3000]]);
});
test('book scroll is normalized across display sizes and completed videos restart without treating seek as viewed coverage',()=>{
  const stage={clientWidth:200,clientHeight:300,scrollWidth:600,scrollHeight:1500,scrollLeft:100,scrollTop:600};
  const position=bookPosition(stage,4,'1.5');assert.deepEqual(position,{page:4,scrollX:0.25,scrollY:0.5,zoom:'1.5'});
  const phone={clientWidth:100,clientHeight:200,scrollWidth:500,scrollHeight:1000};restoreBookPosition(phone,position);assert.equal(phone.scrollLeft,100);assert.equal(phone.scrollTop,400);
  assert.equal(bookPosition({clientWidth:0,clientHeight:0},1),null);
  assert.equal(resumeVideoMs({positionMs:30000},120000),30000);assert.equal(resumeVideoMs({positionMs:120000,completed:true},120000),0);assert.equal(resumeVideoMs({positionMs:30000},20000),19750);
});

function videoHarness(initial){
  const video=Object.assign(new EventTarget(),{duration:10,currentTime:0,paused:true,ended:false});
  const positions=[];let snapshot;
  const manager={initial,bind(fn){snapshot=fn;},capture(){const p=snapshot();if(p)positions.push(p);},checkpoint(){this.capture();}};
  const cleanup=bindVideoProgress(video,manager);
  return {video,cleanup,positions,snapshot:()=>snapshot(),event:type=>video.dispatchEvent(new Event(type))};
}
test('video adapter restores paused position without saving zero, then captures user seek/pause and explicit restart',()=>{
  const h=videoHarness({positionMs:5000,durationMs:10000});h.event('loadedmetadata');assert.equal(h.video.currentTime,5);assert.equal(h.snapshot(),null);
  h.event('seeking');h.event('seeked');assert.equal(h.positions.length,0,'restoration alone must not change server state');
  h.video.paused=false;h.event('play');h.video.currentTime=6;h.event('timeupdate');h.video.paused=true;h.event('pause');
  assert.equal(h.positions.at(-1).positionMs,6000);
  h.video.currentTime=3;h.event('seeking');h.event('seeked');assert.equal(h.positions.at(-1).positionMs,3000);
  h.cleanup.restart();assert.equal(h.positions.at(-1).positionMs,0);
  h.video.currentTime=4;h.event('loadedmetadata');assert.equal(h.video.currentTime,4,'ticket reconnection must not restore the stale initial bookmark');
  const count=h.positions.length;h.cleanup();h.event('pause');assert.equal(h.positions.length,count);
});
test('finished video opens from start but stays completed until actual playback; early restart overrides resume',()=>{
  const h=videoHarness({positionMs:10000,durationMs:10000,completed:true});h.event('loadedmetadata');h.event('pause');assert.equal(h.video.currentTime,0);assert.equal(h.positions.length,0);
  h.video.paused=false;h.event('play');h.video.currentTime=1;h.event('timeupdate');assert.equal(h.positions.at(-1).positionMs,1000);h.cleanup();
  const early=videoHarness({positionMs:5000,durationMs:10000});early.cleanup.restart();early.event('loadedmetadata');assert.equal(early.video.currentTime,0);assert.equal(early.positions.at(-1).positionMs,0);early.cleanup();
});
