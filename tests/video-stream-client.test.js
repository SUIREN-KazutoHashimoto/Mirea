import test from 'node:test';
import assert from 'node:assert/strict';
import { attachVideoStream } from '../web/src/video-stream.js';

class Video extends EventTarget {
  currentTime=0;duration=100;paused=true;value='';
  canPlayType(){return 'probably';}
  set src(value){this.value=value;this.currentTime=0;}
  get src(){return this.value;}
  load(){this.dispatchEvent(new Event('loadedmetadata'));}
  async play(){this.paused=false;}
}
const ticket={url:'/content?ticket=first',hlsUrl:'/hls/master.m3u8?ticket=first',expiresAt:Date.now()+3600000,renditions:[{quality:'720p',width:1280,height:720},{quality:'360p',width:640,height:360}]};
test('native HLS quality and ticket refresh restore position/play state and never report invalid auto actual-quality',async()=>{
  const video=new Video(),qualities=[],options=[];
  const stream=attachVideoStream(video,{ticket,absoluteUrl:p=>'https://mirea.test'+p,renew:async()=>({...ticket,url:'/content?ticket=next',hlsUrl:'/hls/master.m3u8?ticket=next'}),onQuality:q=>qualities.push(q),onOptions:o=>options.push(o)});
  try{
    video.currentTime=42;video.paused=false;
    stream.choose('720p');assert.equal(video.currentTime,42);assert.equal(video.paused,false);assert.match(video.src,/720p\.m3u8/);
    stream.choose('auto');assert.equal(video.currentTime,42);assert.equal(qualities.at(-1).actualQuality,'unknown');assert.match(video.src,/master\.m3u8/);
    await stream.reconnect();assert.equal(video.currentTime,42);assert.match(video.src,/ticket=next/);
    stream.choose('../../original');assert.match(video.src,/master\.m3u8/);
    assert.equal(options.at(-1).selected,'auto');
  }finally{stream.dispose();}
});
test('non-HLS fallback keeps legacy MP4 and hides unsupported quality controls',()=>{
  const video=new Video();video.canPlayType=()=>'';let controls,quality;
  const stream=attachVideoStream(video,{ticket,absoluteUrl:p=>p,onOptions:o=>{controls=o;},onQuality:q=>{quality=q;}});
  try{assert.equal(video.src,ticket.url);assert.deepEqual(controls.qualities,[]);assert.equal(quality.streamKind,'mp4');assert.equal(quality.selectedQuality,'legacy');}finally{stream.dispose();}
});

test('rapid source switches preserve the first position and rate until metadata, without restarting a paused viewer',()=>{
  const video=new Video();video.playbackRate=1.5;video.load=()=>{};
  const stream=attachVideoStream(video,{ticket,absoluteUrl:p=>p});
  try{video.currentTime=42;stream.choose('720p');stream.choose('360p');video.dispatchEvent(new Event('loadedmetadata'));assert.equal(video.currentTime,42);assert.equal(video.playbackRate,1.5);assert.equal(video.paused,true);assert.match(video.src,/360p/);}finally{stream.dispose();}
});

test('failed renewal retries on network return and closing during renewal never changes the old source',async()=>{
  const video=new Video(),events=new EventTarget();let attempts=0,finish;
  const stream=attachVideoStream(video,{ticket,events,absoluteUrl:p=>p,renew:async()=>{attempts++;if(attempts===1)throw Error('offline');return new Promise(resolve=>{finish=resolve;});}});
  try{video.currentTime=32;await assert.rejects(stream.reconnect(),/offline/);events.dispatchEvent(new Event('online'));await Promise.resolve();assert.equal(attempts,2);const before=video.src;stream.dispose();finish({...ticket,url:'/new',hlsUrl:'/hls/new'});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(video.src,before);}finally{stream.dispose();}
});
test('automatic authorization renewal preserves the same URL, rate, position and playing element without reload',async()=>{
 const video=new Video(),events=new EventTarget();let loads=0;video.load=()=>loads++;video.playbackRate=1.5;
 const stream=attachVideoStream(video,{ticket,events,absoluteUrl:p=>p,renew:async previous=>{assert.equal(previous,ticket);return {...previous,expiresAt:Date.now()+3600000};}});
 try{video.currentTime=47;video.paused=false;const source=video.src;await stream.reconnect({seamless:true});assert.equal(video.src,source);assert.equal(video.currentTime,47);assert.equal(video.playbackRate,1.5);assert.equal(video.paused,false);assert.equal(loads,0);events.dispatchEvent(new Event('online'));await Promise.resolve();assert.equal(loads,0);}finally{stream.dispose();}
});

class RecoveringHls {
 static Events={MANIFEST_PARSED:'manifest',LEVEL_SWITCHED:'level',ERROR:'error'};
 static ErrorTypes={NETWORK_ERROR:'networkError',MEDIA_ERROR:'mediaError'};
 static isSupported(){return true;}
 static current;
 constructor(config){this.config=config;this.listeners=new Map();this.levels=[{width:640,height:360},{width:1280,height:720}];this.loads=[];RecoveringHls.current=this;}
 on(name,callback){this.listeners.set(name,callback);}
 emit(name,data={}){this.listeners.get(name)?.(name,data);}
 attachMedia(video){this.video=video;}
 loadSource(url){this.loads.push(url);this.video.currentTime=0;this.video.dispatchEvent(new Event('loadedmetadata'));this.emit('manifest');}
 startLoad(){}
 stopLoad(){}
 destroy(){this.destroyed=true;}
}
test('fatal transport errors recover on network return without losing position, rate or pause intent',async()=>{
 const video=new Video(),events=new EventTarget();video.playbackRate=1.5;let renewals=0,errors=0;
 const stream=attachVideoStream(video,{ticket,events,HlsClass:RecoveringHls,absoluteUrl:p=>p,renew:async()=>{renewals++;return {...ticket,url:'/new',hlsUrl:'/new/master.m3u8'};},onError:()=>errors++});
 try{
  video.currentTime=61;await video.play();video.dispatchEvent(new Event('play'));
  RecoveringHls.current.emit('error',{fatal:true,type:'networkError'});
  video.dispatchEvent(new CustomEvent('mirea:playback-intent',{detail:{playing:false}}));video.paused=true;
  events.dispatchEvent(new Event('online'));await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(renewals,1);assert.equal(video.currentTime,61);assert.equal(video.playbackRate,1.5);assert.equal(video.paused,true);assert.equal(errors,0);assert.equal(RecoveringHls.current.loads.length,2);
 }finally{stream.dispose();}
});
test('revoked HLS authorization never enters an automatic recovery loop',async()=>{
 const video=new Video(),events=new EventTarget();let renewals=0,errors=0;
 const stream=attachVideoStream(video,{ticket,events,HlsClass:RecoveringHls,absoluteUrl:p=>p,renew:async()=>{renewals++;return ticket;},onError:()=>errors++});
 try{RecoveringHls.current.emit('error',{fatal:true,type:'networkError',response:{code:403}});events.dispatchEvent(new Event('online'));await Promise.resolve();assert.equal(renewals,0);assert.equal(errors,1);}finally{stream.dispose();}
});
test('disposing a failed HLS stream cancels future network-triggered recovery',async()=>{
 const video=new Video(),events=new EventTarget();let renewals=0;
 const stream=attachVideoStream(video,{ticket,events,HlsClass:RecoveringHls,absoluteUrl:p=>p,renew:async()=>{renewals++;return ticket;}});
 RecoveringHls.current.emit('error',{fatal:true,type:'networkError'});stream.dispose();events.dispatchEvent(new Event('online'));await Promise.resolve();assert.equal(renewals,0);assert.equal(RecoveringHls.current.destroyed,true);
});

test('PiP HLS disposal transfers the connected media without clearing its source and releases the owned URL',()=>{
 class TransferableHls extends RecoveringHls {
  static Events={...RecoveringHls.Events,MEDIA_ATTACHED:'attached'};
  attachMedia(video){super.attachMedia(video);this.media=video;video.src='blob:owned-by-hls';this.emit('attached');}
  transferMedia(){this.transferred=true;const media=this.media;this.media=null;return {media,mediaSource:{}};}
  destroy(){if(this.media){this.media.src='';this.media.load();}super.destroy();}
 }
 const revoke=URL.revokeObjectURL,revoked=[];URL.revokeObjectURL=value=>revoked.push(value);
 try{for(const preserveMedia of [true,false]){
  const video=new Video();let loads=0;video.load=()=>loads++;
  const stream=attachVideoStream(video,{ticket,HlsClass:TransferableHls,absoluteUrl:p=>p});const hls=RecoveringHls.current;video.currentTime=45;video.paused=false;
  stream.dispose({preserveMedia});assert.equal(hls.destroyed,true);assert.equal(Boolean(hls.transferred),preserveMedia);
  assert.equal(video.src,preserveMedia?'blob:owned-by-hls':'');assert.equal(loads,preserveMedia?0:1);if(preserveMedia){assert.equal(video.currentTime,45);assert.equal(video.paused,false);}
  stream.dispose();
 }assert.deepEqual(revoked,['blob:owned-by-hls']);}finally{URL.revokeObjectURL=revoke;}
});

test('native HLS and progressive media recover network failures and honor a pause during retry',async()=>{
 for(const nativeHls of [false,true]){
  const video=new Video(),events=new EventTarget();video.canPlayType=()=>nativeHls?'probably':'';video.playbackRate=1.5;
  let attempts=0,errors=0;const stream=attachVideoStream(video,{ticket,events,absoluteUrl:p=>p,renew:async()=>{attempts++;return ticket;},onError:()=>errors++});
  try{
   video.currentTime=37;await video.play();video.dispatchEvent(new Event('play'));video.error={code:2};video.paused=true;video.dispatchEvent(new Event('pause'));video.dispatchEvent(new Event('error'));
   video.dispatchEvent(new CustomEvent('mirea:playback-intent',{detail:{playing:false}}));events.dispatchEvent(new Event('online'));
   await new Promise(resolve=>setTimeout(resolve,0));assert.equal(attempts,1);assert.equal(video.currentTime,37);assert.equal(video.playbackRate,1.5);assert.equal(video.paused,true);assert.equal(errors,0);
  }finally{stream.dispose();}
 }
});

test('progressive recovery stops on denied access or disposal; corrupt media does not retry',async()=>{
 for(const scenario of ['denied','disposed','decode']){
  const video=new Video(),events=new EventTarget();video.canPlayType=()=>'';let attempts=0,errors=0;
  const stream=attachVideoStream(video,{ticket,events,absoluteUrl:p=>p,renew:async()=>{attempts++;throw Object.assign(Error('denied'),{status:403});},onError:()=>errors++});
  try{
   video.error={code:scenario==='decode'?3:2};video.dispatchEvent(new Event('error'));if(scenario==='disposed')stream.dispose();events.dispatchEvent(new Event('online'));await new Promise(resolve=>setTimeout(resolve,0));
   events.dispatchEvent(new Event('online'));await Promise.resolve();assert.equal(attempts,scenario==='denied'?1:0);assert.equal(errors,scenario==='denied'?1:0);
  }finally{stream.dispose();}
 }
});
