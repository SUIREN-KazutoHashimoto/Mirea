import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';
import * as fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('an older generation manifest cannot delete a concurrently requested newer download registration',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE encrypted_downloads(id TEXT PRIMARY KEY,user_id TEXT,asset_id TEXT,manifest_json TEXT,created_at INTEGER); CREATE TABLE media_ingest(asset_id TEXT,canonical_ready INTEGER); CREATE TABLE video_assets(item_id TEXT PRIMARY KEY,metadata_json TEXT,original_retained INTEGER); CREATE TABLE video_generations(item_id TEXT,generation TEXT,metadata_json TEXT);');
 const asset=randomUUID(),oldGeneration=randomUUID(),newGeneration=randomUUID(),oldRead=deferred(),release=deferred();let delayed=false;
 const item={id:asset,title:'Synthetic generation',size:20,mime_type:'video/mp4',page_count:1};
 const metadata=generation=>({generation,renditions:[{quality:'720p',size:20}]});
 db.prepare('INSERT INTO video_assets VALUES(?,?,1)').run(asset,JSON.stringify(metadata(oldGeneration)));
 db.prepare('INSERT INTO video_generations VALUES(?,?,?)').run(asset,oldGeneration,JSON.stringify(metadata(oldGeneration)));
 const original=Object.getOwnPropertyDescriptor(globalThis,'__downloadRegistrationFixture');
 globalThis.__downloadRegistrationFixture={...fs,stat:async path=>{if(String(path).includes(oldGeneration)&&!delayed){delayed=true;oldRead.resolve();await release.promise;}return {isFile:()=>true,size:20,mtimeMs:String(path).includes(oldGeneration)?1:2};}};
 t.after(()=>{if(original)Object.defineProperty(globalThis,'__downloadRegistrationFixture',original);else delete globalThis.__downloadRegistrationFixture;});
 const id=randomUUID(),hook=registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/downloads.js?race='+id)&&specifier==='node:fs/promises')return {url:'data:text/javascript,'+encodeURIComponent('const h=globalThis.__downloadRegistrationFixture;export const {mkdir,readFile,writeFile,stat,open}=h;//'+id),shortCircuit:true};return next(specifier,context);}});
 let registerDownloads;try{({registerDownloads}=await import('../server/downloads.js?race='+id));}finally{hook.deregister();}
 const routes=new Map(),app={post:(path,options,handler)=>routes.set(path,handler),get(){}};
 await registerDownloads(app,{db,dataDir:'synthetic',uploadDir:'synthetic/uploads',booksDir:'synthetic/books',videoDir:'synthetic/videos',authenticate:req=>{assert.ok(req.user.id);},findItem:id=>{assert.equal(id,asset);return item;},options:{downloadMasterKey:Buffer.alloc(32,1),rateLimit:false}});
 const create=routes.get('/api/v1/items/:id/download'),open=routes.get('/api/v1/downloads/:id/open'),request=user=>({params:{id:asset},body:{quality:'720p'},user:{id:user}});
 const older=create(request('owner'));await oldRead.promise;
 db.prepare('UPDATE video_assets SET metadata_json=? WHERE item_id=?').run(JSON.stringify(metadata(newGeneration)),asset);
 const newer=create(request('owner'));await turn();
 // A separate user's request is independent of the slow registration.
 const other=await create(request('other'));assert.equal(other.manifest.files[0].generation,newGeneration);
 release.resolve();const [oldResult,newResult]=await Promise.all([older,newer]);assert.notEqual(oldResult.manifest.id,newResult.manifest.id);
 const stored=db.prepare('SELECT * FROM encrypted_downloads WHERE id=?').get(newResult.manifest.id);assert.ok(stored,'the newer registration must survive the old request');assert.equal(JSON.parse(stored.manifest_json).files[0].generation,newGeneration);
 const grant=await open({params:{id:newResult.manifest.id},user:{id:'owner'},session:{expires_at:Date.now()+86400000}});assert.equal(grant.manifest.id,newResult.manifest.id);assert.equal(grant.manifest.files[0].generation,newGeneration);
});
