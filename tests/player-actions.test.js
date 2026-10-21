import test from 'node:test';import assert from 'node:assert/strict';
import {playerKey,chapterAt,chapterJump,spriteFrame} from '../web/src/player-actions.js';
test('keyboard parity respects modifier keys, 5-second focused timeline and paused-only frame steps',()=>{
 for(const [key,intent] of [['j',['seek',-10]],['L',['seek',10]],['9',['fraction',.9]],['>', ['speed',.25]],['<',['speed',-.25]],['i',['minimize']],['c',['captions']]])assert.deepEqual(playerKey({key}),intent);
 assert.deepEqual(playerKey({key:'ArrowRight'},{seekFocused:true}),['seek',5]);assert.deepEqual(playerKey({key:'n',shiftKey:true}),['navigate',1]);assert.deepEqual(playerKey({key:'ArrowLeft',ctrlKey:true}),['chapter',-1]);assert.equal(playerKey({key:'.'}),null);assert.deepEqual(playerKey({key:'.'},{paused:true}),['frame',1]);assert.equal(playerKey({key:'j',altKey:true}),null);
});
test('scene lookup and chapters clamp at boundaries without inventing unavailable scenes',()=>{
 const chapters=[{startMs:0,title:'First'},{startMs:20000,title:'Second'}],sheet={count:3,columns:2,width:160,height:90,intervalMs:10000};assert.equal(chapterAt(chapters,21).title,'Second');assert.equal(chapterJump(chapters,3,1),20);assert.equal(chapterJump(chapters,20,-1),0);assert.deepEqual(spriteFrame(sheet,1000),{index:2,x:0,y:90});assert.equal(spriteFrame(sheet,-1).index,0);
});
