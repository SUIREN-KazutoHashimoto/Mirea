import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.js';
import {openDatabase} from '../server/database.js';
import {buildAutodjPlan,rotationTracks,defaultAutodj,maxRotationTracks} from '../server/radio-autodj.js';
import {createDynamicRadio} from '../server/radio-dynamic.js';

test('v29 migration leaves current station and FM settings intact with implicit legacy defaults',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'mirea-autodj-migration-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const file=join(folder,'db');
  let db=openDatabase(file);
  db.exec(`INSERT INTO users VALUES('usr','a@example.test','Owner','hash',1);
    INSERT INTO playlists VALUES('playlist','usr','playlist',1,1,1);
    INSERT INTO radio_stations VALUES('station','usr','playlist','Name','private',NULL,1,1);
    INSERT INTO radio_fm_profiles VALUES('station','enhanced','standard');
    DROP TABLE radio_autodj; UPDATE schema_version SET version=29;`);
  db.close();db=openDatabase(file);
  try{
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version,31);
    assert.equal(db.prepare('SELECT count(*) n FROM radio_autodj').get().n,0);
    assert.equal(db.prepare('SELECT name FROM radio_stations').get().name,'Name');
    assert.equal(db.prepare('SELECT mc FROM radio_fm_profiles').get().mc,'enhanced');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});

test('shared ordered and shuffled rotations survive restart and do not widen playlist or track access',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mirea-autodj-api-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let now=Date.now(),app,db;
  const options={dataDir:root,radioDir:'',radioStations:true,radioNow:()=>now,rateLimit:false,allowRegistration:true};
  const base='/radio/stations';
  const call=(method,path,user,payload)=>app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},payload});
  const json=async(method,path,user,body,expected=200)=>{
    const result=await call(method,path,user,body);assert.equal(result.statusCode,expected,result.body);return result.json();
  };
  const register=name=>json('POST','/auth/register',null,{name,email:name+'@example.test',password:'synthetic-safe-radio-pass',remember:false},201);
  try{
    app=await createApp(options);
    const owner=await register('owner'), member=await register('member');
    const [a,b,c]=await Promise.all([['A',owner],['B',owner],['C',member]].map(async([name,user])=>(await json('POST','/shelves',user,{name},201)).id));
    const allow=async id=>json('POST','/shelves/'+id+'/members',owner,{email:member.user.email,role:'viewer'},201);
    await allow(a);
    db=new DatabaseSync(join(root,'mirea.sqlite'));db.exec('PRAGMA foreign_keys=ON');
    async function mock(shelf,user,title){
      const id=randomUUID(),bytes=Buffer.from(title);
      db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,shelf,title,'mock.m4a','audio/mp4',bytes.length,user.user.id,now);
      db.prepare('INSERT INTO audio_assets VALUES(?,?,0)').run(id,JSON.stringify({duration:6}));
      await writeFile(join(root,'uploads',id),bytes);
      return id;
    }
    const [first,second,third,foreign]=await Promise.all([['A1',a,owner],['A2',a,owner],['B1',b,owner],['Foreign',c,member]]
      .map(([title,shelf,user])=>mock(shelf,user,title)));
    const playlist=async(user,title,assetIds)=>{
      const value=(await json('POST','/playlists',user,{title},201)).playlist;
      return (await json('PUT','/playlists/'+value.id,user,{revision:value.revision,title,assetIds})).playlist;
    };
    let left=await playlist(owner,'Primary confidential source',[first,second]), right=await playlist(owner,'Secondary confidential source',[second,third]);
    const forbidden=await playlist(member,'Foreign source',[foreign]);
    const payload={name:'Shared station',playlistId:left.id,visibility:'public'};
    const desired={mode:'ordered',playlistIds:[left.id,right.id]};
    const make=(user,playlistIds)=>json('POST',base,user,{...payload,autodj:{mode:'ordered',playlistIds}},422);
    await make(owner,[left.id,randomUUID()]);await make(owner,[left.id,'not-a-uuid']);
    await make(owner,[left.id,left.id]);await make(owner,[right.id,left.id]);await make(owner,[left.id,forbidden.id]);
    await make(member,[left.id,right.id]);
    let {station}=await json('POST',base,owner,{...payload,autodj:desired},201);
    const path=base+'/'+station.id, epoch=now;
    const tune=user=>json('GET',path+'/now',user);
    assert.equal((await json('GET','/config',owner)).radioAutodj,true);
    assert.deepEqual(station.autodj,desired);
    assert.deepEqual((await json('GET',base,member)).stations,[{id:station.id,name:'Shared station',visibility:'public',mine:false}]);
    await json('GET',path+'/now',member,undefined,404);
    const fromOwner=await tune(owner);
    assert.equal(fromOwner.title,'A1');assert.equal(fromOwner.nextTitle,'A2');
    const media=value=>value.mediaUrl.slice('/api/v1'.length);
    assert.equal((await call('HEAD',media(fromOwner),member)).statusCode,404);
    await allow(b);
    assert.deepEqual(await tune(owner),await tune(member));
    assert.equal((await call('GET',media(fromOwner),member)).body,'A1');
    now=epoch+6001;assert.equal((await tune(member)).title,'A2');
    now=epoch+12001;assert.equal((await tune(member)).title,'B1','playlist overlap is deduplicated');
    now=epoch+18001;assert.equal((await tune(member)).title,'A1');
    now=epoch+2000;
    ({station}=await json('PUT',path,owner,{...payload,revision:station.revision}));
    assert.deepEqual(station.autodj,desired,'legacy clients do not delete other sources when editing');
    await json('PUT',path,member,{...payload,revision:station.revision,autodj:desired},404);
    ({station}=await json('PUT',path,owner,{...payload,revision:station.revision,autodj:{...desired,mode:'shuffle'}}));
    const start=now;
    const collection=[];
    for(let i=0;i<3;i++){now=start+6000*i+1;collection.push((await tune(member)).title);}
    assert.deepEqual([...collection].sort(),['A1','A2','B1']);
    now=start+18001;
    const following=await tune(member);
    assert.notEqual(following.title,collection[0],'next cycle genuinely rotates');
    const otherSession=await tune(owner);assert.deepEqual(following,otherSession);
    ({station}=await json('PUT',path,owner,{...payload,name:'Renamed station',revision:station.revision}));
    left=(await json('PUT','/playlists/'+left.id,owner,{title:'Renamed playlist',revision:left.revision,assetIds:left.assetIds})).playlist;
    const renamed=await tune(member);
    assert.equal(renamed.station,'Renamed station');assert.equal(renamed.title,following.title);
    assert.equal(renamed.startTime,following.startTime);assert.equal(renamed.mediaUrl,following.mediaUrl);
    await app.close();app=await createApp(options);
    assert.deepEqual(await tune(member),renamed,'restart at same wall time has exact program and generation');
    await call('DELETE','/shelves/'+b+'/members/'+member.user.id,owner);
    assert.equal((await call('HEAD',media(following),member)).statusCode,404);
    await json('GET',path+'/now',member,undefined,404);
    await call('DELETE','/playlists/'+right.id,owner,{revision:right.revision});
    await json('GET',path+'/now',owner,undefined,404);
    assert.equal((await call('HEAD',media(following),owner)).statusCode,404);
    ({station}=await json('PUT',path,owner,{...payload,revision:station.revision,autodj:defaultAutodj(left.id)}));
    assert.equal((await tune(owner)).title,'A1');
    assert.equal(db.prepare('SELECT count(*) n FROM radio_autodj').get().n,0);
  }finally{db?.close();await app?.close();}
});

test('aggregate track cap and generation-safe dynamic MC follow the shuffled next cycle, including the wrap',async()=>{
  const tracks=Array.from({length:6},(_,i)=>({id:String(i),title:'Track '+i,durationMs:5000}));
  const station={id:'s',user_id:'u',name:'Test',revision:1,epoch:0};
  const all=Array.from({length:maxRotationTracks+1},(_,i)=>({id:String(i),durationMs:5000}));
  assert.equal(buildAutodjPlan(station,{mode:'ordered',playlistIds:['big']},()=>({owner:'u',revision:1,tracks:all})),null);
  const plan=buildAutodjPlan(station,{mode:'shuffle',playlistIds:['a','b']},
    id=>({owner:'u',revision:1,tracks:id==='a'?tracks.slice(0,3):tracks.slice(3)}));
  let clock=0;
  const queued=[];
  const planner=createDynamicRadio({scheduler:false,now:()=>clock,scan:()=>[{station,plan,prefs:{mc:'enhanced',jingle:'standard'}}],
    render:async requests=>{
      queued.push(requests);
      return new Map(requests.map(req=>[req.id,{durationMs:9400,bytes:Buffer.from(req.text),credit:'Synthetic'}]));
    }});
  try{
    await planner.pump();
    const next=rotationTracks(station,plan,1), following=rotationTracks(station,plan,2);
    assert.ok(queued[0].find(req=>req.id==='mc-'+(tracks.length-1)).text.includes(following[0].title));
    assert.ok(queued[0].find(req=>req.id==='mc-0').text.includes(next[1].title));
    clock=30003;
    const state=planner.current(station,plan);
    assert.deepEqual(state.segments.filter(segment=>segment.kind!=='mc').map(x=>x.id),next.map(x=>x.id));
    assert.equal(state.segments.filter(segment=>segment.kind==='mc').length,tracks.length);
  }finally{await planner.close();}
});
