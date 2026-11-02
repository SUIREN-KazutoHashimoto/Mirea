import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.js';
test('attention clear hides only the owner terminal transfer records, preserves sources, and a retry reappears',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'mirea-clear-')),app=await createApp({dataDir,rateLimit:false}),db=new DatabaseSync(join(dataDir,'mirea.sqlite'));t.after(async()=>{db.close();await app.close();await rm(dataDir,{recursive:true,force:true});});
 const call=(method,path,user,payload)=>app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},...(payload?{payload}:{})});
 const a=(await call('POST','/auth/register',null,{email:'a@example.test',name:'A',password:'fixture-passphrase'})).json(),b=(await call('POST','/auth/register',null,{email:'b@example.test',name:'B',password:'fixture-passphrase'})).json(),shelf=(await call('POST','/shelves',a,{name:'Uploads'})).json().id;
 const id=randomUUID();db.prepare("INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,error,created_at,expires_at) VALUES(?,?,?,?,?, ?,1024,'failed','fixture',?,?)").run(id,shelf,a.user.id,randomUUID(),'Own fixture',JSON.stringify([{name:'one.pdf',size:10,mime:'application/pdf'}]),Date.now(),Date.now()+86400000);
 assert.equal((await call('GET','/transfers/uploads',a)).json().uploads.length,1);assert.equal((await call('POST','/transfers/uploads/clear-attention',b)).json().hidden,0);assert.equal((await call('POST','/transfers/uploads/clear-attention',a)).json().hidden,1);assert.equal((await call('GET','/transfers/uploads',a)).json().uploads.length,0);assert.equal(db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(id).state,'failed');
 db.prepare("UPDATE upload_sessions SET state='processing' WHERE id=?").run(id);assert.equal(db.prepare('SELECT COUNT(*) n FROM transfer_hidden').get().n,0);db.prepare("UPDATE upload_sessions SET state='failed' WHERE id=?").run(id);assert.equal((await call('GET','/transfers/uploads',a)).json().uploads.length,1);assert.equal((await call('POST','/transfers/uploads/clear-attention',null)).statusCode,401);
});
