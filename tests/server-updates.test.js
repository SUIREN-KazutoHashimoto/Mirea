import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/app.js';
import {verifyServerArchive} from '../scripts/verify-server-archive.mjs';
import {RELEASE_PREFIX} from '../server/server-updates.js';
import Fastify from 'fastify';
import http from 'node:http';
import {createMaintenanceGate} from '../server/maintenance-gate.js';

function member(name,type='0',bytes=Buffer.from('{}')){
  const header=Buffer.alloc(512);header.write(name);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header.write(type,156);header.write('ustar\0',257);header.write('00',263);header.write([...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);
  return Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512)]);
}
test('server archive verifier accepts a bounded package and rejects links, traversal, case collisions, devices and truncated headers',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mirea-update-tar-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root='mirea-0.2.4beta-server',base=[member(root+'/package.json'),member(root+'/release-manifest.json')];
  const verify=async(parts,end=true)=>{const file=join(directory,Math.random()+'.tar.gz');await writeFile(file,gzipSync(Buffer.concat([...parts,...(end?[Buffer.alloc(1024)]:[])])));return verifyServerArchive(file,root);};
  assert.equal((await verify(base)).safe,true);
  for(const [path,type] of [[root+'/../escape','0'],[root+'/link','2'],[root+'/hardlink','1'],[root+'/CON.txt','0'],[root+'/trail.','0'],[root+'//double','0'],[root+'/package.JSON','0'],['outside/file','0']])await assert.rejects(verify([...base,member(path,type)]),path);
  await assert.rejects(verify(base,false));
});

test('update handoff queues only verified fixed-repository data, freezes writes, exposes status and unlocks on agent failure',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mirea-update-handoff-')),helper=join(directory,'helper');await mkdir(helper);await mkdir(join(helper,'requests'));await mkdir(join(helper,'status'));await writeFile(join(helper,'capabilities.json'),JSON.stringify({protocol:1,platform:'win32',installed:true}));
  const release={tag_name:'v99.0.0beta',draft:false,assets:[{id:123,name:'mirea-99.0.0beta-server.tar.gz',state:'uploaded',size:100,digest:'sha256:'+'b'.repeat(64),browser_download_url:RELEASE_PREFIX+'v99.0.0beta/mirea-99.0.0beta-server.tar.gz'}]};
  const options={dataDir:join(directory,'data'),windowsMaintenanceDir:helper,rateLimit:false,serverAdminUserIds:[],releaseFetch:async()=>new Response(JSON.stringify(release))};
  const app=await createApp(options);t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const r=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Admin',email:'update@example.test',password:'update-test-password'}});const user=r.json();options.serverAdminUserIds.push(user.user.id);
  const request=(method,path,body)=>app.inject({method,url:'/api/v1'+path,headers:{authorization:'Bearer '+user.token},...(body?{payload:body}:{})});
  const body={currentPassword:'update-test-password',tag:'v99.0.0beta',confirmTag:'v99.0.0beta',acknowledgeRestart:true};
  assert.equal((await request('POST','/admin/updates/apply',{...body,confirmTag:'wrong'})).statusCode,400);
  const applied=await request('POST','/admin/updates/apply',body);assert.equal(applied.statusCode,202,applied.body);
  const id=applied.json().id,data=JSON.parse(await readFile(join(helper,'requests',id+'.json'),'utf8'));
  assert.equal(data.sha256,'b'.repeat(64));assert.equal(data.assetId,123);assert.equal(data.url,undefined);assert(!JSON.stringify(data).includes(body.currentPassword));
  assert.equal((await request('POST','/shelves',{name:'Blocked during handoff'})).statusCode,503);
  assert.equal((await request('GET','/admin/updates/status')).statusCode,200);
  await writeFile(join(helper,'status',id+'.json'),JSON.stringify({state:'failed',stage:'verifying-release',tag:'v99.0.0beta'}));
  await delay(2200);assert.equal((await request('POST','/shelves',{name:'Recovered'})).statusCode,201);
});

test('aborted requests retain reservations until actual asynchronous work finishes, then let backup proceed',async t=>{
  const app=Fastify(),gate=createMaintenanceGate(app);let entered,finish;
  const started=new Promise(r=>{entered=r;}),wait=new Promise(r=>{finish=r;});
  app.post('/api/write',async()=>{entered();await wait;return {ok:true};});
  await app.listen({host:'127.0.0.1',port:0});t.after(async()=>{finish();await app.close();});
  const request=http.request({host:'127.0.0.1',port:app.server.address().port,path:'/api/write',method:'POST'});request.on('error',()=>{});request.end();await started;request.destroy();
  let acquired=false;const waiting=gate.acquire().then(unlock=>{acquired=true;return unlock;});
  await delay(100);assert.equal(acquired,false,'disconnection alone must not allow an inconsistent backup');finish();
  const unlock=await Promise.race([waiting,delay(1000).then(()=>{throw Error('Completed handler held a reservation');})]);assert.equal(gate.locked,true);unlock();assert.equal(gate.locked,false);
});
