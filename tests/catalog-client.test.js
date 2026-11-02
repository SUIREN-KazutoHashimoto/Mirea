import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCatalogResponse,createCatalogClient} from '../web/src/catalog-client.js';
const full=(etag='"one"')=>({version:1,userId:'user',serverTime:1000,etag,shelves:[{id:'s'}],items:[{id:'a',pending:true},{id:'b',title:'B'}],series:[],playlists:[]});
const delta=()=>({version:1,userId:'user',serverTime:2000,etag:'"two"',baseEtag:'"one"',delta:Object.fromEntries(['shelves','items','series','playlists'].map(name=>[name,{upsert:[],remove:[]}]))});
test('conditional catalog preserves untouched rows and applies removals, updates and explicit ordering without mutating its base',()=>{
  const base=full(),change=delta();change.delta.items={upsert:[{id:'c',title:'C'},{id:'b',title:'changed'}],remove:['a'],order:['c','b']};const next=applyCatalogResponse(base,change,'user');assert.deepEqual(next.items,[{id:'c',title:'C'},{id:'b',title:'changed'}]);assert.equal(next.shelves,base.shelves);assert.deepEqual(base.items,[{id:'a',pending:true},{id:'b',title:'B'}]);
  assert.equal(applyCatalogResponse(base,{notModified:true,etag:'"one"',serverTime:2000},'user').items,base.items);assert.equal(applyCatalogResponse(base,{notModified:true,etag:'"other"',serverTime:2000},'user'),null);assert.equal(applyCatalogResponse(base,change,'another'),null);change.delta.items.order=['c','c'];assert.equal(applyCatalogResponse(base,change,'user'),null);
});
test('client sends conditional headers, handles 304 and falls back to a full request for an invalid base',async()=>{
  const calls=[],responses=[full(),{notModified:true,etag:'"one"',serverTime:2000},{...delta(),baseEtag:'"missing"'},full('"three"')];const client=createCatalogClient({scope:()=> 'server/user',request:async(path,options)=>{calls.push({path,options});return responses.shift();}});
  const a=await client.fetch({userId:'user'}),b=await client.fetch({userId:'user'}),c=await client.fetch({userId:'user'});assert.equal(b.unchanged,true);assert.equal(a.catalog.items,b.catalog.items);assert.equal(c.catalog.etag,'"three"');assert.deepEqual(calls.map(c=>c.path),['/library/catalog','/library/catalog?delta=1','/library/catalog?delta=1','/library/catalog']);assert.equal(calls[1].options.headers['If-None-Match'],'"one"');assert.equal(calls[3].options.headers,undefined);assert(calls.every(c=>c.options.allowNotModified));
});
test('new accounts never reuse old conditional state, and a late response cannot overwrite a newer request',async()=>{
  let scope='a',release;const calls=[];const client=createCatalogClient({scope:()=>scope,request:async(path,options)=>{calls.push(options);if(calls.length===2)return new Promise(resolve=>release=resolve);return full();}});await client.fetch({userId:'user'});const late=client.fetch({userId:'user'});scope='b';await client.fetch({userId:'user'});release(full('"stale"'));await assert.rejects(late,{name:'AbortError'});assert.equal(calls[2].headers,undefined);client.clear();await client.fetch({userId:'user'});assert.equal(calls[3].headers,undefined);
});
