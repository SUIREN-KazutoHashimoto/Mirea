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
