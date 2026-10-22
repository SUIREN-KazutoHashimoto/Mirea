import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mountPlaybackDock} from '../web/src/playback-dock.js';
class Element {
  constructor(){this.attrs=new Map();this.classes=new Set();this.classList={toggle:(name,value)=>value?this.classes.add(name):this.classes.delete(name)};this.style={};this.nodes=new Map();}
  setAttribute(key,value){this.attrs.set(key,value);}removeAttribute(key){this.attrs.delete(key);if(key==='src')delete this.src;}querySelector(key){if(!this.nodes.has(key))this.nodes.set(key,new Element());return this.nodes.get(key);}remove(){this.removed=true;}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('edge dock keeps playback independent of folding, updates actions and progress and revokes artwork on identity changes/disposal',async()=>{
  const doc={body:{append(){}},createElement:()=>new Element()},created=[],revoked=[],pending=[];let restored=0,stopped=0,toggled;
  const dock=mountPlaybackDock({doc,onRestore:()=>restored++,onStop:()=>stopped++,onToggle:s=>{toggled=s.playing;},objectUrl:{createObjectURL:b=>{created.push(b);return 'blob:'+created.length;},revokeObjectURL:u=>revoked.push(u)},loadArtwork:(state,signal)=>new Promise(resolve=>pending.push({state,signal,resolve}))});
  const root=dock.root,state={key:'user-a|asset-a',title:'Track A',playing:true,positionMs:10,durationMs:100};dock.update(state);await tick();pending[0].resolve({cover:'A'});await tick();assert.equal(root.querySelector('img').src,'blob:1');assert.equal(root.querySelector('.dock-track span').style.width,'10%');
  root.querySelector('.dock-fold').onclick();assert(root.classes.has('dock-collapsed'));assert.equal(root.querySelector('.dock-content').inert,true);assert.equal(stopped,0);assert.equal(restored,0);
  dock.update({...state,positionMs:30,playing:false});assert(root.classes.has('dock-collapsed'));assert.equal(root.querySelector('.dock-play').attrs.get('aria-label'),'再生');assert.equal(pending.length,1);
  root.querySelector('.dock-fold').onclick();assert.equal(root.querySelector('.dock-content').inert,false);root.querySelector('.dock-art').onclick();root.querySelector('.dock-play').onclick();assert.equal(restored,1);assert.equal(toggled,false);
  dock.update({...state,key:'user-b|asset-b',title:'Track B'});await tick();assert.deepEqual(revoked,['blob:1']);assert.equal(root.querySelector('img').hidden,true);assert.equal(pending[0].signal.aborted,true);
  dock.update({...state,key:'user-b|asset-c'});await tick();pending[1].resolve({cover:'stale'});await tick();assert.equal(created.length,1);pending[2].resolve({cover:'current'});await tick();assert.equal(created.length,2);
  root.querySelector('.dock-stop').onclick();assert.equal(stopped,1);dock.dispose();assert(root.removed);assert.equal(pending[2].signal.aborted,true);assert.deepEqual(revoked,['blob:1','blob:2']);dock.dispose();assert.equal(revoked.length,2);
});
test('late and failed artwork never reopen a disposed dock; Web and native use the same controls without a full-width banner',async()=>{
  let resolve;const root=new Element(),dock=mountPlaybackDock({doc:{body:{append(){}},createElement:()=>root},loadArtwork:()=>new Promise(r=>resolve=r),objectUrl:{createObjectURL(){assert.fail('late cover');},revokeObjectURL(){}}});dock.update({key:'x',title:'X'});await tick();dock.dispose();resolve({});await tick();assert(root.removed);
  const [native,web,css]=await Promise.all(['../web/src/native-playback.js','../web/src/viewer-shell.js','../web/src/playback-dock.css'].map(p=>readFile(new URL(p,import.meta.url),'utf8')));assert(native.includes('mountPlaybackDock'));assert(web.includes('mountPlaybackDock'));assert(css.includes('right:0'));assert(css.includes('.dock-collapsed{width:32px'));assert(!css.includes('infinite'));assert(css.includes('prefers-reduced-motion:reduce'));
});
