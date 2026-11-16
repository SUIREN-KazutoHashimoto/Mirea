import test from 'node:test';
import assert from 'node:assert/strict';
import {mountDrawerSwipe} from '../web/src/drawer-swipe.js';
const event=(type,props={},cancelable=true)=>{const e=new Event(type,{cancelable});for(const [key,value]of Object.entries(props))Object.defineProperty(e,key,{value});return e;};
function setup(){
 const doc=new EventTarget(),win=new EventTarget(),layout=new EventTarget(),frames=new Map();let time=0,serial=0,open=false,enabled=true;const progress=[],results=[];let starts=0;
 win.requestAnimationFrame=fn=>{frames.set(++serial,fn);return serial;};win.cancelAnimationFrame=id=>frames.delete(id);win.getComputedStyle=node=>({overflowX:node.overflowX??'visible'});doc.defaultView=win;doc.getSelection=()=>({isCollapsed:true});layout.ownerDocument=doc;layout.getBoundingClientRect=()=>({left:0});const panel={getBoundingClientRect:()=>({width:300})},target={closest:()=>null,parentElement:layout,scrollWidth:0,clientWidth:0};
 const swipe=mountDrawerSwipe({layout,panel,doc,win,enabled:()=>enabled,isOpen:()=>open,now:()=>time,onStart:()=>starts++,onProgress:reveal=>progress.push(reveal),onFinish:(value,info)=>{open=value;results.push({value,...info});}});
 const flush=()=>{for(const [id,fn]of [...frames]){frames.delete(id);fn();}},touch=(x,y=200)=>({identifier:7,clientX:x,clientY:y});
 const start=(x=12,y=200,node=target)=>{const e=event('touchstart',{touches:[touch(x,y)],target:node});doc.dispatchEvent(e);layout.dispatchEvent(e);return e;};
 const move=(x,y=200,ms=20,cancelable=true)=>{time+=ms;const e=event('touchmove',{touches:[touch(x,y)],target},cancelable);doc.dispatchEvent(e);flush();return e;};
 const end=(x,y=200,ms=200)=>{time+=ms;doc.dispatchEvent(event('touchend',{touches:[],changedTouches:[touch(x,y)],target}));flush();};
 return {doc,win,layout,target,start,move,end,flush,swipe,progress,results,frames,get starts(){return starts;},get open(){return open;},set open(v){open=v;},set enabled(v){enabled=v;}};
}
test('drawer follows distance, clamps movement, settles partial drags and suppresses the release click without losing the next tap',()=>{
 const c=setup();c.start();const moving=c.move(120);assert(moving.defaultPrevented);assert.equal(c.progress.at(-1),108);assert(c.swipe.isDragging());c.end(120);assert.equal(c.open,false);assert.equal(c.results.at(-1).cancelled,false);
 c.start();c.move(250);c.end(250);assert(c.open);const ghost=event('click',{detail:1,target:c.target});c.layout.dispatchEvent(ghost);assert(ghost.defaultPrevented);
 c.start(200);c.end(200);const nextTap=event('click',{detail:1,target:c.target});c.layout.dispatchEvent(nextTap);assert(!nextTap.defaultPrevented);
 c.open=false;c.start();c.move(800);assert.equal(c.progress.at(-1),300);c.end(800);assert(c.open);c.swipe.dispose();
});
test('slow drags use the midpoint; deliberate short flicks and a final reverse movement use recent velocity',()=>{
 const c=setup();c.start();c.move(70,200,40);c.end(70,200,5);assert(c.open,'quick opening flick');
 c.start(220);c.move(170,200,35);c.end(170,200,5);assert(!c.open,'quick closing flick');
 c.start();c.move(250,200,200);c.move(200,200,40);c.end(200,200,5);assert(!c.open,'reverse flick closes even beyond half');
 c.open=true;c.start(250);c.move(180,200,200);c.end(180,200,200);assert(c.open,'partial slow close returns open');c.start(250);c.move(30,200,200);c.end(30);assert(!c.open);c.swipe.dispose();
});
test('vertical scrolling, forms, horizontal scrollers, outside-edge starts, disabled views and noncancelable browser gestures are untouched',()=>{
 for(const mode of ['vertical','form','scroll','selection','outside','disabled','noncancelable']){const c=setup();let target=c.target,x=12;if(mode==='form')target={...target,closest:()=>({})};if(mode==='scroll')target={...target,scrollWidth:500,clientWidth:100,overflowX:'auto'};if(mode==='selection')c.doc.getSelection=()=>({isCollapsed:false});if(mode==='outside')x=150;if(mode==='disabled')c.enabled=false;c.start(x,200,target);const e=mode==='vertical'?c.move(16,300):c.move(220,200,20,mode!=='noncancelable');c.end(220);assert(!e.defaultPrevented,mode);assert.equal(c.starts,0,mode);assert.equal(c.results.length,0,mode);c.swipe.dispose();}
});
test('multitouch, touch cancellation, blur, visibility, resize, modal changes and disposal restore the initial state and cancel pending frames',()=>{
 for(const mode of ['multi','touchcancel','blur','visibility','resize','disabled','dispose']){const c=setup();c.start();c.move(100);if(mode==='multi')c.doc.dispatchEvent(event('touchstart',{touches:[{},{}]}));else if(mode==='touchcancel')c.doc.dispatchEvent(new Event('touchcancel'));else if(mode==='blur')c.win.dispatchEvent(new Event('blur'));else if(mode==='visibility')c.doc.dispatchEvent(new Event('visibilitychange'));else if(mode==='resize')c.win.dispatchEvent(new Event('resize'));else if(mode==='disabled'){c.enabled=false;c.move(200);}else c.swipe.dispose();assert(!c.swipe.isDragging(),mode);assert.equal(c.frames.size,0,mode);assert(!c.open,mode);if(mode!=='dispose')assert.equal(c.results.at(-1).cancelled,true,mode);c.end(250);assert(!c.open,mode);c.swipe.dispose();}
 const c=setup();c.open=true;c.start(220);c.move(80);c.doc.dispatchEvent(new Event('touchcancel'));assert(c.open,'cancelled close returns to open');c.swipe.dispose();
});

test('a contact that began while a popup or input blocked navigation stays blocked after it closes',()=>{const c=setup();c.enabled=false;c.doc.dispatchEvent(event('pointerdown',{pointerType:'touch'}));c.enabled=true;c.start();c.move(250);c.end(250);assert(!c.open);assert.equal(c.starts,0);c.doc.dispatchEvent(event('pointerdown',{pointerType:'touch'}));c.start();c.move(250);c.end(250);assert(c.open);c.swipe.dispose();});
