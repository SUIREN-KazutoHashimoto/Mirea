import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {connectionBudget} from '../web/src/connection-budget.js';
import {createLoginStore} from '../web/src/session-store.js';
import {shellResponse} from '../web/src/offline-shell.js';
import {libraryBackAction} from '../web/src/library-back.js';
import {showAppLaunch} from '../web/src/app-launch.js';
import {mountAudioMotion} from '../web/src/audio-motion.js';

const stalled=signal=>new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
test('one startup deadline interrupts unreachable remembered-session requests; offline does not wait, credentials are not cleared',async()=>{
  let cleared=0,observed;const store=createLoginStore({native:false,temporary:()=>null,request:async(path,{signal}={})=>{observed=signal;return stalled(signal);},secure:{clear:()=>cleared++}});
  const start=performance.now(),budget=connectionBudget({ms:35});await assert.rejects(()=>store.load('',{signal:budget.signal}));assert.equal(observed,budget.signal);assert.ok(performance.now()-start<600);assert.equal(cleared,0);budget.dispose();
  const offline=connectionBudget({online:false});assert.equal(offline.signal.aborted,true);await assert.rejects(()=>store.load('',{signal:offline.signal}));offline.dispose();
  let callback,cancelled=false;const aggregate=connectionBudget({setTimer:fn=>{callback=fn;return 1;},clearTimer:()=>cancelled=true});assert.equal(aggregate.signal.aborted,false);callback();assert.equal(aggregate.signal.aborted,true);aggregate.dispose();assert.equal(cancelled,true);
});
test('saved static shell loads without network; stalled navigation falls back quickly without caching API or media',async()=>{
  let requests=0;const cached=()=>new Response('saved shell');
  for(const args of [{navigate:false,online:true},{navigate:true,online:false}]){
    const response=await shellResponse(new Request('https://mirea.test/'),{...args,findCached:async()=>cached(),network:()=>{requests++;throw Error();}});assert.equal(await response.text(),'saved shell');
  }
  assert.equal(requests,0);const start=performance.now();const response=await shellResponse(new Request('https://mirea.test/'),{navigate:true,ms:30,findCached:async()=>cached(),network:(_,options)=>stalled(options.signal)});assert.equal(await response.text(),'saved shell');assert.ok(performance.now()-start<600);
  const fresh=await shellResponse(new Request('https://mirea.test/'),{navigate:true,findCached:async()=>cached(),network:async()=>new Response('fresh')});assert.equal(await fresh.text(),'fresh','deadline cleanup must not abort response body');
  const empty=await shellResponse(new Request('https://mirea.test/'),{navigate:true,findCached:async()=>null,network:async()=>{throw Error();}});assert.equal(empty.status,503);
  const worker=await readFile(new URL('../web/src/download-sw.js',import.meta.url),'utf8');assert.ok(worker.includes("url.pathname.startsWith('/api/')"));assert.ok(worker.includes('shellResponse(event.request'));assert.ok(worker.includes('encryptedRangeResponse'));
});
test('Android Back prioritizes overlays, returns from series before opening drawer, never exits the collection',()=>{
  const base={collection:true,canGoBack:true};assert.equal(libraryBackAction(base),'drawer-open');assert.equal(libraryBackAction({...base,series:true}),'series-parent');assert.equal(libraryBackAction({...base,series:true,viewer:true}),'viewer-return');assert.equal(libraryBackAction({...base,viewer:true,modal:true}),'modal-close');assert.equal(libraryBackAction({...base,modal:true,drawer:true}),'drawer-close');assert.equal(libraryBackAction({canGoBack:true}),'history');assert.equal(libraryBackAction(),'minimize');
});
class Node extends EventTarget{constructor(){super();this.classes=new Set();this.classList={toggle:(n,on)=>on?this.classes.add(n):this.classes.delete(n),add:n=>this.classes.add(n),remove:n=>this.classes.delete(n)};}setAttribute(){}remove(){this.removed=true;}}
function clock(){let time=0,id=0;const tasks=new Map();return {now:()=>time,setTimer:(fn,delay)=>{tasks.set(++id,{fn,at:time+delay});return id;},clearTimer:id=>tasks.delete(id),advance(ms){const end=time+ms;for(;;){const next=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;time=next[1].at;tasks.delete(next[0]);next[1].fn();}time=end;}};}
test('native launch uses adopted local logo, finishes early, has hard cap and supports reduced motion; web/PWA uses the same one-second minimum',()=>{
  for(const reduced of [false,true]){const c=clock();let node;const doc={createElement:()=>new Node(),body:{append:n=>node=n}};const finish=showAppLaunch({native:true,doc,reduced,...c});assert.ok(node.innerHTML.includes('/brand/orbit-mark.svg'));finish();c.advance(1000+(reduced?0:180));assert.equal(node.removed,true);finish();}
  const c=clock();let node;showAppLaunch({native:true,doc:{createElement:()=>new Node(),body:{append:n=>node=n}},reduced:false,...c});c.advance(1680);assert.equal(node.removed,true,'unreachable startup can never leave splash stuck');const web=clock();let webNode;const done=showAppLaunch({native:false,doc:{createElement:()=>new Node(),body:{append:n=>webNode=n}},reduced:false,...web});done();web.advance(999);assert.ok(!webNode.removed);web.advance(181);assert.equal(webNode.removed,true);
});
test('audio glow only moves while visible foreground media plays; pause, minimize, reduced motion and disposal stop it',()=>{
  const root=new Node(),media=new EventTarget(),doc=new EventTarget(),screen=new EventTarget(),preference=new EventTarget();media.paused=true;doc.hidden=false;preference.matches=false;const dispose=mountAudioMotion(root,media,{doc,screen,preference});const moving=()=>root.classes.has('audio-motion');assert.equal(moving(),false);
  media.paused=false;media.dispatchEvent(new Event('playing'));assert.equal(moving(),true);doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(moving(),false);doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(moving(),true);screen.isMinimized=true;screen.dispatchEvent(new Event('viewer:presentation'));assert.equal(moving(),false);screen.isMinimized=false;screen.dispatchEvent(new Event('viewer:presentation'));assert.equal(moving(),true);preference.matches=true;preference.dispatchEvent(new Event('change'));assert.equal(moving(),false);preference.matches=false;preference.dispatchEvent(new Event('change'));media.paused=true;media.dispatchEvent(new Event('pause'));assert.equal(moving(),false);dispose();media.paused=false;media.dispatchEvent(new Event('playing'));assert.equal(moving(),false);
});
test('startup and navigation are wired to shared deadlines and parent navigation, preserving 7-day vault authorization',async()=>{
  const main=await readFile(new URL('../web/src/main.js',import.meta.url),'utf8');for(const expected of ['initializeSession({signal:budget.signal})','await refresh({background:offlineLibrary})',"action==='series-parent'",'leaveLibrarySeries','series-folder-header','finishAppLaunch()','!isOfflineSession()','libraryPoll=pollLibrary'])assert.ok(main.includes(expected),expected);
  const api=await readFile(new URL('../web/src/api.js',import.meta.url),'utf8');assert.ok(api.includes("api('/auth/me',{signal})"));assert.ok(api.includes('options.signal?.throwIfAborted()'));assert.ok(api.includes('offlineIdentity(origin,session?.user.id)'));
});

test('real session bootstrap falls back within its shared deadline for both clients, including stalled JSON, without bypassing denial or expired grants',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--experimental-vm-modules','--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./session-bootstrap-fixture.mjs',import.meta.url))],{windowsHide:true,timeout:8000});assert.equal(JSON.parse(stdout).denialDoesNotFallback,true);
});
