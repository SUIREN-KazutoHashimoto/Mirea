import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {LIBRARY_REFRESH_MS,pollLibrary,shouldRefreshCatalog,mountLibraryRefresh} from '../web/src/library-refresh.js';

class Node extends EventTarget {
  constructor(){super();this.dataset={};this.attributes=new Map();this.properties=new Map();this.classes=new Set();this.classList={add:n=>this.classes.add(n),remove:n=>this.classes.delete(n),contains:n=>this.classes.has(n)};this.style={setProperty:(k,v)=>this.properties.set(k,v)};this.scrollTop=0;this.scrollWidth=100;this.clientWidth=100;}
  setAttribute(k,v){this.attributes.set(k,v);}removeAttribute(k){this.attributes.delete(k);}append(n){this.child=n;n.parentElement=this;}remove(){this.removed=true;}querySelector(){return this.label??=new Node();}closest(){return this.excluded?this:null;}
}
function clock(){let id=0;const timers=new Map();return {setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),run(){for(const [id,{fn}]of [...timers]){timers.delete(id);fn();}},timers};}
function setup(onRefresh=async()=>({status:'updated'})){
  const main=new Node(),button=new Node(),doc=new Node(),c=clock();doc.createElement=()=>new Node();doc.defaultView=new Node();doc.documentElement=new Node();doc.scrollingElement=new Node();doc.hidden=false;let blocked=false;
  const control=mountLibraryRefresh({main,button,onRefresh,doc,blocked:()=>blocked,...c});
  const touch=(x,y,id=1)=>({clientX:x,clientY:y,identifier:id});
  function emit(type,touches=[],target=main,cancelable=true){const e=new Event(type,{cancelable});Object.defineProperties(e,{touches:{value:touches},target:{value:target}});main.dispatchEvent(e);return e;}
  return {main,button,doc,c,control,touch,emit,indicator:main.child,block:v=>blocked=v,start:(x=100,y=20,target=main)=>emit('touchstart',[touch(x,y)],target),move:(x=100,y=170)=>emit('touchmove',[touch(x,y)]),end:()=>emit('touchend')};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('catalog polls every 60 seconds, skips hidden/offline/busy state and disposes its timer',async()=>{
  let tick,ms,cleared,calls=0,allowed=true;
  const dispose=pollLibrary(()=>calls++,{allowed:()=>allowed,setTimer:(fn,delay)=>{tick=fn;ms=delay;return 9;},clearTimer:id=>cleared=id});
  assert.equal(LIBRARY_REFRESH_MS,60000);assert.equal(ms,60000);assert.equal(calls,0);tick();await settle();assert.equal(calls,1);allowed=false;tick();await settle();assert.equal(calls,1);dispose();assert.equal(cleared,9);
  assert.equal(shouldRefreshCatalog({requested:false}),false,'30-second lease/progress sync must not refresh online catalog');assert.equal(shouldRefreshCatalog({requested:false,wasOffline:true}),true);assert.equal(shouldRefreshCatalog(),true);
});
test('pull tracks distance, arms only beyond threshold, refreshes on release once and suppresses card click',async()=>{
  let calls=0,finish;const s=setup(()=>{calls++;return new Promise(resolve=>finish=resolve);});
  s.start();assert.equal(s.move(100,60).defaultPrevented,true);assert.equal(s.indicator.dataset.state,'pulling');assert.equal(s.indicator.properties.get('--pull-distance'),'20px');
  s.move(100,160);assert.equal(s.indicator.dataset.state,'armed');assert.equal(calls,0);s.end();await settle();assert.equal(calls,1);assert.equal(s.indicator.dataset.state,'refreshing');assert.equal(s.control.active,true);assert.equal(s.button.disabled,true);
  const click=new Event('click',{cancelable:true});s.main.dispatchEvent(click);assert.equal(click.defaultPrevented,true);s.button.dispatchEvent(new Event('click'));s.start();s.move();s.end();await settle();assert.equal(calls,1);
  finish({status:'updated'});await settle();assert.equal(s.control.active,false);assert.equal(s.button.disabled,false);assert.equal(s.indicator.dataset.state,'done');s.c.run();assert.equal(s.indicator.dataset.state,'idle');s.control.dispose();assert.equal(s.indicator.removed,true);assert.equal(s.doc.documentElement.classes.size,0);
});
test('short pull, reverse below threshold and ordinary tap do not refresh or interfere with tap',async()=>{
  let calls=0;const s=setup(async()=>{calls++;});
  s.start();s.end();const tap=new Event('click',{cancelable:true});s.main.dispatchEvent(tap);assert.equal(tap.defaultPrevented,false);
  s.start();s.move(100,90);s.end();s.start();s.move(100,170);s.move(100,50);assert.equal(s.indicator.dataset.state,'pulling');s.end();await settle();assert.equal(calls,0);s.control.dispose();
});
test('horizontal, upward, multi-touch, scrolled, nested scroll and form gestures are never intercepted',async()=>{
  let calls=0;const s=setup(async()=>calls++);
  s.start();assert.equal(s.move(150,25).defaultPrevented,false);s.move();s.end();
  s.start();s.move(100,0);s.move();s.end();s.start();s.emit('touchmove',[s.touch(100,160),s.touch(150,160,2)]);s.end();
  s.doc.scrollingElement.scrollTop=20;s.start();assert.equal(s.move().defaultPrevented,false);s.end();s.doc.scrollingElement.scrollTop=0;
  const nested=new Node();nested.scrollTop=20;nested.parentElement=s.main;s.start(100,20,nested);s.move();s.end();
  const form=new Node();form.excluded=true;s.start(100,20,form);s.move();s.end();
  const tabs=new Node();tabs.classes.add('tabs');tabs.scrollWidth=200;tabs.parentElement=s.main;s.start(100,20,tabs);s.move();s.end();
  s.start();assert.equal(s.emit('touchmove',[s.touch(100,170)],s.main,false).defaultPrevented,false);s.end();await settle();assert.equal(calls,0);s.control.dispose();
});
test('touch cancellation, visibility, blur, resize, blocked viewer/drawer and offscreen start cancel pulls',async()=>{
  let calls=0;const s=setup(async()=>calls++);
  for(const cancel of [()=>s.emit('touchcancel'),()=>s.doc.dispatchEvent(new Event('visibilitychange')),()=>s.doc.defaultView.dispatchEvent(new Event('blur')),()=>s.doc.defaultView.dispatchEvent(new Event('resize')),()=>s.block(true)]){s.start();s.move();cancel();s.end();s.block(false);}
  s.doc.hidden=true;s.start();s.move();s.end();s.doc.hidden=false;s.block(true);s.button.dispatchEvent(new Event('click'));await settle();assert.equal(calls,0);s.control.dispose();
});
test('refresh button shares pending guard and reports offline/failure without hanging or retry loop',async()=>{
  for(const result of [{status:'offline'},{status:'failed'},new Error('network')]){
    let calls=0;const s=setup(async()=>{calls++;if(result instanceof Error)throw result;return result;});s.button.dispatchEvent(new Event('click'));s.button.dispatchEvent(new Event('click'));await settle();assert.equal(calls,1);assert.equal(s.control.active,false);assert.equal(s.button.disabled,false);assert.equal(s.indicator.dataset.state,result.status==='offline'?'done':'failed');assert.match(s.indicator.label.textContent,result.status==='offline'?/オフライン/:/更新できません/);s.c.run();assert.equal(s.indicator.dataset.state,'idle');s.control.dispose();
  }
});
test('dispose cancels listeners and late completion cannot recreate UI or alter next account shell',async()=>{
  let finish,calls=0;const s=setup(()=>{calls++;return new Promise(resolve=>finish=resolve);});s.button.dispatchEvent(new Event('click'));await settle();s.control.dispose();s.button.disabled='sentinel';finish({status:'updated'});await settle();assert.equal(s.button.disabled,'sentinel');assert.equal(s.c.timers.size,0);s.button.dispatchEvent(new Event('click'));await settle();assert.equal(calls,1);
});
test('manual refresh preserves collection view, reconnects with deadline, separates catalog from periodic sync and preserves button-only drawer',async()=>{
  const main=await readFile(new URL('../web/src/main.js',import.meta.url),'utf8'),css=await readFile(new URL('../web/src/library-refresh.css',import.meta.url),'utf8');
  const manual=main.slice(main.indexOf('async function refreshManually'),main.indexOf('function selectShelf'));
  for(const text of ['connectionBudget({ms:2500})','sessionRevision()','reconnectSession({signal:budget.signal})','refresh({background:true})','synchronizeConnection({refreshLibrary:false})'])assert.ok(manual.includes(text),text);
  assert.doesNotMatch(manual,/activeSeries\s*=|activeShelf\s*=|filter\s*=|search\s*=|sort\s*=/);
  assert.ok(main.includes('setInterval(()=>synchronizeConnection({refreshLibrary:false}),30000)'));assert.ok(main.includes('shouldRefreshCatalog({requested:refreshLibrary,wasOffline})'));assert.ok(main.includes('!pullRefresh?.active'));assert.doesNotMatch(main,/libraryPoll=setInterval/);
  assert.match(css,/overscroll-behavior-y:contain/);assert.match(css,/prefers-reduced-motion:reduce/);
  const drawer=await readFile(new URL('../web/src/library-interactions.js',import.meta.url),'utf8');assert.doesNotMatch(drawer.slice(0,drawer.indexOf('export function mountAssetHold')),/touchmove|pointermove/);
});
