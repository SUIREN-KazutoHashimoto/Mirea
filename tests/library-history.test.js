import test from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryHistory} from '../web/src/library-history.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(initial){const host=new EventTarget(),entries=[initial??{}];let index=0,backs=0;host.history={get state(){return entries[index];},replaceState(state){entries[index]=state;},pushState(state){entries.splice(++index);entries[index]=state;},back(){backs++;if(index>0){index--;const event=new Event('popstate');event.state=entries[index];host.dispatchEvent(event);}}};return {host,entries,get backs(){return backs;}};}
test('library browser history preserves previous route and scroll, then restores it without pushing another entry',async()=>{
 const h=harness();let view={series:'',y:900},scope='user-a';const nav=createLibraryHistory({host:h.host,scope:()=>scope,read:()=>({...view}),restore:async next=>{view=next;nav.update();}});await nav.ready();const finish=nav.begin();view={series:'child',y:0};nav.update();finish();assert.equal(h.entries.length,2);assert.equal(h.entries[0].mirea.view.y,900);h.host.history.back();await tick();assert.deepEqual(view,{series:'',y:900});assert.equal(h.entries.length,2);scope='user-b';await nav.ready();h.host.history.back();assert.equal(view.series,'');nav.dispose();
});
test('same account reload restores a viewer route, and explicit viewer close returns to library entry',async()=>{
 const h=harness({mirea:{scope:'user-a',view:{series:'chapter',viewer:'book'}}});let view={};const nav=createLibraryHistory({host:h.host,scope:()=> 'user-a',read:()=>({...view}),restore:async next=>{view=next;}});await nav.ready();assert.equal(view.viewer,'book');view={series:'chapter',viewer:null};nav.closedViewer();assert.equal(h.backs,1);nav.dispose();
});

test('rapid browser Back ignores a slower superseded restoration and account changes invalidate pending state',async()=>{
  const h=harness(),pending=[];let view={series:'root'},scope='a';const nav=createLibraryHistory({host:h.host,scope:()=>scope,read:()=>({...view}),restore:(next,{isCurrent})=>new Promise(resolve=>pending.push(()=>{if(isCurrent())view=next;resolve();}))});await nav.ready();
  for(const series of ['child','grandchild']){const finish=nav.begin();view={series};finish();}h.host.history.back();h.host.history.back();pending[1]();await tick();pending[0]();await tick();assert.equal(view.series,'root');assert.equal(h.host.history.state.mirea.view.series,'root');
  const event=new Event('popstate');event.state={mirea:{scope:'a',view:{series:'old-account'}}};h.host.dispatchEvent(event);scope='b';view={series:'new-account'};await nav.ready();pending[2]();await tick();assert.equal(view.series,'new-account');const finish=nav.begin();view={series:'next'};finish();assert.equal(h.host.history.state.mirea.scope,'b');assert.equal(h.host.history.state.mirea.view.series,'next');nav.dispose();
});
