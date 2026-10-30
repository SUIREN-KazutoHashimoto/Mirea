import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,link,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMediaUsage,scanMediaUsage} from '../server/storage-usage.js';
import {createApp} from '../server/app.js';
test('media usage includes originals and all derivatives across separate roots without counting hard links twice',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mirea-usage-'));t.after(()=>rm(root,{recursive:true,force:true}));const dataDir=join(root,'data'),mediaDir=join(root,'media');
 for(const path of ['data/thumbnails/custom','data/previews','data/backups','media/uploads/staging','media/videos/quality','media/originals'])await mkdir(join(root,path),{recursive:true});
 for(const [file,size]of [['media/uploads/asset',11],['media/uploads/staging/part',7],['media/videos/quality/segment',13],['media/originals/source',17],['data/thumbnails/custom/source.input',19],['data/previews/clip',23],['data/mirea.sqlite',1000],['data/backups/backup',1000]])await writeFile(join(root,file),Buffer.alloc(size));
 await link(join(root,'media/uploads/asset'),join(root,'media/videos/quality/canonical'));
 if(process.platform!=='win32')await symlink(join(root,'data/backups'),join(root,'media/uploads/ignored-link'));
 const result=await scanMediaUsage({dataDir,mediaDir});assert.equal(result.totalBytes,90);assert.equal(result.fileCount,6);assert.equal(result.skippedLinks,process.platform==='win32'?0:1);assert(!JSON.stringify(result).includes(root));
});
test('usage discovery is nonblocking, coalesces requests, caches briefly and handles cancellation/errors without raw paths',async()=>{
 let finish,calls=0,time=100;const usage=createMediaUsage({dataDir:'synthetic'},{now:()=>time,scan:()=>{calls++;return new Promise(resolve=>finish=resolve);}});
 assert.equal(usage.snapshot().state,'calculating');usage.snapshot();await Promise.resolve();assert.equal(calls,1);finish({totalBytes:42,fileCount:2,skippedLinks:0});await usage.idle();assert.equal(usage.snapshot().totalBytes,42);time+=60001;assert.equal(usage.snapshot().state,'calculating');await Promise.resolve();finish({totalBytes:43,fileCount:3,skippedLinks:0});await usage.idle();assert.equal(usage.snapshot().totalBytes,43);await usage.close();
 const failed=createMediaUsage({dataDir:'synthetic'},{scan:async()=>{throw Error('secret absolute path');}});failed.snapshot();await failed.idle();assert.equal(failed.snapshot().state,'unavailable');assert(!JSON.stringify(failed.snapshot()).includes('secret'));await failed.close();
});
test('only administrators can discover the combined media total, with no private filename or content in the response',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'mirea-usage-api-')),options={dataDir,rateLimit:false,allowRegistration:true,serverAdminUserIds:[]},app=await createApp(options);t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
 const register=async name=>(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name,email:name+'@example.invalid',password:'synthetic-usage-password'}})).json();const admin=await register('UsageAdmin'),reader=await register('UsageReader');options.serverAdminUserIds.push(admin.user.id);
 await writeFile(join(dataDir,'uploads','PRIVATE_SOURCE_NAME'),Buffer.alloc(11));await writeFile(join(dataDir,'previews','PRIVATE_PREVIEW_NAME'),Buffer.alloc(42));
 assert.equal((await app.inject('/api/v1/admin/storage-usage')).statusCode,401);assert.equal((await app.inject({url:'/api/v1/admin/storage-usage',headers:{authorization:'Bearer '+reader.token}})).statusCode,403);
 const headers={authorization:'Bearer '+admin.token},overview=await app.inject({url:'/api/v1/admin/overview',headers});assert.equal(overview.statusCode,200);assert(overview.json().storage);
 let response;for(let n=0;n<100;n++){response=await app.inject({url:'/api/v1/admin/storage-usage',headers});if(response.json().state!=='calculating')break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(response.statusCode,200);assert.equal(response.json().state,'ready');assert.equal(response.json().totalBytes,53);assert(!response.body.includes('PRIVATE'));assert(!response.body.includes(dataDir));
});
