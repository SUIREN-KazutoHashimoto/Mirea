import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.js';
import {openDatabase} from '../server/database.js';

const prefix='/api/v1';
const stations='/radio/stations';
test('migration preserves old v27 data and is idempotent',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mirea-radio-migration-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'migration.db');
  let db=openDatabase(file);
  db.exec("INSERT INTO users VALUES('keep','keep@example.test','Keep','hash',1); DROP TABLE radio_stations; UPDATE schema_version SET version=27;");
  db.close();
  for(let n=0;n<2;n++){
    db=openDatabase(file);
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version,31);
    assert.equal(db.prepare('SELECT id FROM users').get().id,'keep');
    assert.equal(db.prepare('SELECT count(*) n FROM radio_stations').get().n,0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.close();
  }
});

test('stations remain opt-in; radio tests do not assume a process environment switch',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mirea-radio-opt-in-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const app=await createApp({dataDir:dir,radioDir:'',radioStations:false,rateLimit:false});
  try{
    assert.equal((await app.inject({url:prefix+'/config'})).json().radioStations,false);
    assert.equal((await app.inject({url:prefix+stations})).statusCode,404);
  }finally{await app.close();}
});

test('public, link-only and private radio do not widen underlying access, and old media/link capabilities revoke',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mirea-radio-stations-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let time=Date.now(),app,db;
  const options={dataDir:dir,radioDir:'',radioStations:true,radioNow:()=>time,rateLimit:false,allowRegistration:true};
  const call=(method,path,user,body,extra)=>app.inject({method,url:prefix+path,headers:{...(user?{authorization:'Bearer '+user.token}:{}),...extra},payload:body});
  async function json(method,path,user,body,status=200,extra){
    const r=await call(method,path,user,body,extra);assert.equal(r.statusCode,status,r.body);return r.json();
  }
  const register=name=>json('POST','/auth/register',null,{name,email:name+'@example.test',password:'synthetic-local-radio-pass',remember:false},201);
  const share=token=>({'x-mirea-radio-share':token});
  const path=(station,action='')=>stations+'/'+station.id+action;
  const noLeak=async (url,user,extra)=>{
    const response=await call('GET',url,user,null,extra);
    assert.equal(response.statusCode,404,response.body);
    assert.doesNotMatch(response.body,/Synthetic Title|My Playlist|Secret Station/);
  };
  try{
    app=await createApp(options);
    const owner=await register('owner'),member=await register('member'),outsider=await register('outsider');
    const a=(await json('POST','/shelves',owner,{name:'A'},201)).id;
    const b=(await json('POST','/shelves',owner,{name:'B'},201)).id;
    for(const shelf of [a,b])await json('POST','/shelves/'+shelf+'/members',owner,{email:member.user.email,role:'viewer'},201);
    db=new DatabaseSync(join(dir,'mirea.sqlite'));db.exec('PRAGMA foreign_keys=ON');
    async function seed(shelf,title){
      const id=randomUUID(),bytes=Buffer.from(title);
      db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,shelf,title,'sample.m4a','audio/mp4',bytes.length,owner.user.id,Date.now());
      db.prepare('INSERT INTO audio_assets VALUES(?,?,0)').run(id,JSON.stringify({duration:5}));
      await writeFile(join(dir,'uploads',id),bytes);
      return id;
    }
    const one=await seed(a,'Synthetic Title A'),two=await seed(b,'Synthetic Title B');
    async function createPlaylist(title,assetIds) {
      const {playlist}=await json('POST','/playlists',owner,{title},201);
      return (await json('PUT','/playlists/'+playlist.id,owner,{title,revision:playlist.revision,assetIds})).playlist;
    }
    const first=await createPlaylist('My Playlist A',[one,two]),second=await createPlaylist('My Playlist B',[two]);
    const config=await json('GET','/config');
    assert.equal(config.radioStations,true);
    assert.equal((await call('GET',stations)).statusCode,401);
    const body=(name,visibility,playlistId=first.id)=>({name,playlistId,visibility});
    await json('POST',stations,member,body('Forbidden','public'),422);
    const pub=(await json('POST',stations,owner,body('Public Station','public'),201)).station;
    const hidden=await json('POST',stations,owner,body('Unlisted Station','unlisted'),201);
    let privateStation=(await json('POST',stations,owner,body('Secret Station','private',second.id),201)).station;
    const unlisted=hidden.station;
    assert.match(hidden.share,/^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(db.prepare('SELECT share_hash AS value FROM radio_stations WHERE id=?').get(unlisted.id).value,hidden.share);
    assert.deepEqual((await json('GET',stations,member)).stations,[{id:pub.id,name:'Public Station',visibility:'public',mine:false}]);
    const playlistList=(await json('GET','/playlists',member)).playlists;
    assert.ok(playlistList.every(item=>item.id!==first.id));
    const listen=(station,user,extra)=>json('GET',path(station,'/now'),user,undefined,200,extra);
    await noLeak(path(pub,'/now'),outsider);
    await noLeak(path(unlisted,'/now'),member);
    await noLeak(path(privateStation,'/now'),member,share(hidden.share));
    assert.equal((await call('GET',path(pub,'/now'))).statusCode,401);
    assert.equal((await call('GET',path(unlisted,'/now'),null,undefined,share(hidden.share))).statusCode,401);
    assert.equal((await listen(privateStation,owner)).title,'Synthetic Title B');
    const p=await listen(pub,member), h=await listen(unlisted,member,share(hidden.share));
    assert.equal(p.title,'Synthetic Title A');assert.equal(h.title,p.title);
    assert.equal(p.startTime,h.startTime);assert.notEqual(p.mediaUrl,h.mediaUrl);
    const media=value=>value.mediaUrl.slice(prefix.length);
    assert.equal((await call('GET',media(p),member)).body,'Synthetic Title A');
    assert.equal((await call('HEAD',media(h),member,undefined,share(hidden.share))).statusCode,200);
    await noLeak(media(h),member);
    await noLeak(media(p),outsider);
    await noLeak(path(unlisted,'/now'),outsider,share(hidden.share));
    assert.equal((await call('PUT',path(pub),member,{...body('Attempt','private'),revision:pub.revision})).statusCode,404);
    await json('PUT',path(pub),owner,{...body('Stale','private'),revision:222},409);

    const rotate=await json('POST',path(unlisted,'/rotate-link'),owner,{revision:unlisted.revision});
    await noLeak(path(unlisted,'/now'),member,share(hidden.share));
    await noLeak(path(unlisted,'/now'),owner,share(hidden.share));
    await noLeak(media(h),member,share(rotate.share));
    const next=await listen(unlisted,member,share(rotate.share));
    const changed=await json('PUT',path(unlisted),owner,{...body('Changed','public'),revision:rotate.station.revision});
    await noLeak(path(unlisted,'/now'),member,share(rotate.share));
    await noLeak(media(next),member);
    assert.equal((await listen(changed.station,member)).title,p.title);
    const hiddenAgain=await json('PUT',path(unlisted),owner,{...body('Unlisted Again','unlisted'),revision:changed.station.revision});
    assert.notEqual(hiddenAgain.share,rotate.share);
    await noLeak(path(unlisted,'/now'),member,share(rotate.share));
    assert.equal((await listen(unlisted,member,share(hiddenAgain.share))).title,p.title);

    const removed=await call('DELETE','/shelves/'+b+'/members/'+member.user.id,owner);assert.equal(removed.statusCode,204);
    await noLeak(media(p),member);
    assert.equal((await call('HEAD',media(p),member)).statusCode,404);
    await noLeak(path(pub,'/now'),member);
    assert.equal((await call('GET','/items/'+one+'/content',member)).statusCode,200);
    const reminder=await listen(pub,owner);
    db.prepare('UPDATE shelves SET private=1 WHERE id=?').run(a);
    await noLeak(media(reminder),owner);
    time+=1000;
    assert.equal((await listen(pub,owner)).title,'Synthetic Title B');
    const edited=await json('PUT',path(privateStation),owner,{...body('Replacement','private'),revision:privateStation.revision});
    privateStation=edited.station;
    await app.close();app=await createApp(options);
    assert.equal((await listen(privateStation,owner)).title,'Synthetic Title B');
    assert.equal((await call('DELETE',path(privateStation),owner,{revision:privateStation.revision})).statusCode,204);
    await noLeak(path(privateStation,'/now'),owner);
    const deletion=await call('DELETE','/playlists/'+first.id,owner,{revision:first.revision});
    assert.equal(deletion.statusCode,204);await noLeak(path(pub,'/now'),owner);
    assert.ok((await json('GET',stations,owner)).stations.every(row=>row.id!==pub.id));
  }finally{db?.close();await app?.close();}
});
