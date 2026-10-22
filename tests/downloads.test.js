import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,mkdir,writeFile,readFile,unlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { importDownloadKey,decryptDownloadChunk,ciphertextHash,encryptedRangeResponse } from '../web/src/download-core.js';

async function setup(t){
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-download-')),options={dataDir,rateLimit:false};
  const c={app:await createApp(options),dataDir,options};c.db=new DatabaseSync(join(dataDir,'mirea.sqlite'));
  t.after(async()=>{c.db.close();await c.app.close();await rm(dataDir,{recursive:true,force:true});});
  c.req=(method,path,user,payload)=>c.app.inject({method,url:`/api/v1${path}`,headers:user?{authorization:`Bearer ${user.token}`}:{},...(payload?{payload}:{})});
  c.register=async name=>{const r=await c.req('POST','/auth/register',null,{name,email:`${name}@example.test`,password:'encrypted-download-password'});assert.equal(r.statusCode,201,r.body);return r.json();};
  c.owner=await c.register('owner');c.viewer=await c.register('viewer');c.other=await c.register('other');
  c.shelf=(await c.req('POST','/shelves',c.owner,{name:'Encrypted'})).json().id;
  await c.req('POST',`/shelves/${c.shelf}/members`,c.owner,{email:c.viewer.user.email,role:'viewer'});
  c.asset=async(mime,files)=>{
    const id=randomUUID(),images=mime==='application/vnd.mirea.image-book';
    c.db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count) VALUES(?,?,?,?,?,?,?,?,?)').run(id,c.shelf,'Encrypted fixture','fixture',mime,files.reduce((n,b)=>n+b.length,0),c.owner.user.id,Date.now(),images?files.length:3);
    if(images){await mkdir(join(dataDir,'uploads','books',id));for(const [index,bytes] of files.entries()){await writeFile(join(dataDir,'uploads','books',id,`${index+1}.png`),bytes);c.db.prepare('INSERT INTO image_pages VALUES(?,?,?,?,?,?,?)').run(id,index+1,`page-${index+1}.png`,bytes.length,100,200,'image/png');}}
    else await writeFile(join(dataDir,'uploads',id),files[0]);
    return id;
  };
  c.bytes=Buffer.alloc(2*1048576+73,0x57);Buffer.from('PRIVATE-MIREA-CONTENT').copy(c.bytes);
  c.video=await c.asset('video/mp4',[c.bytes]);c.pdf=await c.asset('application/pdf',[Buffer.from('%PDF-1.7 secret book')]);c.images=await c.asset('application/vnd.mirea.image-book',[Buffer.from('secret first page'),Buffer.from('secret second page')]);
  c.create=(asset=c.video,user=c.viewer)=>c.req('POST',`/items/${asset}/download`,user);
  c.open=(id,user=c.viewer)=>c.req('POST',`/downloads/${id}/open`,user);
  c.part=(id,file=0,part=0,user=c.viewer)=>c.req('GET',`/downloads/${id}/files/${file}/parts/${part}`,user);
  return c;
}

test('download sends ciphertext only; online-open key decrypts authenticated chunks and local video ranges are bounded/seekable',async t=>{
  const c=await setup(t),created=await c.create();assert.equal(created.statusCode,200,created.body);
  const {manifest}=created.json();assert.equal('key' in created.json(),false);assert.equal(manifest.files[0].chunks,3);
  assert.equal((await c.create()).json().manifest.id,manifest.id,'retry/resume reuses registration');
  const opened=await c.open(manifest.id);assert.equal(opened.headers['cache-control'],'no-store');
  const key=await importDownloadKey(opened.json().key);assert.equal(key.extractable,false);assert.deepEqual(key.usages,['decrypt']);
  const chunks=new Map();
  for(let part=0;part<3;part++){
    const response=await c.part(manifest.id,0,part);assert.equal(response.statusCode,200,response.body);
    const encrypted=response.rawPayload;assert.equal(await ciphertextHash(encrypted),response.headers['x-chunk-sha256']);assert.ok(encrypted.length<=1048576+28);assert.ok(!encrypted.includes(Buffer.from('PRIVATE-MIREA-CONTENT')));
    const plain=await decryptDownloadChunk(key,manifest,0,part,encrypted);assert.deepEqual(Buffer.from(plain),c.bytes.subarray(part*1048576,Math.min((part+1)*1048576,c.bytes.length)));chunks.set(part,{bytes:encrypted});
  }
  const again=await c.part(manifest.id);assert.notDeepEqual(again.rawPayload.subarray(0,12),chunks.get(0).bytes.subarray(0,12),'fresh IV for every encryption');
  const parallel=await Promise.all([c.part(manifest.id),c.part(manifest.id),c.part(manifest.id)]);
  assert.ok(parallel.some(r=>r.statusCode===429),'concurrent reads are bounded per user');assert.ok(parallel.every(r=>[200,429].includes(r.statusCode)));
  assert.equal((await c.part(manifest.id)).statusCode,200,'finished responses release transfer slots');
  let reads=0;const grant={manifest,key,expiresAt:Date.now()+60000},read=async(_id,_file,part)=>{reads++;return chunks.get(part);};
  const response=encryptedRangeResponse(new Request('https://local/test',{headers:{range:'bytes=1048566-1048586'}}),grant,0,read);
  assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes 1048566-1048586/${c.bytes.length}`);assert.deepEqual(Buffer.from(await response.arrayBuffer()),c.bytes.subarray(1048566,1048587));assert.equal(reads,2);
  const head=encryptedRangeResponse(new Request('https://local/test',{method:'HEAD'}),grant,0,read);assert.equal((await head.arrayBuffer()).byteLength,0);assert.equal(reads,2);
  const suffix=encryptedRangeResponse(new Request('https://local/test',{headers:{range:'bytes=-13'}}),grant,0,read);assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),c.bytes.subarray(-13));
  const invalid=encryptedRangeResponse(new Request('https://local/test',{headers:{range:'bytes=99-1'}}),grant,0,read);assert.equal(invalid.status,416);
});

test('each cached open requires current membership/session, is isolated even from shelf owner, and survives restart without storing individual content keys',async t=>{
  const c=await setup(t),{manifest}= (await c.create()).json(),first=(await c.open(manifest.id)).json();
  assert.equal((await c.open(manifest.id,c.owner)).statusCode,404);assert.equal((await c.open(manifest.id,c.other)).statusCode,404);assert.equal((await c.open(manifest.id,null)).statusCode,401);
  const own=(await c.create(c.video,c.owner)).json().manifest;assert.notEqual(own.id,manifest.id);assert.notEqual((await c.open(own.id,c.owner)).json().key,first.key);
  assert.ok(!JSON.stringify(c.db.prepare('SELECT * FROM encrypted_downloads').all()).includes(first.key));
  await c.app.close();c.app=await createApp(c.options);assert.equal((await c.open(manifest.id)).json().key,first.key,'persistent master key');
  await c.req('POST','/auth/logout',c.viewer);assert.equal((await c.open(manifest.id)).statusCode,401);assert.equal((await c.part(manifest.id)).statusCode,401);
  c.viewer=(await c.req('POST','/auth/login',null,{email:c.viewer.user.email,password:'encrypted-download-password'})).json();assert.equal((await c.open(manifest.id)).statusCode,200);
  await c.req('DELETE',`/shelves/${c.shelf}/members/${c.viewer.user.id}`,c.owner);assert.equal((await c.open(manifest.id)).statusCode,404);assert.equal((await c.part(manifest.id)).statusCode,404);assert.equal((await c.create()).statusCode,404);
});

test('PDF and image pages decrypt, tampering/wrong keys/chunk swaps fail closed, and original changes invalidate the package',async t=>{
  const c=await setup(t);
  for(const asset of [c.pdf,c.images]){
    const manifest=(await c.create(asset)).json().manifest,key=await importDownloadKey((await c.open(manifest.id)).json().key);
    for(const file of manifest.files){const bytes=(await c.part(manifest.id,file.index)).rawPayload;assert.ok((await decryptDownloadChunk(key,manifest,file.index,0,bytes)).length>0);
      const corrupt=Buffer.from(bytes);corrupt[12]^=1;await assert.rejects(()=>decryptDownloadChunk(key,manifest,file.index,0,corrupt));
      const wrong=await importDownloadKey(Buffer.alloc(32,1).toString('base64'));await assert.rejects(()=>decryptDownloadChunk(wrong,manifest,file.index,0,bytes));
      await assert.rejects(()=>decryptDownloadChunk(key,{...manifest,id:randomUUID()},file.index,0,bytes));
    }
    assert.equal((await c.part(manifest.id,999)).statusCode,404);assert.equal((await c.part(manifest.id,0,99999)).statusCode,404);
  }
  const manifest=(await c.create()).json().manifest;await writeFile(join(c.dataDir,'uploads',c.video),Buffer.from('changed'));
  assert.equal((await c.open(manifest.id)).statusCode,409);assert.equal((await c.part(manifest.id)).statusCode,409);
});

test('missing master key with existing packages fails safely rather than silently destroying access',async t=>{
  const c=await setup(t);await c.create();const path=join(c.dataDir,'keys','download-master.key'),master=await readFile(path);await c.app.close();await unlink(path);
  await assert.rejects(()=>createApp(c.options),/Download master key is missing/);
  await writeFile(path,master);c.app=await createApp(c.options);
  assert.equal((await c.create()).statusCode,200);
});

test('thirty-day login and seven-day download leases are server-anchored, capped by legacy session expiry and never renewed by ciphertext reads',async t=>{
  const c=await setup(t),now=Date.now();
  assert.ok(c.viewer.expiresAt-now>29*86400000&&c.viewer.expiresAt-now<=30*86400000);
  const login=await c.req('POST','/auth/login',null,{email:c.viewer.user.email,password:'encrypted-download-password'});
  assert.match(login.headers['set-cookie'],/Max-Age=259[0-9]{4}/);
  const {manifest}=(await c.create()).json(),opened=(await c.open(manifest.id)).json();
  assert.equal(opened.userId,c.viewer.user.id);assert.equal(opened.expiresAt-opened.serverTime,7*86400000);
  const remembered=(await c.req('GET','/auth/me',c.viewer)).json();assert.equal(remembered.user.id,c.viewer.user.id);
  const cap=Date.now()+10000;c.db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(cap,c.viewer.user.id);
  assert.equal((await c.open(manifest.id)).json().expiresAt,cap,'old sessions keep their original shorter expiration');
  c.db.prepare('UPDATE sessions SET expires_at=1 WHERE user_id=?').run(c.viewer.user.id);
  assert.equal((await c.open(manifest.id)).statusCode,401);
});

test('Android empty POST form default is rejected; explicit JSON renews the same encrypted package without replacing keys or media',async t=>{
  const c=await setup(t),{manifest}=(await c.create()).json(),url=`/api/v1/downloads/${manifest.id}/open`;
  const headers={authorization:`Bearer ${c.viewer.token}`};
  const original=(await c.open(manifest.id)).json(),chunk=(await c.part(manifest.id)).rawPayload;
  // Android HttpURLConnection adds this type for POST even with no body.
  const legacy=await c.app.inject({method:'POST',url,headers:{...headers,'content-type':'application/x-www-form-urlencoded','content-length':'0'},payload:''});
  assert.equal(legacy.statusCode,415,legacy.body);
  const response=await c.app.inject({method:'POST',url,headers:{...headers,'content-type':'application/json; charset=UTF-8'},payload:'{}'});
  assert.equal(response.statusCode,200,response.body);const renewed=response.json();
  assert.equal(renewed.manifest.id,manifest.id);assert.equal(renewed.key,original.key);assert.equal(renewed.expiresAt-renewed.serverTime,7*86400000);
  assert.deepEqual(Buffer.from(await decryptDownloadChunk(await importDownloadKey(renewed.key),renewed.manifest,0,0,chunk)),c.bytes.subarray(0,1048576));
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM encrypted_downloads').get().n,1);
  const denied=await c.app.inject({method:'POST',url,headers:{authorization:`Bearer ${c.other.token}`,'content-type':'application/json'},payload:'{}'});
  assert.equal(denied.statusCode,404);
});
