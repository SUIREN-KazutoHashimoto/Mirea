import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressSync,bookPosition,restoreBookPosition,resumeVideoMs } from '../web/src/progress-core.js';
import { bindVideoProgress,openProgress } from '../web/src/progress.js';
import {setSession} from '../web/src/api.js';

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
  assert.equal(count,1);assert.equal(conflict.stopped,false);assert.equal(conflict.conflicted,true);assert.ok(warnings.includes('conflict'));
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

test('acknowledged offline resume snapshots survive cold reopening with a dated revision baseline; accounts remain isolated',async()=>{
  const {createProgressCache}=await import('../web/src/progress-cache.js');const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  let now=1800000000000;const partition='https://mirea.test|actor',id='asset';
  const first=createProgressCache(storage,partition,id,{now:()=>now}),position={positionMs:64000,durationMs:100000,revision:7};first.write({last:position,revision:7});
  now+=86400000;const reopened=createProgressCache(storage,partition,id,{now:()=>now});assert.equal(reopened.read().last.positionMs,64000);assert.equal(reopened.read().revision,7);assert.equal(reopened.read().at,now-86400000);
  assert.equal(createProgressCache(storage,'https://other.test|actor',id).read(),null);
  reopened.write({pending:{updateId:'stable-id',revision:7,positionMs:65000,durationMs:100000},desired:{positionMs:70000,durationMs:100000},last:position,revision:7});assert.equal(reopened.read().pending.updateId,'stable-id');assert.equal(reopened.read().at,now);
});

test('conflicts preserve newer local reading and require an explicit choice before replacing remote progress',async()=>{
  let persisted,requests=0,remote={revision:4,page:20},nextId=0;
  const options={revision:3,read:async()=>({revision:remote.revision,progress:remote}),uuid:()=>`choice-${++nextId}`,persist:value=>persisted=value,
    send:async body=>{requests++;if(body.revision!==remote.revision)throw Object.assign(Error('Conflict'),{status:409});remote={...body,revision:remote.revision+1};return {progress:remote};}};
  const sync=createProgressSync(options);sync.update({page:80});await sync.flush();
  assert.equal(sync.conflicted,true);assert.equal(persisted.desired.page,80);
  sync.update({page:81});await sync.flush();assert.equal(requests,1);assert.equal(persisted.desired.page,81);
  const reopened=createProgressSync({...options,...persisted});assert.equal(reopened.conflicted,true);
  await reopened.resolveConflict('local');assert.equal(remote.page,81);assert.equal(remote.revision,5);assert.equal(reopened.conflicted,false);assert.equal(persisted,null);
  const other=createProgressSync({...options,revision:4});other.update({page:90});await other.flush();
  const before=requests;assert.equal((await other.resolveConflict('remote')).page,81);assert.equal(requests,before);assert.equal(other.conflicted,false);
  other.update({page:82});await other.flush();assert.equal(remote.page,82);
});

test('a preloaded media element restores and captures progress without another loadedmetadata event',()=>{
  const video=Object.assign(new EventTarget(),{readyState:4,duration:120,currentTime:0,paused:true,ended:false});let snapshot;const positions=[];
  const manager={initial:{positionMs:60000,durationMs:120000},bind(fn){snapshot=fn;},capture(){const value=snapshot();if(value)positions.push(value);},checkpoint(){this.capture();}};
  const dispose=bindVideoProgress(video,manager);assert.equal(video.currentTime,60);
  video.dispatchEvent(new Event('seeked'));assert.equal(snapshot(),null);
  video.paused=false;video.dispatchEvent(new Event('play'));video.currentTime=62;video.dispatchEvent(new Event('timeupdate'));
  assert.equal(positions.at(-1).positionMs,62000);dispose();
});

test('a retained PiP element ignores the previous source until new metadata arrives',()=>{
  const video=Object.assign(new EventTarget(),{readyState:4,duration:120,currentTime:80,paused:false,ended:false});let snapshot;const positions=[];
  const manager={initial:{positionMs:30000,durationMs:60000},bind(fn){snapshot=fn;},capture(){const value=snapshot();if(value)positions.push(value);},checkpoint(){this.capture();}};
  const dispose=bindVideoProgress(video,manager,{waitForMetadata:true});assert.equal(video.currentTime,80);assert.equal(snapshot(),null);
  for(const event of ['timeupdate','pause','seeked'])video.dispatchEvent(new Event(event));assert.equal(positions.length,0);
  video.duration=60;video.currentTime=0;video.dispatchEvent(new Event('loadedmetadata'));assert.equal(video.currentTime,30);assert.equal(snapshot(),null);
  video.dispatchEvent(new Event('seeked'));assert.equal(positions.at(-1).positionMs,30000);assert.equal(positions.at(-1).durationMs,60000);dispose();
});

test('a retained PiP next track starts at zero without recording the prior track position',()=>{
  const video=Object.assign(new EventTarget(),{readyState:4,duration:120,currentTime:115,paused:false,ended:false});let snapshot;const positions=[];
  const manager={initial:null,bind(fn){snapshot=fn;},capture(){const value=snapshot();if(value)positions.push(value);},checkpoint(){this.capture();}};
  const dispose=bindVideoProgress(video,manager,{waitForMetadata:true});video.dispatchEvent(new Event('pause'));assert.equal(positions.length,0);
  video.duration=90;video.currentTime=0;video.dispatchEvent(new Event('loadedmetadata'));video.dispatchEvent(new Event('play'));video.dispatchEvent(new Event('timeupdate'));
  assert.equal(positions.at(-1).positionMs,0);assert.equal(positions.at(-1).durationMs,90000);dispose();
});

test('choosing local progress reports a second conflict or network outage instead of claiming saved',async()=>{
 for(const failure of [Object.assign(Error('conflict'),{status:409}),Object.assign(Error('offline'),{status:503})]){
  let record;const sync=createProgressSync({revision:3,pending:{revision:3,updateId:'old',page:80},desired:{page:81},conflict:{revision:3},read:async()=>({revision:4,progress:{page:20,revision:4}}),send:async()=>{throw failure;},persist:value=>record=value});
  await assert.rejects(sync.resolveConflict('local'),error=>error.code===(failure.status===409?'PROGRESS_CONFLICT':'PROGRESS_PENDING'));assert.equal(record.desired.page,81);assert.equal(sync.conflicted,failure.status===409);
 }
});

async function progressOpenFixture(t,transport){
 const keys=['localStorage','sessionStorage','location','window','document','fetch'],previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),values=new Map();
 const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 for(const [key,value] of Object.entries({localStorage:storage,sessionStorage:storage,location:{origin:'https://mirea.test'},window:new EventTarget(),document:Object.assign(new EventTarget(),{hidden:false}),fetch:async(url,options={})=>url.includes('/auth/remember')?new Response(null,{status:204}):transport(options.method)}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 t.after(()=>{for(const key of keys){if(previous.get(key))Object.defineProperty(globalThis,key,previous.get(key));else delete globalThis[key];}});
 await setSession({token:'a'.repeat(43),expiresAt:Date.now()+3600000,user:{id:'progress-fixture',name:'Fixture',email:'fixture@example.test'}},{remember:false,broadcast:false});
 const key='mirea.progress.v1|https://mirea.test|progress-fixture|fixture';storage.setItem(key,JSON.stringify({revision:1,last:{positionMs:1000,durationMs:100000,revision:1},pending:{revision:1,updateId:'exact',positionMs:60000,durationMs:100000},desired:{positionMs:60000,durationMs:100000}}));
 return {key,storage,item:{id:'fixture',kind:'audio'},json:value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})};
}
test('opening progress retains the acknowledged retry when the following GET fails',async t=>{
 let fixture;fixture=await progressOpenFixture(t,async method=>{if(method==='GET')throw new TypeError('network');return fixture.json({progress:{positionMs:60000,durationMs:100000,revision:2}});});
 const manager=await openProgress(fixture.item);t.after(()=>manager.dispose());assert.equal(manager.initial.positionMs,60000);assert.equal(JSON.parse(fixture.storage.getItem(fixture.key)).revision,2);
});
test('a failed PUT followed by a newer remote GET keeps local position and requests an explicit choice',async t=>{
 let fixture;fixture=await progressOpenFixture(t,async method=>{if(method==='PUT')throw new TypeError('network');return fixture.json({revision:2,progress:{positionMs:5000,durationMs:100000,revision:2}});});
 const states=[],manager=await openProgress(fixture.item,{status:value=>states.push(value)});t.after(()=>manager.dispose());assert.equal(manager.initial.positionMs,60000);assert.equal(manager.conflicted,true);assert.ok(states.includes('conflict'));assert.equal(JSON.parse(fixture.storage.getItem(fixture.key)).pending.updateId,'exact');
});

test('a continuous track starts at zero while a saved-position conflict stays unresolved',async t=>{
 let fixture,puts=0;
 fixture=await progressOpenFixture(t,async method=>{if(method==='PUT'){puts++;throw new TypeError('network');}return fixture.json({revision:2,progress:{positionMs:5000,durationMs:100000,revision:2}});});
 const manager=await openProgress(fixture.item,{startAtBeginning:true});t.after(()=>manager.dispose());
 assert.equal(manager.initial,null);assert.equal(manager.conflicted,true);
 const video=Object.assign(new EventTarget(),{readyState:4,duration:100,currentTime:0,paused:true,ended:false});
 const unbind=bindVideoProgress(video,manager);t.after(unbind);
 assert.equal(video.currentTime,0,'the next track must not seek to the saved local or remote position');
 const attempts=puts;video.paused=false;video.dispatchEvent(new Event('play'));await manager.checkpoint();
 assert.equal(puts,attempts,'starting playback must not silently resolve another device\'s conflict');
 const retained=JSON.parse(fixture.storage.getItem(fixture.key));
 assert.equal(retained.pending.updateId,'exact');assert.equal(retained.pending.positionMs,60000);
 assert.equal(retained.desired.positionMs,0);assert.ok(retained.conflict);
});

test('offline continuous playback starts at zero but a direct open retains its bookmark',async t=>{
 const fixture=await progressOpenFixture(t,async()=>{throw new TypeError('network');});
 const next=await openProgress({...fixture.item,kind:'video'},{startAtBeginning:true});
 assert.equal(next.initial,null);next.dispose();
 const direct=await openProgress({...fixture.item,kind:'video'});t.after(()=>direct.dispose());
 assert.equal(direct.initial.positionMs,60000);
 assert.equal(JSON.parse(fixture.storage.getItem(fixture.key)).pending.updateId,'exact');
});
