import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVideoHold } from '../web/src/video-hold.js';
import { heatmapGeometry } from '../web/src/replay-heatmap.js';
import { bindSeekInteraction } from '../web/src/seek-interaction.js';
class Media extends EventTarget {paused=false;ended=false;readyState=4;playbackRate=1.25;setPointerCapture(){} }
function setup(){const media=new Media(),win=new EventTarget(),doc=new EventTarget(),changes=[];let task;const hold=mountVideoHold(media,{window:win,document:doc,changed:v=>changes.push(v),setTimer:fn=>(task=fn,1),clearTimer:()=>{task=null;}});return {media,win,doc,changes,hold,trigger:()=>task?.()};}
function pointer(target,type,values={}){const event=new Event(type,{cancelable:true});Object.assign(event,{pointerId:1,button:0,isPrimary:true,clientX:10,clientY:10,...values});target.dispatchEvent(event);return event;}
test('long press temporarily doubles playback and restores exact previous speed, suppressing the release click',()=>{
 const c=setup();pointer(c.media,'pointerdown');assert.equal(c.media.playbackRate,1.25);c.trigger();assert.equal(c.media.playbackRate,2);assert.deepEqual(c.changes,[true]);pointer(c.win,'pointerup');assert.equal(c.media.playbackRate,1.25);assert.equal(pointer(c.media,'click').defaultPrevented,true);assert.deepEqual(c.changes,[true,false]);c.hold.dispose();
});
test('tap, drag, secondary input, paused/buffering media and controls do not start a boost',()=>{
 for(const paused of [true,false]){const c=setup();c.media.paused=paused;pointer(c.media,'pointerdown');pointer(c.media,'pointerup');c.trigger();assert.equal(c.media.playbackRate,1.25);assert.equal(pointer(c.media,'click').defaultPrevented,false);c.hold.dispose();}
 for(const values of [{button:2},{isPrimary:false}]){const c=setup();pointer(c.media,'pointerdown',values);c.trigger();assert.equal(c.media.playbackRate,1.25);c.hold.dispose();}
 const c=setup();pointer(c.media,'pointerdown');pointer(c.media,'pointermove',{clientX:40});c.trigger();assert.equal(c.media.playbackRate,1.25);c.hold.dispose();
});
test('all cancellation paths and disposal restore rate and never resume playback or leak listeners',()=>{
 for(const event of ['pause','ended','waiting','seeking','loadstart','emptied','error','enterpictureinpicture','lostpointercapture','pointercancel','dispose','blur','hidden']){const c=setup();pointer(c.media,'pointerdown');c.trigger();assert.equal(c.hold.active,true,event);if(event==='dispose')c.hold.dispose();else if(event==='blur')c.win.dispatchEvent(new Event('blur'));else if(event==='hidden'){c.doc.hidden=true;c.doc.dispatchEvent(new Event('visibilitychange'));}else pointer(c.media,event);assert.equal(c.media.playbackRate,1.25,event);assert.equal(c.hold.active,false,event);c.hold.dispose();pointer(c.media,'pointerdown');c.trigger();assert.equal(c.media.playbackRate,1.25);}
});
test('heatmap keeps suppressed bins empty, aligns final partial bin and rejects malformed/unbounded data',()=>{
 const graph={scope:'anonymous',available:true,durationMs:25000,binSizeMs:10000,points:[.5,null,1]},shape=heatmapGeometry(graph);assert.equal(shape.peakMs,20000);assert.match(shape.path,/1000.00/);assert.equal((shape.path.match(/M/g)||[]).length,2);
 assert.equal(heatmapGeometry({...graph,scope:'self'}).peakMs,20000);
 for(const extra of [{scope:'personal'},{available:false},{points:[Infinity,0,0]},{points:[1,-1,0]},{points:Array(201).fill(1)},{durationMs:0},{binSizeMs:0}])assert.equal(heatmapGeometry({...graph,...extra}),null);
});
test('graph interaction is idle on playback/hover/focus, visible only while the user manipulates the timeline',()=>{
 const seek=new Media(),win=new EventTarget(),doc=new EventTarget(),changes=[],binding=bindSeekInteraction(seek,{window:win,document:doc,changed:value=>changes.push(value)});
 for(const event of ['timeupdate','seeking','pointerenter','pointermove','focus'])pointer(seek,event);assert.equal(binding.active,false);assert.deepEqual(changes,[]);
 pointer(seek,'pointerdown');assert.equal(binding.active,true);pointer(seek,'input');assert.equal(binding.active,true);pointer(win,'pointerup');assert.equal(binding.active,false);assert.deepEqual(changes,[true,false]);
 pointer(seek,'keydown',{key:'ArrowRight'});assert.equal(binding.active,true);pointer(seek,'input');pointer(seek,'change');assert.equal(binding.active,true,'keyboard range change stays visible until key release');pointer(seek,'keyup',{key:'ArrowRight'});assert.equal(binding.active,false);
 pointer(seek,'input');assert.equal(binding.active,true);pointer(seek,'change');assert.equal(binding.active,false,'assistive input ends on committed change');
 seek.disabled=true;pointer(seek,'pointerdown');assert.equal(binding.active,false);binding.dispose();
});
test('seek cancellation, lost capture, blur, hidden/fullscreen and dispose cannot leave a graph displayed',()=>{
 for(const event of ['pointercancel','lostpointercapture','blur','window-blur','hidden','fullscreenchange','dispose']){
  const seek=new Media(),win=new EventTarget(),doc=new EventTarget(),binding=bindSeekInteraction(seek,{window:win,document:doc});pointer(seek,'pointerdown');assert.equal(binding.active,true,event);
  if(event==='dispose')binding.dispose();else if(event==='window-blur')win.dispatchEvent(new Event('blur'));else if(event==='hidden'){doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));}else if(event==='fullscreenchange')doc.dispatchEvent(new Event(event));else pointer(seek,event);
  assert.equal(binding.active,false,event);binding.dispose();pointer(seek,'pointerdown');assert.equal(binding.active,false,'disposed listener removed');
 }
});
