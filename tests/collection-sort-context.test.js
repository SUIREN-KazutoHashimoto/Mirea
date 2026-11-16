import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionSortKey,loadCollectionSort,saveCollectionSort,createCollectionSortPreferences} from '../web/src/collection-sort.js';
const store=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};};
const base={server:'https://library.example.invalid',userId:'reader-a',shelfId:'shelf-a'};
test('sort persists independently for the account, device, server, shelf, series and playlist',()=>{
 const device=store(),otherDevice=store(),series={...base,seriesId:'series-a'};
 saveCollectionSort('oldest',device,series);saveCollectionSort('size-desc',device,{...base,seriesId:'series-b'});saveCollectionSort('name',device,base);
 assert.equal(loadCollectionSort(device,series,'series'),'oldest');assert.equal(loadCollectionSort(device,{...base,seriesId:'series-b'},'series'),'size-desc');assert.equal(loadCollectionSort(device,base),'name');
 for(const context of [{...series,userId:'reader-b'},{...series,server:'https://other.example.invalid'},{...base,seriesId:'series-c'},{...base,playlistId:'series-a'}])assert.equal(loadCollectionSort(device,context,'series'),'series');
 assert.equal(loadCollectionSort(otherDevice,series,'series'),'series');saveCollectionSort('progress',otherDevice,series);assert.equal(loadCollectionSort(device,series,'series'),'oldest');
 assert.equal(loadCollectionSort(device,{...base,shelfId:'shelf-b'}),'recent');
});
test('the same series has one preference across shelf, all-content and nested navigation; history is separate',()=>{
 const device=store();saveCollectionSort('name-desc',device,{...base,seriesId:'child'});
 assert.equal(loadCollectionSort(device,{...base,shelfId:null,seriesId:'child'},'series'),'name-desc');assert.equal(loadCollectionSort(device,{...base,shelfId:'moved-shelf',seriesId:'child'},'series'),'name-desc');
 assert.notEqual(collectionSortKey({...base,history:true}),collectionSortKey(base));
 assert.equal(collectionSortKey(base),collectionSortKey({...base,server:base.server+'/'}));
 assert.notEqual(collectionSortKey({...base,shelfId:'a|b',seriesId:null}),collectionSortKey({...base,shelfId:'a',seriesId:'b'}));
});
test('legacy unowned global values are not copied into scoped accounts; invalid/blocked storage is safe',()=>{
 const device=store();saveCollectionSort('size-asc',device);assert.equal(loadCollectionSort(device,base),'recent');
 device.setItem(collectionSortKey(base),'unknown');assert.equal(loadCollectionSort(device,base),'recent');
 const denied={getItem(){throw Error('denied');},setItem(){throw Error('denied');}};let context={...base,seriesId:'one'};
 const preferences=createCollectionSortPreferences({storage:denied,context:()=>context});assert.equal(preferences.load('series'),'series');preferences.save('oldest');context={...base,seriesId:'two'};assert.equal(preferences.load('series'),'series');context={...base,seriesId:'one'};assert.equal(preferences.load('series'),'oldest');
 assert.equal(collectionSortKey({...base,userId:undefined}),null);assert.equal(loadCollectionSort(device,{...base,userId:undefined},'series'),'series');
});
