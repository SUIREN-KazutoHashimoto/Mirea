import test from 'node:test';
import assert from 'node:assert/strict';
import {reorderPlaylist,movePlaylistEntry} from '../web/src/playlist-order.js';
import {loadCollectionView,saveCollectionView} from '../web/src/collection-view.js';
test('playlist bulk ordering uses natural title order and supports direct moves without modifying draft input',()=>{
  const ids=['a','b','c'],items=[{id:'a',title:'Track 10'},{id:'b',title:'Track 2'},{id:'c',title:'Track 1'}];
  assert.deepEqual(reorderPlaylist(ids,items,'asc'),['c','b','a']);assert.deepEqual(reorderPlaylist(ids,items,'desc'),ids);assert.deepEqual(movePlaylistEntry(ids,2,1),['c','a','b']);assert.deepEqual(ids,['a','b','c']);assert.throws(()=>movePlaylistEntry(ids,0,0));assert.throws(()=>movePlaylistEntry(ids,0,4));
});
test('collection view is remembered independently by account and location with a legacy default',()=>{
  const rows=new Map(),store={getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,v)};
  saveCollectionView({layout:'list',details:'compact'},store);assert.equal(loadCollectionView(store,'account|shelf-a').layout,'list');
  saveCollectionView({layout:'grid5',details:'full'},store,'account|shelf-a');assert.equal(loadCollectionView(store,'account|shelf-a').layout,'grid5');assert.equal(loadCollectionView(store,'account|shelf-b').layout,'list');assert.equal(loadCollectionView(store,'other-account|shelf-a').layout,'list');
});
