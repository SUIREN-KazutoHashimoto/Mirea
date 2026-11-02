import test from 'node:test';
import assert from 'node:assert/strict';
import {attachVideoStream} from '../web/src/video-stream.js';
import {resolveQualityPreference,loadQualityPreference,saveQualityPreference} from '../web/src/quality-preference.js';
class Video extends EventTarget {currentTime=42;duration=100;paused=false;canPlayType(){return '';}load(){this.dispatchEvent(new Event('loadedmetadata'));}async play(){this.paused=false;}}
class Hls {
  static Events={MANIFEST_PARSED:'manifest',LEVEL_SWITCHED:'level',ERROR:'error'};static last;static isSupported(){return true;}
  handlers=new Map();levels=[{width:640,height:360},{width:1280,height:720}];startCalls=0;stopCalls=0;manual=-1;
  constructor(config){Hls.last=this;this.config=config;}
  on(name,fn){this.handlers.set(name,fn);}emit(name,data){this.handlers.get(name)?.(name,data);}
  set currentLevel(value){this.manual=value;}get autoLevelEnabled(){return this.manual===-1;}
  attachMedia(){}loadSource(url){this.url=url;}startLoad(){this.startCalls++;}stopLoad(){this.stopCalls++;}destroy(){this.destroyed=true;}
}
const ticket={url:'/content',hlsUrl:'/hls/master.m3u8?ticket=first',renditions:[{quality:'720p',width:1280,height:720},{quality:'360p',width:640,height:360}]};
test('high quality and data saving modes select valid levels and report analytics as auto, never invalid modes',()=>{
 const reports=[],stream=attachVideoStream(new Video(),{ticket,HlsClass:Hls,absoluteUrl:p=>p,onQuality:q=>reports.push(q)}),hls=Hls.last;hls.emit('manifest');stream.choose('data');assert.equal(hls.autoLevelCapping,0);assert.equal(hls.manual,-1);assert.equal(reports.at(-1).selectedQuality,'auto');stream.choose('higher');assert.equal(hls.manual,1);stream.choose('auto');assert.equal(hls.manual,-1);assert.equal(hls.autoLevelCapping,-1);stream.dispose();
});
test('HLS fixed quality disables ABR, persists through renewed manifests and never silently maps a missing level to auto',async()=>{
  const video=new Video(),reports=[],errors=[],choices=[];const stream=attachVideoStream(video,{ticket,HlsClass:Hls,absoluteUrl:p=>p,initialQuality:'720p',renew:async()=>({...ticket,hlsUrl:'/hls/master.m3u8?ticket=second'}),onQuality:q=>reports.push(q),onError:e=>errors.push(e),onChoose:q=>choices.push(q)}),hls=Hls.last;
  assert.equal(hls.config.autoStartLoad,false);assert.equal(hls.startCalls,0);hls.emit('manifest');assert.equal(hls.manual,1);assert.equal(hls.autoLevelEnabled,false);
  stream.choose('360p');assert.equal(hls.manual,0);assert.equal(video.currentTime,42);hls.emit('level',{level:0});assert.equal(reports.at(-1).selectedQuality,'360p');
  await stream.reconnect();hls.emit('manifest');assert.equal(hls.manual,0);assert.match(hls.url,/ticket=second/);assert.equal(video.currentTime,42);
  hls.levels=[];hls.emit('manifest');assert.equal(hls.stopCalls,1);assert.equal(hls.manual,0);assert.match(errors.at(-1).message,/固定/);
  stream.choose('auto');assert.equal(hls.autoLevelEnabled,true);assert.deepEqual(choices,['360p','auto']);stream.dispose();assert(hls.destroyed);
});
test('quality preference is isolated by account/server and uses a compatible fixed fallback without changing the stored preference',()=>{
  const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
  saveQualityPreference('https://a','user1','1080p',storage);assert.equal(loadQualityPreference('https://a','user1',storage),'1080p');assert.equal(loadQualityPreference('https://a','user2',storage),'auto');assert.equal(loadQualityPreference('https://b','user1',storage),'auto');
  assert.equal(resolveQualityPreference(ticket.renditions,'1080p'),'720p');assert.equal(resolveQualityPreference(ticket.renditions,'144p'),'360p');assert.equal(resolveQualityPreference(ticket.renditions,'auto'),'auto');assert.equal(loadQualityPreference('https://a','user1',storage),'1080p');assert.equal(resolveQualityPreference(ticket.renditions,'../../raw'),'auto');
  assert.equal(loadQualityPreference('https://a','user1',{getItem(){throw Error('Denied');}}),'auto');assert.doesNotThrow(()=>saveQualityPreference('a','b','720p',{setItem(){throw Error('Full');}}));
});
