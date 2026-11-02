import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.js';
import {assertAssetChanges,assertUploadName} from '../server/name-integrity.js';
import {libraryNameConflicts} from '../server/name-rules.js';
import {renderNameIntegrity} from '../web/src/name-integrity.js';
import {planUploads,validateUploadPlan} from '../web/src/upload-batch.js';
import {signUpdateEnvelope,verifyUpdateEnvelope} from '../server/update-manifest.js';
import {renewAndroidMetadata} from '../scripts/renew-android-metadata.mjs';
import {makePdf} from './fixtures.js';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'mirea-names-')),app=await createApp({dataDir:dir,rateLimit:false}),db=new DatabaseSync(join(dir,'mirea.sqlite'));db.exec('PRAGMA foreign_keys=ON');
 t.after(async()=>{await app.close();db.close();await rm(dir,{recursive:true,force:true});});
 const req=(method,path,user,payload)=>app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},...(payload===undefined?{}:{payload})});
 const user=async name=>(await req('POST','/auth/register',null,{email:name+'@example.test',name,password:'synthetic-names-password'})).json();
 const owner=await user('owner'),viewer=await user('viewer'),editor=await user('editor'),foreign=await user('foreign');
 const shelf=(await req('POST','/shelves',owner,{name:'Same shelf'})).json().id;
 for(const [u,role]of [[viewer,'viewer'],[editor,'editor']])await req('POST','/shelves/'+shelf+'/members',owner,{email:u.user.email,role});
 const series=async(title,parentId=null)=>(await req('POST','/shelves/'+shelf+'/series',owner,{title,parentId})).json().series;
 const asset=async(title,parentId=null)=>{const id=randomUUID(),bytes=makePdf();await writeFile(join(dir,'uploads',id),bytes);db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,'fixture.pdf','application/pdf',?,?,1)").run(id,shelf,title,bytes.length,owner.user.id);if(parentId)db.prepare('INSERT INTO series_items VALUES(?,?,?,?)').run(parentId,id,db.prepare('SELECT COUNT(*) n FROM series_items WHERE series_id=?').get(parentId).n+1,'');return id;};
 const begin=(title,parentId=null,actor=owner)=>req('POST','/shelves/'+shelf+'/uploads',actor,{title,seriesId:parentId,files:[{filename:'source.pdf',mime:'application/pdf',size:10}]});
 return {dir,app,db,req,user,owner,viewer,editor,foreign,shelf,series,asset,begin};
}
test('legacy duplicates remain unchanged; scoped owner/editor notices persist until manual resolution and never leak to viewers or foreign users',async t=>{
 const c=await fixture(t),a=await c.asset('Same'),b=await c.asset('Same'),s=await c.series('Folder'),id=randomUUID();
 const trigger=c.db.prepare("SELECT sql FROM sqlite_master WHERE name='series_unique_path_insert'").get().sql;c.db.exec('DROP TRIGGER series_unique_path_insert');c.db.prepare("INSERT INTO series(id,shelf_id,title,created_at,updated_at) VALUES(?,?,'Folder',1,1)").run(id,c.shelf);c.db.exec(trigger);
 const before=JSON.stringify(c.db.prepare('SELECT id,title FROM items ORDER BY id').all()),key=await readFile(join(c.dir,'keys','download-master.key'));
 assert.equal((await c.req('GET','/library/integrity')).statusCode,401);
 for(const user of [c.owner,c.editor]){const r=await c.req('GET','/library/integrity',user);assert.equal(r.json().total,2);assert(r.json().groups.some(g=>g.kind==='asset'&&g.count===2));}
 for(const user of [c.viewer,c.foreign])assert.deepEqual((await c.req('GET','/library/integrity',user)).json(),{groups:[],total:0});
 assert.equal(JSON.stringify(c.db.prepare('SELECT id,title FROM items ORDER BY id').all()),before);assert.deepEqual(await readFile(join(c.dir,'keys','download-master.key')),key);
 assert.equal((await c.req('PATCH','/items/'+a,c.viewer,{title:'New',expectedTitle:'Same'})).statusCode,403);
 assert.equal((await c.req('PATCH','/items/'+a,c.owner,{title:'New',expectedTitle:'wrong'})).statusCode,409);
 assert.equal((await c.req('PATCH','/items/'+a,c.editor,{title:'New',expectedTitle:'Same'})).statusCode,200);
 assert.equal((await c.req('GET','/library/integrity',c.owner)).json().total,1);assert.equal(c.db.prepare('SELECT title FROM items WHERE id=?').get(b).title,'Same');
 const info=(await c.req('GET','/series/'+id,c.owner)).json();assert.equal((await c.req('PUT','/series/'+id,c.owner,{revision:info.series.revision,title:'Resolved',description:'',items:[]})).statusCode,200);
 assert.equal((await c.req('GET','/library/integrity',c.owner)).json().total,0);assert.equal(c.db.prepare('SELECT title FROM series WHERE id=?').get(s.id).title,'Folder');
 assert.equal((await c.req('POST','/shelves',c.owner,{name:'Same shelf'})).statusCode,201,'shelf names are unrestricted');
});
test('upload reservation rejects duplicate titles including Unicode equivalents, across users and file kinds, but permits distinct series',async t=>{
 const c=await fixture(t),one=await c.series('One'),two=await c.series('Two');await c.asset('が');
 assert.equal((await c.begin('か\u3099')).statusCode,409);
 assert.equal((await c.begin('が',one.id)).statusCode,201);assert.equal((await c.begin('が',two.id)).statusCode,201);
 const both=await Promise.all([c.begin('Race',null,c.owner),c.begin('Race',null,c.editor)]);assert.deepEqual(both.map(r=>r.statusCode).sort(),[201,409]);
 const timed=await c.req('POST','/shelves/'+c.shelf+'/uploads',c.editor,{title:'が',files:[{filename:'audio.mp3',mime:'audio/mpeg',size:10}]});assert.equal(timed.statusCode,409);
});
test('series assignment and shallow deletion reject final-state collisions atomically; reorder and explicit manual rename remain possible',async t=>{
 const c=await fixture(t),one=await c.series('One'),two=await c.series('Two'),a=await c.asset('Track',one.id),b=await c.asset('Track',two.id),root=await c.asset('Root');
 let info=(await c.req('GET','/series/'+two.id,c.owner)).json();let r=await c.req('PUT','/series/'+two.id,c.owner,{revision:info.series.revision,title:'Two',description:'',moveAssets:true,items:[{assetId:a},{assetId:b}]});assert.equal(r.statusCode,409);assert.equal(c.db.prepare('SELECT series_id FROM series_items WHERE asset_id=?').get(a).series_id,one.id);
 const duplicateRoot=await c.asset('Root',one.id);info=(await c.req('GET','/series/'+one.id,c.owner)).json();r=await c.req('DELETE','/series/'+one.id,c.owner,{revision:info.series.revision});assert.equal(r.statusCode,409);assert(c.db.prepare('SELECT 1 FROM series WHERE id=?').get(one.id));
 assert.equal((await c.req('PATCH','/items/'+duplicateRoot,c.owner,{expectedTitle:'Root',title:'Unique'})).statusCode,200);
 assert.throws(()=>assertAssetChanges(c.db,c.shelf,[{id:root,title:'Track',parentId:two.id}]),/同じ階層/);
 assert.throws(()=>assertUploadName(c.db,{id:randomUUID(),shelf_id:c.shelf,title:'Track',target_series_id:one.id,series_requested:1}),/同じ階層/);
});
test('duplicate warning is non-dismissible, escaped, offline-aware, and clears only after authoritative data resolves or management access is removed',()=>{
 const shelf={id:'s',name:'Shelf',role:'editor'},catalog={shelves:[shelf],series:[],items:[{id:'a',shelfId:'s',title:'<unsafe>'},{id:'b',shelfId:'s',title:'<unsafe>'}]},node={innerHTML:'',hidden:true,querySelectorAll:()=>[]},esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 renderNameIntegrity(node,catalog,{esc,offline:true});assert.equal(node.hidden,false);assert(node.innerHTML.includes('&lt;unsafe&gt;'));assert(node.innerHTML.includes('解消されるまで'));assert(node.innerHTML.includes('保存済み'));assert(!node.innerHTML.includes('dismiss'));
 assert.equal(libraryNameConflicts(catalog).length,1);renderNameIntegrity(node,{...catalog,items:[catalog.items[0]]},{esc});assert.equal(node.hidden,true);
 renderNameIntegrity(node,{...catalog,shelves:[{...shelf,role:'viewer'}]},{esc});assert.equal(node.hidden,true);
});
test('initial titles retain filename distinctions; edited duplicate titles are rejected only within the same hierarchy',()=>{
 const files=['Same.pdf','Same.mp3'].map(name=>new File(['bytes'],name)),config={maxUploadBytes:100,maxImageBytes:100,maxBookPages:5};const jobs=planUploads(files);assert.deepEqual(jobs.map(j=>j.title),['Same.pdf','Same.mp3']);assert.equal(validateUploadPlan(jobs,config),'');for(const job of jobs)job.title='Same';assert.match(validateUploadPlan(jobs,config),/同じ階層/);jobs[0].folderPath='A';jobs[1].folderPath='B';assert.equal(validateUploadPlan(jobs,config),'');
});
test('metadata renewal verifies the existing envelope and pin, permits expired valid metadata, preserves APK identity and never extends beyond seven days',()=>{
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'}),publicKey=pair.publicKey.export({type:'spki',format:'pem'}),issuedAt=1800000000000,payload={schemaVersion:1,packageName:'com.suiren.mirea',versionCode:33,versionName:'0.16.0beta',apkUrl:'https://example.test/app.apk',sha256:'a'.repeat(64),signerSha256:'b'.repeat(64),size:100,minSdk:29,issuedAt,expiresAt:issuedAt+86400000},old=signUpdateEnvelope(payload,privateKey,issuedAt),now=issuedAt+8*86400000;
 const result=renewAndroidMetadata(old,privateKey,publicKey,{now}),fresh=verifyUpdateEnvelope(result.raw,publicKey,now);for(const key of Object.keys(payload))if(!['issuedAt','expiresAt'].includes(key))assert.equal(fresh[key],payload[key]);assert.equal(fresh.expiresAt-now,7*86400000);
 assert.throws(()=>renewAndroidMetadata(old,privateKey,publicKey,{now,validityHours:169}));assert.throws(()=>renewAndroidMetadata(old,generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'}),publicKey,{now}));assert.throws(()=>renewAndroidMetadata(old.replace('signature','changed'),privateKey,publicKey,{now}));
});
