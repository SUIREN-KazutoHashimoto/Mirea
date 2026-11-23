import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.js';
import {openDatabase} from '../server/database.js';

test('v28 station migration defaults to music-only without rewriting station or media data',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mirea-fm-migration-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'db');
  let db=openDatabase(file);
  db.exec(`INSERT INTO users VALUES('usr','a@example.test','Owner','hash',1);
    INSERT INTO playlists VALUES('playlist','usr','playlist',1,1,1);
    INSERT INTO radio_stations VALUES('station','usr','playlist','Name','private',NULL,1,1);
    DROP TABLE radio_fm_profiles; UPDATE schema_version SET version=28;`);
  db.close();db=openDatabase(file);
  try{
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version,31);
    assert.equal(db.prepare('SELECT count(*) n FROM radio_fm_profiles').get().n,0);
    assert.equal(db.prepare('SELECT name FROM radio_stations').get().name,'Name');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});

test('offline FM pack is deterministic across listeners; absent or invalid interludes consume no schedule time',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mirea-fm-stations-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const pack=join(root,'pack'),dir=join(root,'data');
  await mkdir(pack);
  // Fixture codec marker and sample hash exercise serving, not decoding (browser harness decodes real assets).
  const synthetic=Buffer.concat([Buffer.alloc(4),Buffer.from('ftyp'),Buffer.alloc(20)]);
  const sha=createHash('sha256').update(synthetic).digest('hex');
  async function prepare(){
    await writeFile(join(pack,'fm-pack.json'),JSON.stringify({version:1,clips:{
      'jingle-standard':{sha256:sha,durationMs:1500},
      'jingle-enhanced':{sha256:'1'.repeat(64),durationMs:1800},
      'mc-enhanced':{sha256:sha,durationMs:3000,credit:'Local synthetic fixture'}
    }}));
    for(const asset of ['jingle-standard','jingle-enhanced','mc-enhanced'])await writeFile(join(pack,asset+'.m4a'),synthetic);
  }
  await prepare();
  const epoch=Date.now();let now=epoch,app,db;
  const opts={dataDir:dir,radioDir:'',radioStations:true,radioFmDir:pack,radioNow:()=>now,rateLimit:false,allowRegistration:true};
  const call=(method,path,user,payload)=>app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},payload});
  async function json(method,path,user,payload,want=200){const r=await call(method,path,user,payload);assert.equal(r.statusCode,want,r.body);return r.json();}
  const register=name=>json('POST','/auth/register',null,{name,email:name+'@example.test',password:'synthetic-radio-fixture-pass',remember:false},201);
  try{
    app=await createApp(opts);
    const owner=await register('owner'), allowed=await register('allowed'), outsider=await register('outsider');
    const shelf=(await json('POST','/shelves',owner,{name:'Shelf'},201)).id;
    await json('POST','/shelves/'+shelf+'/members',owner,{email:allowed.user.email,role:'viewer'},201);
    db=new DatabaseSync(join(dir,'mirea.sqlite'));db.exec('PRAGMA foreign_keys=ON');
    const assets=[];
    for(const title of ['Track A','Track B']){
      const id=randomUUID(),bytes=Buffer.from(title);
      db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,shelf,title,'fixture.m4a','audio/mp4',bytes.length,owner.user.id,epoch);
      db.prepare('INSERT INTO audio_assets VALUES(?,?,0)').run(id,JSON.stringify({duration:5}));
      await writeFile(join(dir,'uploads',id),bytes);assets.push(id);
    }
    const {playlist}=await json('POST','/playlists',owner,{title:'Private Source Name'},201);
    await json('PUT','/playlists/'+playlist.id,owner,{revision:playlist.revision,title:playlist.title,assetIds:assets});
    const cfg=await json('GET','/config');
    assert.deepEqual(cfg.radioFm,{mc:['enhanced'],jingle:['standard']});
    const request={name:'Public station',visibility:'public',playlistId:playlist.id,fm:{mc:'enhanced',jingle:'standard'}};
    await json('POST','/radio/stations',owner,{...request,fm:{...request.fm,script:'user-specified'}},422);
    const {station}=await json('POST','/radio/stations',owner,request,201);
    assert.deepEqual(station.fm,request.fm);
    assert.equal((await json('GET','/radio/stations',allowed)).stations[0].fm,undefined);
    const base='/radio/stations/'+station.id,media=program=>program.mediaUrl.slice('/api/v1'.length);
    const tune=user=>json('GET',base+'/now',user);

    now=epoch+6000;assert.equal((await tune(allowed)).title,'Track B');
    now=epoch+10100;const jingle=await tune(owner);
    assert.deepEqual(await tune(allowed),jingle);
    assert.equal(jingle.kind,'jingle');assert.equal(jingle.startTime,epoch+10000);
    now=epoch+12000;const mc=await tune(allowed);
    assert.deepEqual(mc,await tune(owner));
    assert.equal(mc.kind,'mc');assert.equal(mc.credit,'Local synthetic fixture');assert.equal(mc.startTime,epoch+11500);
    assert.equal(jingle.nextMediaUrl,mc.mediaUrl);
    const allowedClip=await call('GET',media(mc),allowed);
    assert.deepEqual(allowedClip.rawPayload,synthetic);
    assert.equal(allowedClip.headers['cache-control'],'private, no-store, no-transform');
    assert.equal((await call('HEAD',media(mc),allowed)).statusCode,200);
    assert.equal((await call('HEAD',media(mc),outsider)).statusCode,404);
    assert.equal((await call('GET',media(mc))).statusCode,401);
    assert.equal((await call('GET','/radio/fm/preview/mc-enhanced',owner)).statusCode,200);
    assert.equal((await call('GET','/radio/fm/preview/mc-enhanced')).statusCode,401);
    now=epoch+14501;const after=await tune(allowed);
    assert.equal(after.title,'Track A');assert.equal(after.startTime,epoch+14500);
    const edit=await json('PUT',base,owner,{...request,revision:station.revision,fm:{mc:'standard',jingle:'enhanced'}});
    assert.equal((await call('GET',media(mc),owner)).statusCode,404);
    // Selected MC is absent and selected jingle is corrupt. At exactly 10 seconds
    // the next music loop begins, not a nominal FM cue or a blank slot.
    now+=10001;const fallback=await tune(allowed);
    assert.equal(fallback.title,'Track A');assert.equal(fallback.kind,undefined);
    assert.equal(fallback.startTime,epoch+24501);
    assert.equal((await call('GET','/radio/fm/preview/jingle-enhanced',owner)).statusCode,404);
    db.prepare('DELETE FROM memberships WHERE shelf_id=? AND user_id=?').run(shelf,allowed.user.id);
    assert.equal((await call('GET',base+'/now',allowed)).statusCode,404);
    assert.equal((await call('GET',media(fallback),allowed)).statusCode,404);
    await app.close();app=await createApp({...opts,radioFmDir:''});
    assert.equal((await json('GET','/config')).radioFm,null);
    assert.equal((await tune(owner)).kind,undefined);
    assert.equal((await call('GET','/radio/fm/preview/mc-enhanced',owner)).statusCode,404);
    assert.equal((await call('DELETE',base,owner,{revision:edit.station.revision})).statusCode,204);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM radio_fm_profiles').get().n,0);
  }finally{db?.close();await app?.close();}
});

test('real local FFmpeg generates measured AAC jingles; no voice model is needed',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mirea-fm-render-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const pack=join(root,'pack');
  await promisify(execFile)(process.execPath,['scripts/prepare-radio-fm.mjs','--out',pack],{timeout:45_000,windowsHide:true});
  const manifest=JSON.parse(await readFile(join(pack,'fm-pack.json'),'utf8'));
  assert.deepEqual(Object.keys(manifest.clips),['jingle-standard','jingle-enhanced']);
  for(const row of Object.values(manifest.clips)){
    assert.ok(row.lufs>=-21&&row.lufs<=-14&&row.truePeak<=-1);
    assert.ok(row.durationMs>=700);
  }
  assert.notEqual(manifest.clips['jingle-standard'].sha256,manifest.clips['jingle-enhanced'].sha256);
});
