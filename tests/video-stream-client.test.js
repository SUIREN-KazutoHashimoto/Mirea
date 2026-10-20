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
