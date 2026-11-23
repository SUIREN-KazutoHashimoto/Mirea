// Linux verification inside the exact candidate image. No user data, vendor assets in
// the image, or network needed inside the container. See radio-voicevox-linux.md.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as sleep} from 'node:timers/promises';
assert.equal(process.platform,'linux');
assert.equal(process.arch,'x64');
assert.equal(process.getuid(),1000);
const root=pathToFileURL(process.cwd()+'/'), mod=p=>import(new URL('server/'+p,root));
const {createApp}=await mod('app.js');
const {loadDynamicRenderer}=await mod('radio-dynamic-render.js');
const {loadRadioFm}=await mod('radio-fm.js');
const {runAiProcess}=await mod('ai-runtime.js');
const {ffmpegPath}=await mod('media.js');
const {probeAudio}=await mod('audio-transcode.js');
const temp=await mkdtemp(join(tmpdir(),'mirea-voicevox-container-'));
const exec=promisify(execFile), hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pack=join(temp,'fm'), dataDir=join(temp,'data');
const configured=process.env.MIREA_TEST_VOICEVOX_CONFIG;
let app,db,time=Date.now();
const epoch=time;
const boot=(extras={})=>createApp({dataDir,mediaDir:dataDir,allowRegistration:true,rateLimit:false,
  radioDir:'',radioStations:true,radioFmDir:pack,radioNow:()=>time,radioDynamicPoll:150,...extras});
async function request(method,path,user,body,status=200,raw=false){
  const r=await app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},payload:body});
  assert.equal(r.statusCode,status,r.body);return raw?r.rawPayload:r.json();
}
const makeTone=async (file,hz,duration)=>exec(ffmpegPath(),['-hide_banner','-nostdin','-loglevel','error','-f','lavfi','-i',
  'sine=frequency='+hz+':duration='+duration,'-c:a','aac','-b:a','96k','-movflags','+faststart','-f','ipod',file],{timeout:15000});
const privateOptions=config=>({radioDynamicConfig:config});
try{
  await mkdir(pack);
  await writeFile(join(pack,'fm-pack.json'),JSON.stringify({version:1,clips:{}}));
  const unavailable=join(temp,'missing.json');
  // Independently confirms the packaged process boundary used by the renderer,
  // not just the absence of vendor data or availability of Python.
  const noConnect=await runAiProcess('/usr/bin/python3',['-E','-s','-B','-c',
    "import errno,socket\ntry: socket.create_connection(('127.0.0.1',9),1)\nexcept OSError as e: assert e.errno==errno.EPERM\nelse: raise RuntimeError('socket connect allowed')\nprint('network-denied')"],
    {timeout:10000,maxOutput:4096,env:{LD_LIBRARY_PATH:''}});
  assert.equal(noConnect.trim(),'network-denied');
  app=await boot(privateOptions(unavailable));
  assert.equal((await request('GET','/config')).radioDynamic,false);
  assert.equal((await app.inject('/')).statusCode,200);
  await app.close();app=null;
  if(!configured){
    console.log(JSON.stringify({containerLauncher:true,networkDenied:true,withoutVoiceAssets:'healthy-fallback',realVoice:false}));
  }else{
    assert.ok(configured.startsWith('/app/radio-voice/'),'Expected dedicated operator mount inside candidate image');
    // Verify configured model through the standard boot route. Separately capture
    // actual background encode completion to hold a deterministic synthetic clock.
    app=await boot(privateOptions(configured));
    assert.equal((await request('GET','/config')).radioDynamic,true);
    await app.close();app=null;
    const runtime=await loadDynamicRenderer(configured,await loadRadioFm(pack));
    const renders=[];
    app=await boot({radioDynamicRenderer:async(requests,prefs,signal)=>{
      const clips=await runtime(requests,prefs,signal);renders.push({requests,clips});return clips;
    }});
    const register=name=>request('POST','/auth/register',null,{name,email:name+'@example.test',password:'Synthetic-radio-qa-pass',remember:false},201);
    const owner=await register('owner'),listener=await register('listener'),outsider=await register('outsider');
    const shelf=(await request('POST','/shelves',owner,{name:'Synthetic audio'},201)).id;
    await request('POST','/shelves/'+shelf+'/members',owner,{email:listener.user.email,role:'viewer'},201);
    const ids=[];db=new DatabaseSync(join(dataDir,'mirea.sqlite'));
    for(const [i,title] of ['North tone','South tone'].entries()){
      const id=randomUUID(),file=join(dataDir,'uploads',id);await makeTone(file,440+i*220,10);
      db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,shelf,title,'fixture.m4a','audio/mp4',(await stat(file)).size,owner.user.id,epoch);
      db.prepare('INSERT INTO audio_assets VALUES(?,?,0)').run(id,JSON.stringify({duration:10}));
      ids.push(id);
    }
    const {playlist}=await request('POST','/playlists',owner,{title:'Synthetic tones'},201);
    await request('PUT','/playlists/'+playlist.id,owner,{title:playlist.title,revision:playlist.revision,assetIds:ids});
    const {station}=await request('POST','/radio/stations',owner,{name:'Synthetic station',visibility:'public',
      playlistId:playlist.id,fm:{mc:'standard',jingle:'off'}},201);
    const nowPath='/radio/stations/'+station.id+'/now';
    assert.equal((await request('GET',nowPath,listener)).title,'North tone');
    for(let i=0;i<900&&!renders.length;i++)await sleep(100);
    assert.equal(renders.length,1,'a background cue must be rendered before advancing the clock');
    const first=renders[0].clips.get('mc-1');
    assert.ok(first,'real VOICEVOX AAC cue required');await sleep(200);
    time=epoch+40050;
    const a=await request('GET',nowPath,owner),b=await request('GET',nowPath,listener);
    assert.deepEqual(a,b);assert.equal(a.kind,'mc');assert.equal(a.credit,'VOICEVOX Nemo');
    assert.equal(a.durationMs,first.durationMs);assert.ok(first.loudness>=-21&&first.loudness<=-14&&first.peak<=-1);
    const media=a.mediaUrl.slice('/api/v1'.length);
    for(const user of [owner,listener])assert.equal(hash(await request('GET',media,user,null,200,true)),hash(first.bytes));
    const decoded=join(temp,'decoded.m4a');await writeFile(decoded,first.bytes);
    const info=await probeAudio(decoded);
    assert.equal(info.audio.codec_name,'aac');assert.equal(info.audio.channels,2);
    assert.ok(Math.abs(info.duration-a.durationMs/1000)<0.08);
    assert.equal((await app.inject(a.mediaUrl)).statusCode,401);
    assert.equal((await app.inject({url:a.mediaUrl,headers:{authorization:'Bearer '+outsider.token}})).statusCode,404);
    const currentDb=db;db=null;currentDb.close();await app.close();app=null;
    // Reboot both valid and tampered configurations via genuine createApp.
    app=await boot(privateOptions(configured));
    assert.equal((await request('GET','/config')).radioDynamic,true);
    assert.equal((await request('GET',nowPath,listener)).title,'North tone','restart must not depend on stale prepared audio');
    await app.close();app=null;
    const invalid=join(temp,'bad.json'),cfg=JSON.parse(await readFile(configured,'utf8'));
    await writeFile(invalid,JSON.stringify({...cfg,modelSha256:'0'.repeat(64)}));
    app=await boot(privateOptions(invalid));
    assert.equal((await request('GET','/config')).radioDynamic,false);
    assert.equal((await request('GET',nowPath,listener)).title,'North tone');
    console.log(JSON.stringify({containerLauncher:true,networkDenied:true,withoutVoiceAssets:'healthy-fallback',tamperedChecksum:'healthy-fallback',
      realVoice:true,listeners:2,durationMs:a.durationMs,loudness:first.loudness,truePeak:first.peak,restart:'dry-then-reprepare'}));
  }
}finally{db?.close();await app?.close();await rm(temp,{recursive:true,force:true});}
