import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlaybackOrder,normalizeModes,loadPlaybackModes,savePlaybackModes} from '../web/src/playback-order.js';
import {coverPalette} from '../web/src/cover-palette.js';
import {createTheme} from '../web/src/theme.js';
const context=(ids=['a','b','c','d'])=>({series:{id:'series'},items:ids.map(id=>({id,kind:id==='book'?'pdf':'audio'})),currentIndex:0});
test('web theme and browser/native appearance receive the same resolved colors on first load and changes',()=>{
 const meta={},root={dataset:{},style:{},ownerDocument:{querySelector:()=>meta}},media=new EventTarget(),values=[];media.matches=false;const theme=createTheme({root,media,storage:{getItem:()=>null,setItem(){}},changed:t=>values.push(t)});assert.equal(meta.content,'#f7f8fb');theme.set('dark');assert.equal(meta.content,'#0d121d');assert.equal(root.style.colorScheme,'dark');assert.deepEqual(values,['light','dark']);theme.dispose();
});
test('series repeat wraps in either direction and ignores books only in media repeat/shuffle mode',()=>{
 const order=createPlaybackOrder({modes:{repeat:'series'}}),ctx=context(['a','book','b']);assert.equal(order.plan(ctx,'b').target.id,'a');assert.equal(order.plan(ctx,'a',-1).target.id,'b');assert.equal(order.plan(context(['a']),'a').target.id,'a');order.setModes({repeat:'off'});assert.equal(order.plan(ctx,'b'),null);assert.equal(order.canMove({...ctx,currentIndex:0},'a'),true);
});
test('shuffle consumes a cycle without duplicates, returns through history and wraps only with series repeat',()=>{
 const order=createPlaybackOrder({modes:{shuffle:true},random:()=>.2}),ctx=context();let current='a';const played=[current];for(let i=0;i<3;i++){const plan=order.plan(ctx,current);assert(plan);current=plan.target.id;assert(plan.commit());played.push(current);}assert.equal(new Set(played).size,4);assert.equal(order.plan(ctx,current),null);assert.equal(order.canMove(ctx,current),false);const previous=order.plan(ctx,current,-1);assert.equal(previous.target.id,played[2]);previous.commit();assert.equal(order.canMove(ctx,previous.target.id),true);const forward=order.plan(ctx,previous.target.id);assert.equal(forward.target.id,current);forward.commit();order.setModes({repeat:'series'});const wrapped=order.plan(ctx,current);assert(wrapped);assert.notEqual(wrapped.target.id,current);
});
test('plans are transactional, mode changes invalidate in-flight choices and changed ACL lists never select removed assets',()=>{
 const order=createPlaybackOrder({modes:{shuffle:true},random:()=>.5}),ctx=context();const ignored=order.plan(ctx,'a');const selected=order.plan(ctx,'a');assert.equal(ignored.target.id,selected.target.id);selected.commit();let current=selected.target.id;const pending=order.plan(ctx,current);order.setModes({repeat:'series'});assert.equal(pending.commit(),false);const allowed=context(['a',current,'new']);const next=order.plan(allowed,current);assert(['a','new'].includes(next.target.id));assert.equal(order.plan({...allowed,series:null},current),null);assert.equal(order.plan(context(['x']),'a'),null);
});
test('mode preferences are bounded and scoped; palettes sample once deterministically and fall back for neutral/missing images',()=>{
 assert.deepEqual(normalizeModes({repeat:'evil',shuffle:1}),{repeat:'off',shuffle:false});const rows=new Map(),storage={getItem:k=>rows.get(k),setItem:(k,v)=>rows.set(k,v)};savePlaybackModes(storage,'user1',{repeat:'one',shuffle:true});assert.equal(loadPlaybackModes(storage,'user1').repeat,'one');assert.equal(loadPlaybackModes(storage,'user2').repeat,'off');const pixels=new Uint8ClampedArray(Array.from({length:128},(_,i)=>i%2?[15,150,240,255]:[210,40,130,255]).flat());const colors=coverPalette(pixels,'asset');assert.deepEqual(colors,coverPalette(pixels,'asset'));assert(colors.some(c=>c[2]===240));assert.equal(coverPalette(new Uint8ClampedArray(1000),'blank').length,3);
});
