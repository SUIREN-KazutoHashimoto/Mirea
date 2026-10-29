import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const a=deferred(),b=deferred(),updates=[],docks=[];let actor={user:{id:'a'}},opens=0;
const context=createContext({Date,Promise,Number});
const imports={
 './api.js':{getSession:()=>actor,getEndpoint:()=> 'https://mirea.test'},
 './offline-vault.js':{offlinePartition:(origin,id)=>origin+'|'+id,offlineVault:async()=>({unseal:partition=>partition.endsWith('|a')?a.promise:b.promise,seal:async()=>{}})},
 './playback-dock.js':{mountPlaybackDock:options=>{docks.push(options);return {update:state=>updates.push(state),dispose(){}};}}
};
const module=new SourceTextModule(await readFile(new URL('../web/src/playback-resume.js',import.meta.url),'utf8'),{context});
await module.link(name=>{const value=imports[name];assert(value,name);return new SyntheticModule(Object.keys(value),function(){for(const [key,item]of Object.entries(value))this.setExport(key,item);},{context});});await module.evaluate();
const begin=id=>module.namespace.restoreStoppedPlayback({items:[{id,title:'Fixture '+id,kind:'audio'}],open:()=>opens++,loadArtwork:async()=>new Blob(['fixture'])});
const first=begin('a');await Promise.resolve();await Promise.resolve();actor={user:{id:'b'}};const second=begin('b');await Promise.resolve();await Promise.resolve();
b.resolve({id:'b',savedAt:Date.now(),positionMs:42000,durationMs:60000});await second;a.resolve({id:'a',savedAt:Date.now(),positionMs:20000,durationMs:60000});await first;
assert.deepEqual(updates.map(value=>value.id),['b']);assert.equal(updates[0].playing,false);assert.equal(opens,0,'restoring must never autoplay');
actor=null;module.namespace.clearPlaybackPresentation();await docks[0].onToggle();assert.equal(opens,0,'an old callback must not reopen a previous account asset');assert.equal(docks[0].loadArtwork({},new AbortController().signal),null);
console.log('paused restore preserves account isolation and never autoplays');
