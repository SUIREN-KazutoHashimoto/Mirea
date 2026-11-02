import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaPreloader} from '../web/src/media-preload.js';
test('prefetch never plays or records a view, bounds its decoder to one and cannot cross an account change',async()=>{
 let current=true,disposed=0;const media=[],attached=[],loader=createMediaPreloader({api:async()=>({url:'/test'}),absoluteUrl:value=>value,scope:'own',current:()=>current,doc:{createElement:tag=>{const value={tag,removeAttribute(){},load(){}};media.push(value);return value;}},attach:(video,options)=>{attached.push(options);return {dispose(){disposed++;}};}});
 await loader.preload({id:'one',kind:'audio'});await loader.preload({id:'two',kind:'video'});assert.equal(disposed,1);assert.equal(media.length,2);assert.equal(media[0].muted,true);assert.equal(attached[0].preload,true);assert.equal(attached[0].onQuality,undefined);assert.equal(loader.take('one'),null);const selected=loader.take('two');assert.equal(selected.video,media[1]);assert.equal(loader.take('two'),null);selected.stream.dispose();
 current=false;await loader.preload({id:'foreign',kind:'audio'});assert.equal(media.length,2);loader.dispose();
});
