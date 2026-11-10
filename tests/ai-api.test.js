import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.js';
import {createAiStore} from '../server/ai-store.js';

async function fixture(t,{beforeAiMutation}={}) {
  const folder=await mkdtemp(join(tmpdir(),'mirea-ai-api-')),admins=[];
  const runtime={supported:async()=>({cpu:true,vulkan:false}),inspect:()=>[],close:async()=>{}};
  const app=await createApp({dataDir:folder,rateLimit:false,serverAdminUserIds:admins,aiEnvironment:{},
    aiRuntime:runtime,aiResolveInput:async()=>({stamp:'synthetic-source',durationMs:90000,pageCount:2}),
    aiAnalyzeUnit:async({unit})=>({tags:['合成'],blocks:[{id:'p'+unit,page:unit+1,text:'合成資料の検索対象',box:[0,0,1,1]}]})});
  if(beforeAiMutation)app.addHook('preHandler',beforeAiMutation);
  const db=new DatabaseSync(join(folder,'mirea.sqlite'));db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{await app.close();db.close();await rm(folder,{recursive:true,force:true});});
  const request=(method,path,user,body,headers={})=>app.inject({method,url:'/api/v1'+path,
    headers:{...(user?{authorization:'Bearer '+user.token}:{}),...headers},...(body?{payload:body}:{})});
  const user=async name=>(await request('POST','/auth/register',null,{email:name+'@example.test',name,password:'synthetic-passphrase'})).json();
  const owner=await user('owner'),other=await user('other');admins.push(owner.user.id);
  const shelf=(await request('POST','/shelves',owner,{name:'Synthetic collection'})).json().id;
  const asset=(title='Synthetic book',mime='application/pdf')=>{
    const id=randomUUID();db.prepare('INSERT INTO items VALUES(?,?,?,?,?,1,?,1,2,1)')
      .run(id,shelf,title,'fixture',mime,owner.user.id);return id;};
  return {app,db,request,owner,other,shelf,asset,store:createAiStore(db)};
}
test('AI mutation rechecks a session revoked after request authentication and before its handler',async t=>{
 let release,started;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
 const c=await fixture(t,{beforeAiMutation:async req=>{if(req.url.endsWith('/ai/tags')){started();await gate;}}}),id=c.asset();
 const pending=c.request('PUT','/items/'+id+'/ai/tags',c.owner,{scope:'shared',revision:0,tags:['Late change']});
 try{await entered;assert.equal((await c.request('POST','/auth/logout',c.owner)).statusCode,204);}finally{release();}
 assert.equal((await pending).statusCode,401);assert.equal(c.db.prepare('SELECT count(*) n FROM asset_tags WHERE asset_id=?').get(id).n,0);
});
test('AI API uses current membership for tags, result editing, private unlock and exports',async t=>{
  const c=await fixture(t),id=c.asset();
  assert.equal((await c.request('PUT','/items/'+id+'/ai/tags',c.owner,{scope:'shared',revision:0,tags:['共有']})).statusCode,200);
  assert.equal((await c.request('GET','/items/'+id+'/ai',c.other)).statusCode,404);
  await c.request('POST','/shelves/'+c.shelf+'/members',c.owner,{email:c.other.user.email,role:'viewer'});
  assert.equal((await c.request('PUT','/items/'+id+'/ai/tags',c.other,{scope:'shared',revision:1,tags:['拒否']})).statusCode,403);
   assert.equal((await c.request('GET','/items/'+id+'/ai/ocr/edits',c.other)).statusCode,403);
  assert.equal((await c.request('PUT','/items/'+id+'/ai/tags',c.other,{scope:'personal',revision:0,tags:['本人専用']})).statusCode,200);
  assert(!(await c.request('GET','/items/'+id+'/ai',c.owner)).json().tags.some(t=>t.label==='本人専用'));
  c.db.prepare('UPDATE shelves SET private=1 WHERE id=?').run(c.shelf);
  assert.equal((await c.request('GET','/items/'+id+'/ai',c.owner)).statusCode,423);
  assert.equal((await c.request('GET','/items/'+id+'/ai/pack',c.owner)).statusCode,423);
  const unlock=(await c.request('POST','/shelves/'+c.shelf+'/unlock',c.owner,{password:'synthetic-passphrase'})).json();
  const headers={'X-Mirea-Shelf-Unlock':unlock.token};
  const pack=await c.request('GET','/items/'+id+'/ai/pack',c.owner,null,headers);
  assert.equal(pack.statusCode,200,pack.body);
  assert(pack.json().expiresAt<=Date.now()+7*86400000);
  assert.equal(pack.json().checksum.length,64);
  await c.request('DELETE','/shelves/'+c.shelf+'/members/'+c.other.user.id,c.owner,null,headers);
  assert.equal((await c.request('GET','/items/'+id+'/ai',c.other)).statusCode,404);
});
test('content search returns location hits and cannot override the authenticated user or data root',async t=>{
  const c=await fixture(t),id=c.asset('Synthetic title'),item=c.db.prepare('SELECT * FROM items WHERE id=?').get(id);
  c.store.publish(item,'ocr','source','model',{blocks:[{id:'b',page:2,text:'架空の資料に含まれる検索用セリフ',box:[0,0,.5,.5]}]},{pageCount:2});
  const search=await c.request('POST','/ai/search',c.owner,{query:'検索用セリフ'});
  assert.equal(search.statusCode,200,search.body);
  assert.equal(search.json().items[0].assetId,id);
  assert.equal(search.json().items[0].hits[0].locator.page,2);
  const foreign=await c.request('POST','/ai/search',c.other,{query:'検索用セリフ',userId:c.owner.user.id,dataDir:'ignored'});
  assert.equal(foreign.statusCode,200,foreign.body);assert.equal(foreign.json().items.length,0);
  c.db.prepare('UPDATE shelves SET private=1 WHERE id=?').run(c.shelf);
  assert.equal((await c.request('POST','/ai/search',c.owner,{query:'検索用セリフ'})).json().items.length,0);
  assert.equal((await c.request('POST','/ai/search',c.owner,{query:'検索用セリフ',scope:{shelfId:c.shelf}})).statusCode,423);
});
test('synthetic analysis is durable, idempotent and runs independently of normal media tasks',async t=>{
  const c=await fixture(t),id=c.asset(),modelId='a'.repeat(64);
  const manifest={id:modelId,key:'fixture',name:'Synthetic engine',repo:'example/fixture',revision:'b'.repeat(40),
    capabilities:['ocr'],engine:'llama',license:'mit',files:[]};
  c.db.prepare("INSERT INTO ai_models VALUES(?,?,'ready','{}',?,1,'accepted',NULL,1)")
    .run(modelId,JSON.stringify(manifest),c.owner.user.id);
  const configured=await c.request('PATCH','/admin/ai/settings',c.owner,{
    currentPassword:'synthetic-passphrase',enabled:true,models:{ocr:modelId}});
  assert.equal(configured.statusCode,200,configured.body);
  const body={features:['ocr'],requestId:randomUUID()};
  const first=await c.request('POST','/items/'+id+'/ai/jobs',c.owner,body);
  assert.equal(first.statusCode,202,first.body);
  assert.deepEqual((await c.request('POST','/items/'+id+'/ai/jobs',c.owner,body)).json(),first.json());
  let result;
  for(let attempt=0;attempt<100;attempt++){
    result=(await c.request('GET','/items/'+id+'/ai',c.owner)).json();
    if(result.jobs[0]?.state==='complete')break;
    await new Promise(yes=>setTimeout(yes,30));
  }
  assert.equal(result.jobs[0].state,'complete',JSON.stringify(result.jobs));
  assert.equal(result.features.ocr.result.blocks.length,1);assert.equal(result.features.ocr.hasMore,true);
  const second=(await c.request('GET','/items/'+id+'/ai/ocr?offset='+result.features.ocr.nextOffset,c.owner)).json();assert.equal(second.result.blocks.length,1);assert.equal(second.hasMore,false);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM media_tasks').get().n,0);
  assert.equal((await c.request('GET','/admin/ai/settings',c.other)).statusCode,403);
});

test('bulk tags, dictionary rename, full paginated export and saved search revisions use current scope',async t=>{
 const c=await fixture(t),first=c.asset('First'),second=c.asset('Second');
 c.db.prepare('UPDATE items SET page_count=30 WHERE id=?').run(first);
 const item=c.db.prepare('SELECT * FROM items WHERE id=?').get(first);
 c.store.publishUnits(item,'ocr','source','model',Array.from({length:30},(_,i)=>({unit:i,value:{blocks:[{id:'b'+i,page:i+1,text:'Synthetic page '+i,box:[0,0,.5,.1]}]}})),{pageCount:30});
 const exported=await c.request('GET','/items/'+first+'/ai/export',c.owner);assert.equal(exported.statusCode,200,exported.body);
 assert.equal((await c.request('GET','/items/'+first+'/ai/packs?feature=ocr&offset=1',c.other)).statusCode,404);
  const saved=(await c.request('GET','/items/'+first+'/ai/packs?feature=ocr&offset=1',c.owner)).json().packs;assert.equal(saved.length,8);assert.deepEqual(saved.map(pack=>pack.offset),[1,2,3,4,5,6,7,8]);assert(saved.every(pack=>pack.checksum.length===64&&pack.assetId===first&&Object.keys(pack.features).length===1));
  assert.equal((await c.request('GET','/items/'+first+'/ai/packs?feature=ocr&offset=-1',c.owner)).statusCode,422);
  assert.equal(exported.json().features.ocr.result.blocks.length,30);assert.equal(exported.json().features.ocr.result.blocks.at(-1).page,30);
 let r=await c.request('POST','/ai/tags/bulk',c.owner,{assetIds:[first,second],scope:'shared',action:'add',tags:['Blue']});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().updated,2);
 const dict=(await c.request('GET','/ai/tags?shelfId='+c.shelf,c.owner)).json();assert.equal(dict.tags[0].count,2);
 r=await c.request('POST','/ai/tags/rename',c.owner,{scope:'shared',shelfId:c.shelf,from:'Blue',to:'Green',revision:dict.revision});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().updated,2);
 assert.equal((await c.request('POST','/ai/search',c.owner,{tags:['Green','Missing'],tagMode:'any'})).json().items.length,2);
 assert.equal((await c.request('POST','/ai/search',c.owner,{tags:['Green','Missing'],tagMode:'all'})).json().items.length,0);
 const list=(await c.request('POST','/ai/lists',c.owner,{title:'Saved',filter:{tags:['Green']}})).json();
 r=await c.request('PATCH','/ai/lists/'+list.id,c.owner,{title:'Changed',filter:{query:'Synthetic'},revision:1});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().revision,2);
 assert.equal((await c.request('PATCH','/ai/lists/'+list.id,c.owner,{title:'Stale',filter:{},revision:1})).statusCode,409);
 assert.equal((await c.request('POST','/ai/search',c.owner,{scope:[]})).statusCode,422);
 assert.equal((await c.request('GET','/ai/jobs?offset=0.5',c.owner)).statusCode,422);
 assert.equal((await c.request('PATCH','/items/'+first+'/ai/ocr',c.owner,{requestId:randomUUID(),revision:0,resultRevision:1,patch:{blocks:{b0:{hidden:true,text:{invalid:true}}}}})).statusCode,422);
});
