import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createJobPool} from '../server/job-pool.js';
import {encoderThreads} from '../server/video-transcode.js';
import {createApp} from '../server/app.js';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {hashToken} from '../server/security.js';
test('continuous upload hints cannot starve a ready media job or break its execution limit',async()=>{
 const pool=createJobPool(()=>1);pool.prioritizeTransfers(200);let started=0,release;const held=new Promise(r=>release=r),hints=setInterval(()=>pool.prioritizeTransfers(200),5);
 try{const first=pool.run(()=>{started++;return held;},'first'),second=pool.run(()=>started++,'second');await delay(450);assert.equal(started,1,'first starts while chunk hints continue');assert.equal(pool.running,1);assert.equal(pool.queued,1);release();await Promise.all([first,second]);assert.equal(started,2);}finally{release();clearInterval(hints);}
});
test('encoder CPU allocation stays bounded under small hosts and configured job concurrency',()=>{
 const memory=64*1024**3;assert.equal(encoderThreads(5,2,memory),1);assert.equal(encoderThreads(5,12,memory),2);assert.equal(encoderThreads(1,12,memory),10);assert.equal(encoderThreads(16,12,memory),1);for(let jobs=1;jobs<=20;jobs++)for(let cpus=1;cpus<=64;cpus++){const allocations=Array.from({length:jobs},(_,rank)=>encoderThreads(jobs,cpus,memory,1920*1080,rank));assert(allocations.every(n=>n>=1&&n<=16));if(cpus>=jobs+2)assert(allocations.reduce((a,b)=>a+b,0)<=cpus-2);}
});
test('in-place playback renewal remains session and asset scoped, bounded by session expiry and denied after revocation',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mirea-renew-0202-')),app=await createApp({dataDir:dir,rateLimit:false}),db=new DatabaseSync(join(dir,'mirea.sqlite'));t.after(async()=>{db.close();await app.close();await rm(dir,{recursive:true,force:true});});
 const req=(url,token,body)=>app.inject({method:'POST',url:'/api/v1'+url,headers:token?{authorization:'Bearer '+token}:{},...(body?{payload:body}:{})}),user=(await req('/auth/register',null,{name:'Renew',email:'renew@example.test',password:'renew-testing-password'})).json(),other=(await req('/auth/login',null,{email:'renew@example.test',password:'renew-testing-password'})).json(),shelf=(await req('/shelves',user.token,{name:'Renew'})).json().id,id=randomUUID();
 await writeFile(join(dir,'uploads',id),Buffer.alloc(100));db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,'fixture.mp4','video/mp4',100,?,?)").run(id,shelf,'Synthetic',user.user.id,Date.now());
 const ticket=(await req('/items/'+id+'/playback-ticket',user.token)).json(),token=new URL(ticket.url,'https://mirea.test').searchParams.get('ticket');
 db.prepare('UPDATE playback_tickets SET expires_at=? WHERE token_hash=?').run(Date.now()+1000,hashToken(token));const renewed=await req('/items/'+id+'/playback-ticket',user.token,{ticket:token});assert.equal(renewed.statusCode,200,renewed.body);assert.equal(renewed.json().url,ticket.url);assert(renewed.json().expiresAt>Date.now()+1000);
 assert.equal((await req('/items/'+id+'/playback-ticket',other.token,{ticket:token})).statusCode,409);assert.equal((await req('/items/'+id+'/playback-ticket',user.token,{ticket:'malformed'})).statusCode,400);
 db.prepare('UPDATE playback_tickets SET expires_at=1 WHERE token_hash=?').run(hashToken(token));assert.equal((await req('/items/'+id+'/playback-ticket',user.token,{ticket:token})).statusCode,409);
 db.prepare('DELETE FROM memberships WHERE shelf_id=? AND user_id=?').run(shelf,user.user.id);assert.equal((await req('/items/'+id+'/playback-ticket',user.token,{ticket:token})).statusCode,404);
});
