import test from 'node:test';
import assert from 'node:assert/strict';
import {createCatalogResponses} from '../server/catalog-response.js';
import {applyCatalogResponse} from '../web/src/catalog-client.js';

function snapshot(userId='user'){
 return {version:1,userId,serverTime:1800000000000,shelves:[{id:'shelf',role:'owner',private:0,name:'Library'}],series:[{id:'series',title:'Series'}],playlists:[{id:'playlist',assetIds:['asset-0']}],items:Array.from({length:100},(_,n)=>({id:'asset-'+n,title:'Synthetic title '+n,shelfId:'shelf',progress:{positionSeconds:0},thumbnailUrl:'/api/v1/items/asset-'+n+'/thumbnail'}))};
}
test('catalog conditionals exclude clock, include account, and changed records reconstruct full order without sending unchanged rows',()=>{
 const cache=createCatalogResponses(),first=snapshot(),full=cache.respond(first);assert.equal(full.status,200);assert.equal(full.body.etag,full.headers.etag);
 const later={...first,serverTime:first.serverTime+60000},same=cache.respond(later,{ifNoneMatch:full.headers.etag,delta:true});assert.equal(same.status,304);assert.equal(same.headers['x-mirea-server-time'],String(later.serverTime));assert.equal(same.body,undefined);
 const next={...later,items:[...later.items.slice(1,4),{...later.items[0],title:'Renamed',progress:{positionSeconds:42}},...later.items.slice(5),{id:'added',title:'New'}],series:[{id:'series',title:'Renamed series'}],playlists:[{id:'playlist',assetIds:['asset-5']}]};
 const changed=cache.respond(next,{ifNoneMatch:full.headers.etag,delta:true});assert.equal(changed.status,200);assert(changed.body.delta);assert.equal(changed.body.delta.items.upsert.length,2);assert.deepEqual(changed.body.delta.items.remove,['asset-4']);assert.equal(changed.body.delta.items.order.length,100);assert.deepEqual(applyCatalogResponse(full.body,changed.body,first.userId),{...next,etag:changed.headers.etag});
 assert.notEqual(cache.respond(snapshot('other')).headers.etag,full.headers.etag);assert.equal(cache.respond(next,{ifNoneMatch:'"unknown"',delta:true}).body.delta,undefined);
});
test('membership/role/privacy changes force authorized full snapshots and never re-use another account base',()=>{
 for(const shelfChange of [[],[{id:'shelf',role:'viewer',private:0}],[{id:'shelf',role:'owner',private:1}]]){
  const cache=createCatalogResponses(),first=snapshot(),base=cache.respond(first).body,next={...first,shelves:shelfChange,items:shelfChange.length?first.items:[],series:shelfChange.length?first.series:[]};
  const result=cache.respond(next,{ifNoneMatch:base.etag,delta:true});assert.equal(result.body.delta,undefined);assert.deepEqual(result.body.items,next.items);
 }
 const cache=createCatalogResponses(),first=cache.respond(snapshot()).body,other=cache.respond(snapshot('other'),{ifNoneMatch:first.etag,delta:true});assert.equal(other.body.delta,undefined);assert.equal(other.body.userId,'other');
});
test('catalog cache is size/user/age bounded, oversized or evicted bases fall back full and cold exact etags still yield 304',()=>{
 let time=0;const size=Buffer.byteLength(JSON.stringify((({serverTime,...rest})=>rest)(snapshot()))),cache=createCatalogResponses({maxBytes:size*2+100,maxUsers:2,maxAgeMs:1000,now:()=>time});
 const first=cache.respond(snapshot('one')).body;cache.respond(snapshot('two'));cache.respond(snapshot('three'));assert.equal(cache.stats().users,2);assert(cache.stats().bytes<=size*2+100);
 const next={...snapshot('one'),items:snapshot('one').items.map((row,n)=>n===0?{...row,title:'changed'}:row)};assert.equal(cache.respond(next,{ifNoneMatch:first.etag,delta:true}).body.delta,undefined);
 time=1001;const fresh=cache.respond(snapshot('three'));assert.equal(cache.stats().users,1);cache.clear();assert.equal(cache.stats().bytes,0);assert.equal(cache.respond(snapshot('three'),{ifNoneMatch:fresh.headers.etag}).status,304);
 const small=createCatalogResponses({maxBytes:100});small.respond(snapshot());assert.deepEqual(small.stats(),{users:0,bytes:0});
});
