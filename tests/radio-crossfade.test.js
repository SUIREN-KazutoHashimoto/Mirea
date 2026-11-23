import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.js';
import {layoutRadio,onAir} from '../server/radio-crossfade.js';

test('bounded overlap shortens only consecutive music, never the wrap or an MC boundary',()=>{
  const a={id:'a',durationMs:10000}, b={...a,id:'b'}, c={...a,id:'c'}, mc={id:'x',kind:'mc',durationMs:6000};
  const l=layoutRadio([a,b,mc,c],2400);
  assert.equal(l.durationMs,33600);
  assert.deepEqual(l.spans.map(s=>[s.track.id,s.start,s.overlap]),[['a',0,2400],['b',7600,0],['x',17600,0],['c',23600,0]]);
  assert.equal(onAir(l,9000,0).span.track,a);
  assert.equal(onAir(l,10000,0).span.track,b);
  assert.equal(onAir(l,33600,0).span.track,a);
  const short={id:'s',durationMs:4900};
  assert.equal(layoutRadio([a,b,short],2400).durationMs,24900);
});

test('two sessions share overlap and neither overlap media nor normal media bypasses source ACL',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-crossfade-'));
  let app, db;
  t.after(async()=>{db?.close();await app?.close();await rm(dataDir,{recursive:true,force:true});});
  await writeFile(join(dataDir,'storage-layout.json'),JSON.stringify({version:1,id:randomUUID(),mode:'combined'}));
  let time=Date.now();
  app=await createApp({dataDir,mediaDir:dataDir,radioDir:'',radioStations:true,radioNow:()=>time,allowRegistration:true,rateLimit:false});
  async function request(method,url,token,payload,code=200, parse=true){
    const r=await app.inject({method,url:'/api/v1'+url,headers:token?{authorization:'Bearer '+token}:{},payload});
    assert.equal(r.statusCode,code,r.body);return parse?r.json():r;
  }
  const register=name=>request('POST','/auth/register',null,{name,email:name+'@example.test',password:'Crossfade-fixture-pass',remember:false},201);
  const owner=await register('owner'), member=await register('member');
  const shelves=await Promise.all(['one','two'].map(async name=>(await request('POST','/shelves',owner.token,{name},201)).id));
  for(const shelf of shelves)await request('POST','/shelves/'+shelf+'/members',owner.token,{email:member.user.email,role:'viewer'},201);
  db=new DatabaseSync(join(dataDir,'mirea.sqlite'));
  const assetIds=[];
  for(const [i,s] of shelves.entries()){
    const id=randomUUID(), bytes=Buffer.from('fixture'+i);
    await writeFile(join(dataDir,'uploads',id),bytes);
    db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,s,'Track '+i,'fixture.m4a','audio/mp4',bytes.length,owner.user.id,time);
    db.prepare('INSERT INTO audio_assets VALUES(?,?,0)').run(id,JSON.stringify({duration:10})); assetIds.push(id);
  }
  const {playlist}=await request('POST','/playlists',owner.token,{title:'Source'},201);
  await request('PUT','/playlists/'+playlist.id,owner.token,{title:playlist.title,revision:playlist.revision,assetIds});
  const params={name:'FM QA',playlistId:playlist.id,visibility:'public'};
  await request('POST','/radio/stations',owner.token,{...params,crossfadeMs:1000},422);
  const {station}=await request('POST','/radio/stations',owner.token,params,201);
  assert.equal(station.crossfadeMs,0);
  const base='/radio/stations/'+station.id;
  assert.equal((await request('GET',base+'/now',owner.token)).crossfade,undefined);
  await request('PUT',base,member.token,{...params,revision:station.revision,crossfadeMs:2400},404);
  await request('PUT',base,owner.token,{...params,revision:station.revision,crossfadeMs:2400});
  const epoch=time; time+=8500;
  const a=await request('GET',base+'/now',owner.token);
  const b=await request('GET',base+'/now',member.token);
  assert.deepEqual(a,b); assert.equal(a.crossfade.title,'Track 1');assert.equal(a.crossfade.startTime,epoch+7600);
  const incoming=a.crossfade.mediaUrl.slice('/api/v1'.length), outgoing=a.mediaUrl.slice('/api/v1'.length);
  await request('GET',incoming,member.token,null,200,false);
  await request('HEAD',incoming,null,null,401,false);
  time=epoch+10000;
  const next=await request('GET',base+'/now',member.token);
  assert.equal(next.title,'Track 1');assert.equal(next.startTime,a.crossfade.startTime);assert.equal(next.crossfade,undefined);
  time=epoch+8500;
  db.prepare('DELETE FROM memberships WHERE shelf_id=? AND user_id=?').run(shelves[1],member.user.id);
  await request('GET',base+'/now',member.token,null,404);
  for(const url of [incoming,outgoing])await request('HEAD',url,member.token,null,404,false);
});
