// Local QA only: reviewed native voice, synthetic private library, localhost Chrome.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {createServer,mergeConfig} from 'vite';
import baseConfig from '../vite.config.js';
import {createApp} from '../server/app.js';
import {loadRadioFm} from '../server/radio-fm.js';
import {loadDynamicRenderer} from '../server/radio-dynamic-render.js';
import {createAiStore} from '../server/ai-store.js';
import {resolveAiInput} from '../server/ai-input.js';
import {ffmpegPath} from '../server/media.js';

const [config,pack]=process.argv.slice(2);
if(!config||!pack)throw Error('Use prepared local native config and verified radio pack');
const home=await mkdtemp(join(tmpdir(),'mirea-real-dynamic-qa-'));
const nativeRender=await loadDynamicRenderer(config,await loadRadioFm(pack));
const results=[],epoch=Date.now(), exec=promisify(execFile);
let app,vite,browser, time=epoch, running=null, db;
const now=()=>running===null?time:Date.now()+running;
const call=(method,path,user,body)=>app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},payload:body});
async function json(method,path,user,body,code=200){
  const r=await call(method,path,user,body);assert.equal(r.statusCode,code,r.body);return r.json();
}
async function ready(index){
  for(let i=0;i<900;i++){if(results[index]){await wait(30);return results[index];}await wait(100);}
  throw Error('Renderer did not finish');
}

try{
  app=await createApp({dataDir:home,allowRegistration:true,rateLimit:false,radioDir:'',radioStations:true,radioFmDir:pack,
    radioNow:now,radioDynamicPoll:25,radioDynamicRenderer:async(requests,prefs,signal)=>{
      const clips=await nativeRender(requests,prefs,signal);
      results.push({requests,clips});return clips;
    }});
  const register=name=>json('POST','/auth/register',null,{name,email:name+'@example.test',password:'synthetic-radio-dynamic-pass',remember:false},201);
  const owner=await register('owner'), listener=await register('listener'), outsider=await register('outsider');
  const shelf=(await json('POST','/shelves',owner,{name:'QA'} ,201)).id;
  await json('POST','/shelves/'+shelf+'/members',owner,{email:listener.user.email,role:'viewer'},201);
  db=new DatabaseSync(join(home,'mirea.sqlite'));
  const tracks=[], words=['Moonlit Walk','Distant Lighthouse'];
  for(const [i,word] of words.entries()){
    const id=randomUUID(), file=join(home,'uploads',id);
    await exec(ffmpegPath(),['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency='+(440+i*240)+':duration=14',
      '-c:a','aac','-b:a','96k','-movflags','+faststart','-f','ipod',file],{timeout:15000,windowsHide:true});
    db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,shelf,word,'qa.m4a','audio/mp4',(await stat(file)).size,owner.user.id,epoch);
    db.prepare('INSERT INTO audio_assets VALUES(?,?,0)').run(id,JSON.stringify({duration:14}));
    tracks.push(id);
  }
  const row=db.prepare('SELECT * FROM items WHERE id=?').get(tracks[0]);
  const input=await resolveAiInput({db,uploadDir:join(home,'uploads'),originalDir:join(home,'originals')},row);
  createAiStore(db).publish(row,'structure',input.stamp,'fixture-saved-previous-analysis',
    {segments:[{id:'intro',startMs:0,endMs:4500,kind:'intro',label:'イントロ'},{id:'verse',startMs:4500,endMs:14000,kind:'verse',label:'Aメロ'}]},
    {totalUnits:1,durationMs:14000});
  const {playlist}=await json('POST','/playlists',owner,{title:'QA source'},201);
  await json('PUT','/playlists/'+playlist.id,owner,{title:playlist.title,revision:playlist.revision,assetIds:tracks});
  const {station}=await json('POST','/radio/stations',owner,{name:'星あかりラジオ',visibility:'public',playlistId:playlist.id,
    fm:{mc:'enhanced',jingle:'standard'}},201);
  const nowPath='/radio/stations/'+station.id+'/now', audioPath=program=>program.mediaUrl.slice('/api/v1'.length);
  const first=await ready(0);
  assert.equal(first.clips.size,1);
  assert.equal(first.requests[0].quality,'standard','reuse persisted short-intro hint');
  assert.match(first.requests[0].text,/Moonlit Walk/);
  assert.equal((await json('GET',nowPath,listener)).title,words[0]);
  time=epoch+56050;
  const a=await json('GET',nowPath,owner), b=await json('GET',nowPath,listener);
  assert.deepEqual(a,b);
  assert.equal(a.kind,'mc');
  const audio=await call('GET',audioPath(a),listener);
  assert.deepEqual(audio.rawPayload,first.clips.get('mc-1').bytes);
  assert.equal((await call('GET',audioPath(a))).statusCode,401);
  assert.equal((await call('HEAD',audioPath(a),outsider)).statusCode,404);
  assert.equal((await call('GET',nowPath,outsider)).statusCode,404);

  await app.listen({host:'127.0.0.1',port:0});
  vite=await createServer(mergeConfig(baseConfig,{configFile:false,cacheDir:join(home,'vite-cache'),
    server:{host:'127.0.0.1',port:0,watch:null,hmr:false,proxy:{'/api':'http://127.0.0.1:'+app.server.address().port}}}));
  await vite.listen();
  const origin='http://127.0.0.1:'+vite.httpServer.address().port,errors=[];
  browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.MIREA_UI_BROWSER?{executablePath:process.env.MIREA_UI_BROWSER}:{})});
  async function client(user){
    const ctx=await browser.newContext({serviceWorkers:'block'});
    await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort('blockedbyclient'));
    await ctx.addInitScript(user=>sessionStorage.setItem('mirea.session:web',JSON.stringify({origin:'',remember:false,session:user})),user);
    const page=await ctx.newPage();page.on('pageerror',err=>errors.push(err.message));
    await page.goto(origin);
    if(await page.locator('#open-drawer').isVisible())await page.locator('#open-drawer').click();
    await page.locator('#nav-radio').click();
    await page.locator('[data-station="'+station.id+'"]').click();
    await page.getByRole('button',{name:'この局を聴く',exact:true}).click();
    return page;
  }
  const sessions=await Promise.all([client(owner),client(listener)]);
  const start=p=>p.getByRole('button',{name:'聴く',exact:true}).click();
  await sessions[0].evaluate(()=>{
    const audio=document.querySelector('dialog[open] audio'),ctx=new AudioContext(), analyzer=ctx.createAnalyser();
    analyzer.fftSize=1024;ctx.createMediaElementSource(audio).connect(analyzer).connect(ctx.destination);
    document.querySelector('dialog[open] .radio-player button.primary').addEventListener('click',()=>void ctx.resume(),{once:true});
    const data=new Float32Array(analyzer.fftSize), marks=[], samples=[];
    const status=document.getElementById('radio-status');
    new MutationObserver(()=>marks.push({title:status.textContent,at:performance.now()})).observe(status,{childList:true});
    function collect(){
      analyzer.getFloatTimeDomainData(data);
      samples.push({at:performance.now(),audible:Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length)>0.0025});
      if(samples.length<1500)requestAnimationFrame(collect);
    }
    requestAnimationFrame(collect);
    window.dynamicRadioMeasurement={marks,samples};
  });
  // Hold the shared wall clock in the chosen cue while independently joining;
  // browser/ffmpeg scheduling must not accidentally take us into another round.
  time=epoch+56050;
  await start(sessions[0]);await sessions[0].waitForFunction(()=>document.querySelector('#radio-status').textContent.includes('VOICEVOX Nemo'));
  const position=p=>p.locator('dialog[open] audio').evaluate(a=>({duration:a.duration,time:a.currentTime,paused:a.paused}));
  const firstPosition=await position(sessions[0]);
  await wait(300);
  await start(sessions[1]);await sessions[1].waitForFunction(()=>document.querySelector('#radio-status').textContent.includes('VOICEVOX Nemo'));
  const secondPosition=await position(sessions[1]);
  const positions=[firstPosition,secondPosition];
  assert.ok(positions.every(x=>!x.paused&&Math.abs(x.duration-a.durationMs/1000)<0.08),JSON.stringify({positions,apiDuration:a.durationMs}));
  assert.ok(Math.abs(firstPosition.time-secondPosition.time)<0.5,JSON.stringify(positions));
  const resume=await position(sessions[0]);
  time=epoch+56000+Math.round(resume.time*1000);
  running=time-Date.now();
  await Promise.all(sessions.map(p=>p.getByText('星あかりラジオ · Distant Lighthouse',{exact:true}).waitFor()));
  assert.ok((await Promise.all(sessions.map(p=>p.locator('dialog[open] audio').evaluate(a=>a.readyState>=2&&!a.paused)))).every(Boolean));
  await wait(330);
  const decodedQuietMs=await sessions[0].evaluate(()=>{
    const {marks,samples}=window.dynamicRadioMeasurement;
    return marks.filter(row=>row.title.endsWith('Moonlit Walk'))
      .map(row=>{
        const end=samples.findLast(x=>x.at<row.at&&x.audible), next=samples.find(x=>x.at>=row.at&&x.audible);
        return end&&next?Math.round(next.at-end.at):null;
      });
  });
  assert.equal(decodedQuietMs.length,1);
  assert.ok(decodedQuietMs.every(x=>x!==null&&x<850),JSON.stringify(decodedQuietMs));
  assert.deepEqual(errors,[]);

  time=now();running=null;
  const next=await ready(1);
  assert.equal(next.clips.size,1);
  assert.notEqual(next.requests[0].text,first.requests[0].text);
  assert.notDeepEqual(next.clips.get('mc-1').bytes,first.clips.get('mc-1').bytes);
  const sum=Array.from(first.clips.values()).reduce((s,x)=>s+x.durationMs,0);
  time=epoch+28000+28000+sum+28050;
  const nextAir=await json('GET',nowPath,listener);
  assert.equal(nextAir.kind,'mc');
  assert.deepEqual((await call('GET',audioPath(nextAir),listener)).rawPayload,next.clips.get('mc-1').bytes);
  db.prepare('DELETE FROM memberships WHERE shelf_id=? AND user_id=?').run(shelf,listener.user.id);
  assert.equal((await call('GET',audioPath(nextAir),listener)).statusCode,404);
  console.log(JSON.stringify({verified:'local renderer+live browser; neither listener synthesizes; next song and next cycle follow server',currentCue:a.durationMs,nextCue:nextAir.durationMs,decodedQuietMs,
    firstHash:createHash('sha256').update(first.clips.get('mc-1').bytes).digest('hex'),
    nextHash:createHash('sha256').update(next.clips.get('mc-1').bytes).digest('hex')}));
}finally{
  db?.close();await browser?.close();await vite?.close();await app?.close();await rm(home,{recursive:true,force:true});
}
