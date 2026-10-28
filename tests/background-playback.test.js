import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mountMediaSession } from '../web/src/media-session.js';
import { createViewRecorder } from '../web/src/analytics-core.js';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';

class Media extends EventTarget {paused=true;currentTime=20;duration=100;playbackRate=1;async play(){this.paused=false;this.dispatchEvent(new Event('play'));}pause(){this.paused=true;this.dispatchEvent(new Event('pause'));}}
test('Web OS media actions control a single player, clamp seeks, update positions and unregister on close',async()=>{
  const media=new Media(),actions=new Map(),positions=[],session={setActionHandler:(k,v)=>actions.set(k,v),setPositionState:v=>positions.push(v)};
  let stopped=0;const binding=mountMediaSession(media,{title:'Track',kind:'audio',stop:()=>stopped++,navigator:{mediaSession:session},MediaMetadata:class{constructor(value){Object.assign(this,value);}},document:{}});
  assert.equal(session.metadata.title,'Track');assert.equal(binding.supportsPip,false);assert.ok(!actions.has('enterpictureinpicture'));
  await actions.get('play')();assert.equal(session.playbackState,'playing');actions.get('seekto')({seekTime:500});assert.equal(media.currentTime,100);actions.get('seekbackward')({seekOffset:200});assert.equal(media.currentTime,0);
  actions.get('stop')();assert.equal(media.paused,true);assert.equal(stopped,1);binding.dispose();assert.equal(session.playbackState,'none');assert.equal(session.metadata,null);assert.ok([...actions.values()].every(v=>v===null));
});
test('video PiP detects actual browser support and safely exits when the viewer closes',async()=>{
  const media=new Media(),doc={pictureInPictureEnabled:true,pictureInPictureElement:null,async exitPictureInPicture(){this.pictureInPictureElement=null;}};
  media.requestPictureInPicture=async()=>{doc.pictureInPictureElement=media;};
  const binding=mountMediaSession(media,{kind:'video',document:doc,navigator:{}});assert.equal(binding.supportsPip,true);await binding.pip();assert.equal(doc.pictureInPictureElement,media);await binding.pip();assert.equal(doc.pictureInPictureElement,null);await binding.pip();binding.dispose();assert.equal(doc.pictureInPictureElement,null);
  const absent=mountMediaSession(new Media(),{kind:'video',document:{},navigator:{}});assert.equal(absent.supportsPip,false);await assert.rejects(absent.pip());absent.dispose();
});
test('returning to library keeps audio/video playback and exact position, enters PiP once and falls back on refusal',async()=>{
  for(const kind of ['audio','video']){
    const media=new Media();await media.play();let minimized=0,requests=0;const doc={pictureInPictureEnabled:true,pictureInPictureElement:null,async exitPictureInPicture(){this.pictureInPictureElement=null;}};
    media.requestPictureInPicture=async()=>{requests++;doc.pictureInPictureElement=media;};
    const session=mountMediaSession(media,{kind,document:doc,navigator:{}});await session.background(()=>minimized++);assert.equal(media.paused,false);assert.equal(media.currentTime,20);assert.equal(minimized,1);assert.equal(requests,kind==='video'?1:0);
    await session.background(()=>minimized++);assert.equal(requests,kind==='video'?1:0);assert.equal(minimized,2);
    session.dispose();assert.equal(doc.pictureInPictureElement,null);
  }
  const media=new Media();await media.play();let minimized=false;media.requestPictureInPicture=async()=>{throw Error('PiP denied');};const binding=mountMediaSession(media,{kind:'video',document:{pictureInPictureEnabled:true},navigator:{}});
  await binding.background(()=>{minimized=true;});assert(minimized);assert.equal(media.paused,false);binding.dispose();
});
test('a late PiP result after closing never restores a disposed player',async()=>{
  const media=new Media();let finish,exits=0;const doc={pictureInPictureEnabled:true,pictureInPictureElement:null,async exitPictureInPicture(){exits++;this.pictureInPictureElement=null;}};
  media.requestPictureInPicture=()=>new Promise(resolve=>{finish=()=>{doc.pictureInPictureElement=media;resolve();};});
  const binding=mountMediaSession(media,{kind:'video',document:doc,navigator:{}});const pending=binding.background(()=>assert.fail('disposed mini-player'));binding.dispose();finish();await pending;assert.equal(exits,1);
});

test('old viewer disposal never clears a newer OS media session; delayed artwork belongs to its owner',()=>{
  const actions=new Map(),session={setActionHandler:(key,value)=>actions.set(key,value)},nav={mediaSession:session},Metadata=class{constructor(value){Object.assign(this,value);}};
  const first=mountMediaSession(new Media(),{title:'Old',navigator:nav,MediaMetadata:Metadata,document:{}}),second=mountMediaSession(new Media(),{title:'Current',navigator:nav,MediaMetadata:Metadata,document:{}});
  first.setArtwork('blob:old');first.dispose();assert.equal(session.metadata.title,'Current');assert.equal(typeof actions.get('play'),'function');second.setArtwork('blob:current');assert.equal(session.metadata.artwork[0].src,'blob:current');second.dispose();assert.equal(session.metadata,null);
});

test('Safari PiP toggles back inline and restoring presentation exits PiP without pausing',async()=>{
  const media=new Media();await media.play();media.webkitPresentationMode='inline';media.webkitSupportsPresentationMode=()=>true;media.webkitSetPresentationMode=value=>{media.webkitPresentationMode=value;};
  const binding=mountMediaSession(media,{document:{},navigator:{}});await binding.pip();assert.equal(media.webkitPresentationMode,'picture-in-picture');await binding.pip();assert.equal(media.webkitPresentationMode,'inline');await binding.pip();binding.exitPip();assert.equal(media.webkitPresentationMode,'inline');assert.equal(media.paused,false);binding.dispose();
});
test('background and PiP measure actual progression separately from visible/focused time; throttled gaps, paused time and seeks are not invented',()=>{
  let now=0,state={visible:false,focused:false,idle:false,backgroundPlayback:true,pictureInPicture:false,playing:true,seeking:false,buffering:false,rate:1,toMs:0};const events=[];
  const recorder=createViewRecorder({view:{id:randomUUID()},clock:()=>now,snapshot:()=>({...state}),emit:(_,event)=>events.push(event)});
  now=1000;state.toMs=1000;recorder.sample();let interval=events.find(e=>e.type==='interval');assert.equal(interval.watchMs,1000);assert.equal(interval.backgroundMs,1000);assert.equal(interval.visibleMs,0);assert.equal(interval.activeMs,0);assert.equal(events.filter(e=>e.type==='view_start').length,1);
  recorder.change('viewport',()=>{state={...state,backgroundPlayback:false,pictureInPicture:true,visible:true};});now=2000;state.toMs=2000;recorder.sample();interval=events.filter(e=>e.type==='interval').at(-1);assert.equal(interval.pipMs,1000);assert.equal(interval.backgroundMs,0);assert.equal(interval.activeMs,0);
  now=62000;state.toMs=62000;recorder.sample();interval=events.filter(e=>e.type==='interval').at(-1);assert.equal(interval.watchMs,0);assert.equal(interval.gapMs,58000);
  recorder.change('seeking',()=>{state.seeking=true;});now=63000;state.toMs=90000;recorder.sample();assert.equal(events.at(-1).watchMs,0);
  recorder.change('pause',()=>{state.seeking=false;state.playing=false;});now=64000;recorder.sample();assert.equal(events.at(-1).watchMs,0);recorder.close();
});

test('API accepts genuine background/PiP playback without visible credit, rejects book/preview/paused abuse and preserves old retry hashes',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-background-')),app=await createApp({dataDir,rateLimit:false});
  const db=new DatabaseSync(join(dataDir,'mirea.sqlite'));t.after(async()=>{db.close();await app.close();await rm(dataDir,{recursive:true,force:true});});
  const user=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email:'bg@example.test',name:'Background',password:'background-test-password'}})).json();
  const headers={authorization:`Bearer ${user.token}`},shelf=(await app.inject({method:'POST',url:'/api/v1/shelves',headers,payload:{name:'Background'}})).json().id;
  const video=randomUUID(),book=randomUUID();for(const [id,mime] of [[video,'video/mp4'],[book,'application/pdf']])db.prepare('INSERT INTO items VALUES(?,?,?,?,?,100,?,1,1,1)').run(id,shelf,'Asset','asset',mime,user.user.id);
  const base={visible:false,focused:false,idle:false,backgroundPlayback:true,pictureInPicture:false,playing:true,seeking:false,buffering:false,rate:1,toMs:0,durationMs:10000};
  const view={id:randomUUID(),assetId:video,context:'viewer',platform:'android',clientVersion:'test'};
  const event=(seq,type,state={})=>({id:randomUUID(),seq,type,at:Date.now(),elapsedMs:(seq-1)*1000,...base,...state});
  const events=[event(1,'view_start'),event(2,'interval',{intervalMs:1000,visibleMs:0,activeMs:0,watchMs:1000,backgroundMs:1000,pipMs:0,fromMs:0,toMs:1000}),event(3,'interval',{visible:true,backgroundPlayback:false,pictureInPicture:true,intervalMs:1000,visibleMs:1000,activeMs:0,watchMs:1000,pipMs:1000,backgroundMs:0,fromMs:1000,toMs:2000})];
  const post=(v,e)=>app.inject({method:'POST',url:'/api/v1/analytics/events',headers,payload:{view:v,events:e}});
  const accepted=await post(view,events);assert.equal(accepted.statusCode,200,accepted.body);
  const summary=(await app.inject({url:'/api/v1/analytics/me/summary',headers})).json();assert.equal(summary.assets[0].watchMs,2000);assert.equal(summary.assets[0].visibleMs,1000);assert.equal(summary.assets[0].activeMs,0);
  for(const [v,e] of [[{...view,id:randomUUID(),assetId:book},events],[{...view,id:randomUUID(),context:'preview'},events],[{...view,id:randomUUID()},[event(2,'interval',{intervalMs:1000,watchMs:1000,backgroundMs:1000,fromMs:0,toMs:1000,playing:false})]]])assert.equal((await post(v,e)).statusCode,422);
  assert.equal((await post({...view,id:randomUUID()},[event(2,'interval',{intervalMs:1000,visibleMs:0,activeMs:0,watchMs:5000,backgroundMs:5000,fromMs:0,toMs:1000})])).statusCode,422);
  // Old schema-1 events have no backgroundMs/pipMs keys: normalization stays byte-compatible.
  const oldView={...view,id:randomUUID()},old={id:randomUUID(),seq:1,type:'open',at:Date.now(),elapsedMs:0};assert.equal((await post(oldView,[old])).statusCode,200);assert.equal((await post(oldView,[old])).json().duplicates,1);
  const payload=JSON.parse(db.prepare('SELECT payload_json FROM analytics_events WHERE event_id=?').get(old.id).payload_json);assert.equal('backgroundMs' in payload,false);
});
