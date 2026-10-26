import test from 'node:test';
import {customThumbnailRevision} from '../server/custom-thumbnails.js';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.js';
import {createCatalogCache,normalizeCatalog,offlineCollection,offlineSeriesContext} from '../web/src/offline-catalog.js';
import {createOfflineVault,OFFLINE_MS} from '../web/src/offline-vault.js';
import {collectionEntries} from '../web/src/library-collection.js';

function fixture(){
 const userId=randomUUID(),shelfId=randomUUID(),root=randomUUID(),child=randomUUID(),one=randomUUID(),two=randomUUID();
 const catalog={version:1,userId,serverTime:1800000000000,shelves:[{id:shelfId,name:'Library',description:'Private shelf',role:'owner',itemCount:2,memberCount:2}],series:[{id:root,shelfId,title:'Parent',parentId:null},{id:child,shelfId,title:'Child',parentId:root}],items:[one,two].map((id,index)=>({id,shelfId,title:'Track '+index,kind:'audio',mimeType:'audio/mp4',pageCount:1,size:1024,createdAt:index,thumbnailUrl:'/api/v1/items/'+id+'/thumbnail',series:{id:child,title:'Child',position:index+1,label:'Track '+index}}))};
 return {catalog,userId,shelfId,root,child,one,two};
}
async function setup(){
 const rows=new Map(),packages=[];let time=1800000000000,mono=0;
 const store={vaultGet:async k=>rows.get(k),vaultPut:async(k,v)=>rows.set(k,structuredClone(v)),vaultInit:async(k,v)=>{if(!rows.has(k))rows.set(k,v);return rows.get(k);},vaultDelete:async k=>rows.delete(k),list:async p=>packages.filter(v=>v.partition===p)};
 const options={wall:()=>time,mono:()=>mono,anchorMap:new Map()},vault=await createOfflineVault(store,options),c=fixture(),partition='https://mirea.test|'+c.userId;
 await vault.saveIdentity('https://mirea.test',{user:{id:c.userId,name:'Private Name'},token:'never-store-bearer',expiresAt:time+30*86400000},true,{});
 return {...c,rows,packages,store,options,vault,partition,cache:createCatalogCache(vault,{now:()=>time}),advance(ms){time+=ms;mono+=ms;},wall(ms){time+=ms;}};
}
test('complete catalog preserves shelves, nested series and order offline, including disabled non-downloaded assets',async()=>{
 const c=await setup();await c.cache.save(c.partition,c.catalog,c.userId);
 const saved=await c.cache.load(c.partition),manifest={id:randomUUID(),assetId:c.one,files:[]};
 const local=offlineCollection(saved,[{assetId:c.one,state:'ready',manifest}],new Set([c.one]));
 assert.equal(local.shelves[0].name,'Library');assert.equal(local.items.length,2);assert.equal(local.items[0].offlineUnavailable,false);assert.equal(local.items[1].offlineUnavailable,true);
 const context=offlineSeriesContext(local,c.one);assert.equal(context.currentIndex,0);assert.equal(context.series.id,c.child);assert.equal(context.items[1].offlineUnavailable,true);
 const root=collectionEntries(local.items,local.series);assert.deepEqual(root.map(s=>s.id),[c.root]);
 const child=collectionEntries(local.items,local.series,{parentId:c.root});assert.deepEqual(child.map(s=>s.id),[c.child]);
 assert.deepEqual(collectionEntries(local.items,local.series,{parentId:c.child}).map(s=>s.item.id),[c.one,c.two]);
 assert.equal((await c.vault.identity('https://mirea.test')).user.id,c.userId,'metadata alone permits offline library startup');
 assert.equal(await c.vault.lease(c.partition,manifest.id),null,'catalog is never a media playback license');
});
test('metadata and covers are encrypted, account/origin isolated, survive restart, expire in seven days and fail closed on clock rollback/logout',async()=>{
 const c=await setup();await c.cache.save(c.partition,c.catalog,c.userId);
 const cover=new Blob([randomBytes(100)],{type:'image/jpeg'});await c.cache.saveCover(c.partition,c.catalog.items[0],cover);
 const raw=JSON.stringify([...c.rows]);for(const privateText of ['Private Name','never-store-bearer','Private shelf','Track 0',c.one])assert(!raw.includes(privateText)||privateText===c.one,'metadata is not plaintext');
 const restarted=await createOfflineVault(c.store,{...c.options,anchorMap:new Map()});assert.equal((await restarted.catalog(c.partition)).items[0].id,c.one);
 assert.equal(await c.cache.load('other|'+c.userId),null);assert.equal(await c.cache.load('https://mirea.test|other'),null);
 assert.deepEqual(new Uint8Array(await(await c.cache.cover(c.partition,c.catalog.items[0])).arrayBuffer()),new Uint8Array(await cover.arrayBuffer()));
 assert.equal(await c.cache.cover(c.partition,{...c.catalog.items[0],thumbnailUrl:c.catalog.items[0].thumbnailUrl+'?revision='+randomUUID()}),null);
 c.advance(OFFLINE_MS-1);assert(await c.vault.identity('https://mirea.test'));c.advance(1);assert.equal(await c.cache.load(c.partition),null);assert.equal(await c.vault.identity('https://mirea.test'),null);
 await c.cache.save(c.partition,{...c.catalog,serverTime:c.options.wall()},c.userId);c.advance(10000);await c.cache.load(c.partition);c.wall(-5000);await assert.rejects(()=>c.cache.load(c.partition),/時計/);assert.equal(await c.cache.load(c.partition),null);
 c.wall(5000);await c.cache.save(c.partition,{...c.catalog,serverTime:c.options.wall()},c.userId);await c.vault.setLoggedOut('https://mirea.test',true);assert.equal(await c.vault.identity('https://mirea.test'),null);
 await c.vault.forget('https://mirea.test',c.userId);await assert.rejects(()=>c.cache.load(c.partition));
});
test('full reconciliation removes revoked/deleted rows and their covers, never resurrects unauthorized downloads or writes stale-account results',async()=>{
 const c=await setup();await c.cache.save(c.partition,c.catalog,c.userId);await c.cache.saveCover(c.partition,c.catalog.items[0],new Blob(['jpeg'],{type:'image/jpeg'}));
 const pending={...c.catalog.items[0],id:randomUUID(),pending:true};assert.equal(normalizeCatalog({...c.catalog,items:[...c.catalog.items,pending]},c.userId).items.length,2);
 const empty={...c.catalog,shelves:[],series:[],items:[]};assert.equal(await c.cache.save(c.partition,empty,c.userId,{current:()=>false}),null);assert.equal((await c.cache.load(c.partition)).items.length,2);
 await assert.rejects(()=>c.cache.save(c.partition,{...c.catalog,userId:randomUUID()},c.userId));assert.equal((await c.cache.load(c.partition)).items.length,2);
 await c.cache.save(c.partition,empty,c.userId);assert.equal(await c.cache.cover(c.partition,c.catalog.items[0]),null);
 const local=offlineCollection(await c.cache.load(c.partition),[{assetId:c.one,state:'ready'}],new Set([c.one]));assert.deepEqual(local.items,[]);
});
test('automatic cover warming includes offscreen/non-downloaded items, retries failures, caps parallelism and cancels context changes',async()=>{
 const c=await setup();const catalog=await c.cache.save(c.partition,c.catalog,c.userId);let calls=0,active=0,max=0,fail=true;
 const fetchCover=async()=>{calls++;active++;max=Math.max(max,active);await new Promise(resolve=>setImmediate(resolve));active--;if(fail)throw Error('unreachable');return new Blob(['jpeg'],{type:'image/jpeg'});};
 assert.equal((await c.cache.syncCovers(c.partition,catalog,fetchCover)).failed,2);fail=false;assert.equal((await c.cache.syncCovers(c.partition,catalog,fetchCover)).saved,2);assert(max<=2);assert.equal(calls,8);
 await c.cache.syncCovers(c.partition,catalog,fetchCover);assert.equal(calls,8,'unchanged covers use encrypted cache');
 c.advance(86400000+1);await c.cache.syncCovers(c.partition,catalog,fetchCover);assert.equal(calls,10);
 let current=true;const result=await c.cache.syncCovers(c.partition,{...catalog,items:catalog.items.map(i=>({...i,thumbnailUrl:i.thumbnailUrl+'?revision='+randomUUID()}))},async()=>{current=false;return new Blob(['bad'],{type:'image/jpeg'});},{current:()=>current});assert.equal(result.saved,0);assert.equal(result.cancelled,true);
});
test('concurrent snapshots serialize and newest snapshot wins; mid-write cancellation cannot overwrite a newer complete tree',async()=>{
 const c=await setup(),original=c.vault.saveCatalog;let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});let first=true;
 c.vault.saveCatalog=async(...args)=>{if(first){first=false;entered();await new Promise(resolve=>{release=resolve;});}return original(...args);};
 const old=c.cache.save(c.partition,c.catalog,c.userId);await waiting;
 const fresh=c.cache.save(c.partition,{...c.catalog,items:[c.catalog.items[1]]},c.userId);release();await Promise.all([old,fresh]);assert.deepEqual((await c.cache.load(c.partition)).items.map(i=>i.id),[c.two]);
});

test('late clock checkpoint cannot overwrite a newer catalog across independent vault instances',async()=>{
 const c=await setup();await c.cache.save(c.partition,c.catalog,c.userId);const second=await createOfflineVault(c.store,c.options);
 const put=c.store.vaultPut;let release,entered,first=true;const waiting=new Promise(resolve=>{entered=resolve;});
 c.store.vaultPut=async(key,value)=>{if(first&&key==='sealed|'+c.partition+'|catalog-clock'){first=false;entered();await new Promise(resolve=>{release=resolve;});}return put(key,value);};
 const reading=c.vault.catalog(c.partition);await waiting;const changed={...c.catalog,items:[c.catalog.items[1]]};const saving=second.saveCatalog(c.partition,changed,c.userId);release();await Promise.all([reading,saving]);assert.deepEqual((await second.catalog(c.partition)).items.map(i=>i.id),[c.two]);
});

test('catalog validation strips secret fields and rejects cross-shelf trees, cycles and remote thumbnail URLs',()=>{
 const c=fixture(),safe=normalizeCatalog({...c.catalog,token:'secret',items:c.catalog.items.map(i=>({...i,key:'secret',filePath:'secret',progress:{page:2,token:'secret'}}))},c.userId);assert(!JSON.stringify(safe).includes('secret'));assert.equal(safe.items[0].progress.page,2);
 for(const input of [{...c.catalog,items:c.catalog.items.map(i=>({...i,thumbnailUrl:'https://evil.test/image'}))},{...c.catalog,series:c.catalog.series.map(s=>({...s,parentId:s.id}))},{...c.catalog,items:c.catalog.items.map(i=>({...i,shelfId:randomUUID()}))}])assert.throws(()=>normalizeCatalog(input,c.userId));
});
test('authenticated server catalog includes all member shelves even with no downloads, nested series, custom cover revisions and only own progress; revocations reconcile atomically',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'mirea-catalog-')),app=await createApp({dataDir,rateLimit:false}),db=new DatabaseSync(join(dataDir,'mirea.sqlite'));t.after(async()=>{db.close();await app.close();await rm(dataDir,{recursive:true,force:true});});
 const req=(path,actor,method='GET',payload)=>app.inject({method,url:'/api/v1'+path,headers:actor?{authorization:'Bearer '+actor.token}:{},payload});
 const register=async name=>(await req('/auth/register',null,'POST',{name,email:name+'@test.invalid',password:'catalog-test-password'})).json();
 const owner=await register('owner'),viewer=await register('viewer'),other=await register('other');
 const shelf=async(name,actor)=>(await req('/shelves',actor,'POST',{name})).json().id;
 const one=await shelf('Shared',owner),two=await shelf('Other member shelf',viewer),foreign=await shelf('Must not leak',other);
 await req('/shelves/'+one+'/members',owner,'POST',{email:viewer.user.email,role:'viewer'});
 const root=(await req('/shelves/'+one+'/series',owner,'POST',{title:'Parent'})).json().series,child=(await req('/shelves/'+one+'/series',owner,'POST',{title:'Child',parentId:root.id})).json().series;
 const asset=randomUUID(),image=randomUUID();db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count,thumbnail_ready) VALUES(?,?,?,'test.pdf','application/pdf',7,?,1,3,1)").run(asset,one,'Book',owner.user.id);db.prepare("INSERT INTO series_items VALUES(?,?,1,'first')").run(child.id,asset);db.prepare('INSERT INTO thumbnail_overrides VALUES(?,?,1)').run(asset,image);
 assert.equal((await req('/library/catalog')).statusCode,401);
 const response=await req('/library/catalog',viewer);assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['cache-control'],'no-store');const catalog=normalizeCatalog(response.json(),viewer.user.id);
 assert.deepEqual(new Set(catalog.shelves.map(s=>s.id)),new Set([one,two]));assert(!JSON.stringify(catalog).includes(foreign));assert.equal(catalog.series.find(s=>s.id===child.id).parentId,root.id);assert.equal(catalog.items[0].series.position,1);assert.equal(catalog.items[0].progress,null);assert(catalog.items[0].thumbnailUrl.endsWith(customThumbnailRevision({image_id:image,updated_at:1})));assert.equal(catalog.items[0].role,'viewer');
 await req('/shelves/'+one+'/members/'+viewer.user.id,owner,'DELETE');const after=normalizeCatalog((await req('/library/catalog',viewer)).json(),viewer.user.id);assert.equal(after.items.length,0);assert.equal(after.series.length,0);assert.deepEqual(after.shelves.map(s=>s.id),[two]);
});
