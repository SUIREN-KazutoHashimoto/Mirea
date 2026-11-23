// Local-only synthetic UI acceptance: directory, station selection, CRUD, visibility and links.
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {createServer,mergeConfig} from 'vite';
import baseConfig from '../vite.config.js';
import {createApp} from '../server/app.js';
import {ffmpegPath} from '../server/media.js';

const temp=await mkdtemp(join(tmpdir(),'mirea-radio-station-ui-'));
const errors=[];
let app,vite,browser;
try{
  const realPack=process.argv.find(arg=>arg.startsWith('--fm-pack='))?.slice('--fm-pack='.length);
  const fm=Boolean(realPack||process.argv.includes('--fm')), pack=realPack||(fm?join(temp,'pack'):'');
  if(fm&&!realPack){
    const voice=join(temp,'mock-voice');await mkdir(voice);
    const files={};
    for(const [quality,hz] of [['standard',510],['enhanced',650]]){
      const path=join(voice,'mc-'+quality+'.wav');
      await promisify(execFile)(ffmpegPath(),['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency='+hz+':duration=2.6',path],{timeout:15000,windowsHide:true});
      files[quality]=createHash('sha256').update(await readFile(path)).digest('hex');
    }
    await writeFile(join(voice,'voice-render.json'),JSON.stringify({version:1,credit:'Mock MC tone',modelSha256:'0'.repeat(64),files}));
    await promisify(execFile)(process.execPath,['scripts/prepare-radio-fm.mjs','--out',pack,'--voice',voice],{timeout:45000,windowsHide:true});
  }
  const fmAssets=fm?JSON.parse(await readFile(join(pack,'fm-pack.json'),'utf8')).clips:null;
  let time=Date.now(),clockOffset;
  app=await createApp({dataDir:temp,radioDir:'',radioStations:true,radioFmDir:pack,radioNow:()=>clockOffset===undefined?time:Date.now()+clockOffset,allowRegistration:true,rateLimit:false});
  const request=async(method,path,body,token,code=200)=>{
    const r=await app.inject({method,url:'/api/v1'+path,payload:body,headers:token?{authorization:'Bearer '+token}:{}});
    assert.equal(r.statusCode,code,r.body);return r.json();
  };
  const register=name=>request('POST','/auth/register',{name,email:name+'@example.test',password:'synthetic-local-radio-pass',remember:false},null,201);
  const owner=await register('owner'), listener=await register('listener');
  const shelf=(await request('POST','/shelves',{name:'Synthetic shelf'},owner.token,201)).id;
  const privateShelf=(await request('POST','/shelves',{name:'Private excluded shelf'},owner.token,201)).id;
  await request('POST','/shelves/'+shelf+'/members',{email:listener.user.email,role:'viewer'},owner.token,201);
  const db=new DatabaseSync(join(temp,'mirea.sqlite'));
  const sources=[];
  try{
    db.prepare('UPDATE shelves SET private=1 WHERE id=?').run(privateShelf);
    const privateId=randomUUID();
    db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(privateId,privateShelf,'Private Excluded Song','private.m4a','audio/mp4',100,owner.user.id,time);
    for(const label of ['First','Second']){
      const id=randomUUID(),file=join(temp,'uploads',id);
      await promisify(execFile)(ffmpegPath(),['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=12',
        '-c:a','aac','-b:a','64k','-movflags','+faststart','-f','ipod',file],{timeout:15000,windowsHide:true});
      db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,shelf,label+' Song','song.m4a','audio/mp4',(await stat(file)).size,owner.user.id,time);
      db.prepare('INSERT INTO audio_assets VALUES(?,?,0)').run(id,JSON.stringify({duration:12}));
      const {playlist}=await request('POST','/playlists',{title:label+' List'},owner.token,201);
      await request('PUT','/playlists/'+playlist.id,{title:playlist.title,revision:playlist.revision,assetIds:[id]},owner.token);
      sources.push(playlist.id);
    }
  }finally{db.close();}
  await app.listen({host:'127.0.0.1',port:0});
  vite=await createServer(mergeConfig(baseConfig,{configFile:false,cacheDir:join(temp,'vite-cache'),
    server:{host:'127.0.0.1',port:0,watch:null,hmr:false,proxy:{'/api':'http://127.0.0.1:'+app.server.address().port}}}));
  await vite.listen();
  const origin='http://127.0.0.1:'+vite.httpServer.address().port;
  browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.MIREA_UI_BROWSER?{executablePath:process.env.MIREA_UI_BROWSER}:{})});
  async function open(user,path=origin){
    const context=await browser.newContext({serviceWorkers:'block'});
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      return url.origin===origin&&!/^\/api\/v1\/analytics(?:\/|$)/.test(url.pathname)?route.continue():route.abort('blockedbyclient');
    });
    await context.addInitScript(user=>sessionStorage.setItem('mirea.session:web',JSON.stringify({origin:'',remember:false,session:user})),user);
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(path);return page;
  }
  const directory=async page=>{
    const drawer=page.locator('#open-drawer');
    await page.locator('#open-drawer:visible,#nav-radio:visible').first().waitFor();
    if(await drawer.isVisible()&&!(await page.locator('#nav-radio').isVisible()))await drawer.click();
    await page.locator('#nav-radio').click();
    await page.locator('.radio-directory').waitFor();
  };
  const ownerPage=await open(owner);await directory(ownerPage);
  const action=(page,name)=>page.locator('[data-radio="'+name+'"]');
  const chosen=page=>page.locator('[data-station][aria-pressed=true]').getAttribute('data-station');
  const selectStation=(page,id)=>page.locator('[data-station="'+id+'"]').click();
  async function create(name, playlist, visibility){
    await action(ownerPage,'new').click();
    await ownerPage.locator('[name=stationName]').fill(name);
    await ownerPage.locator('[name=playlist]').selectOption(playlist);
    await ownerPage.locator('[name=visibility]').selectOption(visibility);
    await ownerPage.getByRole('button',{name:'保存',exact:true}).click();
    await ownerPage.getByText('保存しました。').waitFor();
  }
  await create('Named Public',sources[0],'public');
  const publicId=await chosen(ownerPage);
  await create('Named Hidden',sources[1],'unlisted');
  const hiddenId=await chosen(ownerPage);
  const oldLink=await action(ownerPage,'link').locator('input').inputValue();
  assert.ok(oldLink.startsWith(origin+'/#mirea-radio='+hiddenId+'.'));
  await create('Named Private',sources[1],'private');
  const privateStationId=await chosen(ownerPage);
  await action(ownerPage,'edit').click();
  await action(ownerPage,'tracks').click();
  const pick=ownerPage.locator('.radio-track-picker'),
    firstSong=pick.getByRole('button',{name:/First Songを曲リストに追加/}),
    secondSong=pick.getByRole('button',{name:/Second Songを曲リストから外す/});
  await firstSong.waitFor();
  assert.equal(await pick.getByText('Private Excluded Song').count(),0);
  assert.equal(await firstSong.locator('img[data-thumbnail]').count(),1,'normal content thumbnail card');
  assert.equal(await secondSong.getAttribute('aria-pressed'),'true','selected source copied');
  await pick.locator('[name=query]').fill('First');
  assert.equal(await pick.getByText('Second Song',{exact:true}).count(),0,'search narrows cards without removing order');
  await firstSong.click();
  await pick.locator('[name=query]').fill('');
  await pick.getByRole('button',{name:'2番目を前へ'}).click();
  const newName='Trial ordered source';
  await pick.locator('[name=title]').fill(newName);
  await pick.getByRole('button',{name:'作成',exact:true}).click();
  await pick.waitFor({state:'hidden'});
  const newId=await ownerPage.locator('[name=playlist]').inputValue();
  assert.ok(!sources.includes(newId));
  await ownerPage.getByRole('button',{name:'保存',exact:true}).click();
  await ownerPage.getByText('保存しました。').waitFor();
  const {playlists:existing}=await request('GET','/playlists',undefined,owner.token);
  const expectedOrder=sources.map(source=>existing.find(p=>p.id===source).assetIds[0]);
  assert.deepEqual(existing.find(p=>p.id===newId).assetIds,expectedOrder);
  assert.equal(existing.find(p=>p.id===sources[1]).assetIds.length,1,'original list unchanged');
  const {stations}=await request('GET','/radio/stations',undefined,owner.token);
  assert.equal(stations.find(s=>s.id===privateStationId).playlistId,newId);
  const capabilities=await request('GET','/config',undefined,owner.token);
  if(!capabilities.radioAutodj){
    await action(ownerPage,'edit').click();
    assert.equal(await action(ownerPage,'autodj').isVisible(),false,'legacy server never offers AutoDJ settings');
    await action(ownerPage,'cancel').click();
  }
  if(capabilities.radioAutodj){
    await action(ownerPage,'edit').click();
    await ownerPage.locator('[name=autodjMode]').selectOption('shuffle');
    await action(ownerPage,'autodj-add').click();
    await action(ownerPage,'autodj-sources').locator('select').selectOption(sources[1]);
    await ownerPage.getByRole('button',{name:'保存',exact:true}).click();
    await ownerPage.getByText('保存しました。').waitFor();
    await action(ownerPage,'edit').click();
    assert.equal(await ownerPage.locator('[name=autodjMode]').inputValue(),'shuffle','mode persisted via effective API integration');
    assert.equal(await action(ownerPage,'autodj-sources').locator('select').inputValue(),sources[1],'source persisted');
    await ownerPage.locator('[name=stationName]').fill('Named Private Updated');
    await ownerPage.getByRole('button',{name:'保存',exact:true}).click();
    await ownerPage.getByText('保存しました。').waitFor();
    const refreshed=await request('GET','/radio/stations',undefined,owner.token);
    assert.deepEqual(refreshed.stations.find(station=>station.id===privateStationId).autodj,{mode:'shuffle',playlistIds:[newId,sources[1]]},'editing only the name preserves the full AutoDJ configuration');
  }



  const listenerPage=await open(listener);await directory(listenerPage);
  await listenerPage.getByRole('button',{name:/Named Public/}).waitFor();
  assert.deepEqual(await action(listenerPage,'stations').locator('.media-card h3').allTextContents(),['Named Public']);
  await action(listenerPage,'search').fill('not-present');
  assert.equal(await action(listenerPage,'stations').locator('.media-card').count(),0);
  assert.equal(await action(listenerPage,'listen').isDisabled(),true);
  await action(listenerPage,'search').fill('Named Public');
  await action(listenerPage,'owned').click();
  assert.equal(await action(listenerPage,'stations').locator('.media-card').count(),0,'listener owns no station');
  await action(listenerPage,'owned').click();
  await selectStation(listenerPage,publicId);
  await action(listenerPage,'listen').click();
  const setVolume=async(page,target)=>{
    const control=page.getByRole('slider',{name:'ラジオ音量'});
    await control.evaluate((element,value)=>{element.value=String(value+1);},target);
    await control.press('ArrowLeft');
    assert.equal(await control.inputValue(),String(target));
    assert.equal(await control.getAttribute('aria-valuetext'),target+'パーセント');
  };
  const verifyVolume=async(page,target)=>{
    assert.ok(Math.abs(await page.locator('dialog[open] .radio-player audio:not([data-radio])').evaluate(audio=>audio.volume)-target/100)<0.001);
    assert.equal(await page.getByRole('slider',{name:'ラジオ音量'}).inputValue(),String(target));
  };
  await setVolume(listenerPage,37);
  await listenerPage.evaluate(async()=>{
    const {mountMediaSession}=await import('/src/media-session.js');
    const duration=8000,bytes=new ArrayBuffer(44+duration*2),view=new DataView(bytes);
    const text=(pos,name)=>Array.from(name,(ch,index)=>view.setUint8(pos+index,ch.charCodeAt(0)));
    text(0,'RIFF');view.setUint32(4,36+duration*2,true);text(8,'WAVE');text(12,'fmt ');
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
    text(36,'data');view.setUint32(40,duration*2,true);
    for(let i=0;i<duration;i++)view.setInt16(44+i*2,Math.floor(1800*Math.sin(i/8000*440*2*Math.PI)),true);
    const objectUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
    const audio=new Audio(objectUrl);audio.loop=true;
    const binding=mountMediaSession(audio,{title:'Synthetic background music',kind:'audio'});
    window.musicTest={audio,binding,objectUrl};
    await audio.play();
  });
  assert.equal(await listenerPage.evaluate(()=>window.musicTest.audio.paused),false);

  await listenerPage.getByRole('button',{name:'聴く',exact:true}).click();
  await listenerPage.getByText('Named Public · First Song').waitFor();
  await verifyVolume(listenerPage,37);
  assert.equal(await listenerPage.locator('dialog[open] .radio-player audio:not([data-radio])').evaluate(audio=>audio.paused),false);
  assert.equal(await listenerPage.locator('.radio-listen').getAttribute('data-radio-state'),'live');
  assert.equal(await listenerPage.evaluate(()=>window.musicTest.audio.paused),true,'ordinary background music pauses on live takeover');
  assert.equal(await listenerPage.evaluate(()=>navigator.mediaSession.metadata?.title),'First Song');

  assert.equal(await listenerPage.locator('[data-radio-title]').textContent(),'First Song');
  assert.equal(await listenerPage.locator('dialog[open] input[type=range]').count(),1,'only volume, no fake seek');
  await listenerPage.getByRole('button',{name:'一時停止',exact:true}).click();
  assert.equal(await listenerPage.locator('.radio-listen').getAttribute('data-radio-state'),'paused');
  await listenerPage.getByRole('button',{name:'聴く',exact:true}).click();
  await listenerPage.locator('.radio-listen[data-radio-state=live]').waitFor();
  await listenerPage.getByRole('button',{name:'局一覧に戻る',exact:true}).click();
  await listenerPage.waitForFunction(()=>navigator.mediaSession.metadata?.title==='Synthetic background music');
  assert.equal(await listenerPage.evaluate(()=>window.musicTest.audio.paused),true,'return does not auto-resume music');
  await listenerPage.evaluate(()=>{
    const {audio,binding,objectUrl}=window.musicTest;binding.dispose();audio.src='';URL.revokeObjectURL(objectUrl);delete window.musicTest;
  });

  await listenerPage.locator('.radio-directory').waitFor();
  await listenerPage.evaluate(hash=>{location.hash=hash;},new URL(oldLink).hash);
  await listenerPage.getByRole('button',{name:'聴く',exact:true}).click();
  await listenerPage.getByText('Named Hidden · Second Song').waitFor();
  await verifyVolume(listenerPage,37);
  await listenerPage.setViewportSize({width:390,height:844});
  await listenerPage.reload();
  await directory(listenerPage);
  await action(listenerPage,'stations').locator('.media-card').first().waitFor();
  assert.equal(await action(listenerPage,'stations').evaluate(grid=>getComputedStyle(grid).gridTemplateColumns.split(' ').length),2,'390px station cards are two across');
  assert.ok(await listenerPage.locator('.radio-directory').evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth+1),'390px station picker fits');
  await action(listenerPage,'listen').click();
  await verifyVolume(listenerPage,37);
  assert.ok(await listenerPage.locator('.radio-listener').evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth+1),'390px live controls fit');

  const linked=await open(listener,oldLink);
  await linked.getByRole('button',{name:'聴く',exact:true}).click();
  await linked.getByText('Named Hidden · Second Song').waitFor();
  assert.equal(new URL(linked.url()).hash,'');
  await selectStation(ownerPage,hiddenId);
  await action(ownerPage,'edit').click();
  await ownerPage.locator('[name=stationName]').fill('Named Hidden Edited');
  await ownerPage.getByRole('button',{name:'保存',exact:true}).click();
  await ownerPage.getByText('保存しました。').waitFor();
  await action(ownerPage,'edit').click();
  ownerPage.once('dialog',dialog=>dialog.accept());
  await action(ownerPage,'rotate').click();
  await ownerPage.getByText('リンクを更新しました。').waitFor();
  const freshLink=await action(ownerPage,'link').locator('input').inputValue();
  assert.notEqual(freshLink,oldLink);
  const stale=await open(listener,oldLink);
  await stale.getByRole('button',{name:'聴く',exact:true}).click();
  await stale.getByText(/この局は再生できません。/).waitFor();
  await action(ownerPage,'edit').click();
  ownerPage.once('dialog',dialog=>dialog.accept());
  await action(ownerPage,'delete').click();
  await ownerPage.getByText('ラジオ局を削除しました。').waitFor();
  assert.ok(!(await action(ownerPage,'stations').locator('.media-card h3').allTextContents()).some(s=>s.includes('Named Hidden')));
  if(fm){
    await selectStation(ownerPage,publicId);
    await action(ownerPage,'edit').click();
    await ownerPage.locator('[name=mc]').selectOption('enhanced');
    await ownerPage.locator('[name=jingle]').selectOption('standard');
    await action(ownerPage,'preview-mc').click();
    await action(ownerPage,'fm-sample').waitFor();
    await ownerPage.waitForFunction(()=>document.querySelector('[data-radio="fm-sample"]').readyState>=2);
    await ownerPage.getByRole('button',{name:'保存',exact:true}).click();
    await ownerPage.getByText('保存しました。').waitFor();

    const contexts=await Promise.all([open(owner),open(listener)]);
    await Promise.all(contexts.map(directory));
    for(const p of contexts){await selectStation(p,publicId);await action(p,'listen').click();}
    if(realPack)await contexts[0].evaluate(()=>{
      const audio=document.querySelector('.radio-player audio');
      const ctx=new AudioContext(), analyser=ctx.createAnalyser();
      analyser.fftSize=1024;
      ctx.createMediaElementSource(audio).connect(analyser).connect(ctx.destination);
      document.querySelector('.radio-player button.primary').addEventListener('click',()=>void ctx.resume(),{once:true});
      const buffer=new Float32Array(analyser.fftSize), samples=[],marks=[];
      const status=document.querySelector('#radio-status');
      new MutationObserver(()=>marks.push({title:status.textContent,at:performance.now()})).observe(status,{childList:true});
      function sample(){
        analyser.getFloatTimeDomainData(buffer);
        const loud=Math.sqrt(buffer.reduce((sum,x)=>sum+x*x,0)/buffer.length)>0.0025;
        samples.push({at:performance.now(),loud});
        if(samples.length<2000)requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
      window.fmMeasurement={samples,marks};
    });
    await Promise.all(contexts.map(p=>setVolume(p,42)));
    clockOffset=time+12070-Date.now();
    await contexts[0].getByRole('button',{name:'聴く',exact:true}).click();
    await contexts[0].getByText(/Named Public .* ステーションジングル/).waitFor();
    await contexts[1].getByRole('button',{name:'聴く',exact:true}).click();
    await contexts[1].getByText(/Named Public .* ステーションジングル/).waitFor();
    const snapshots=await Promise.all(contexts.map(p=>p.locator('dialog[open] .radio-player audio:not([data-radio])').evaluate(a=>({time:a.currentTime,playing:!a.paused,duration:a.duration}))));
    assert.ok(snapshots.every(a=>a.playing&&a.duration>1.7&&a.duration<2),'both browsers decode the standard jingle');
    assert.ok(Math.abs(snapshots[0].time-snapshots[1].time)<0.45,'both hear the same station position');
    await Promise.all(contexts.map(p=>verifyVolume(p,42)));
    const expectedMc=fmAssets['mc-enhanced'];
    await Promise.all(contexts.map(p=>p.getByText('Named Public · MC · '+expectedMc.credit,{exact:true}).waitFor()));
    assert.ok((await Promise.all(contexts.map(p=>p.locator('dialog[open] .radio-player audio:not([data-radio])').evaluate((a,expected)=>!a.paused&&Math.abs(a.duration-expected)<0.075,expectedMc.durationMs/1000)))).every(Boolean),'both browsers decode the expected MC clip');
    await Promise.all(contexts.map(p=>verifyVolume(p,42)));
    await Promise.all(contexts.map(p=>p.getByText('Named Public · First Song').waitFor()));
    await Promise.all(contexts.map(p=>verifyVolume(p,42)));
    if(realPack){
      await contexts[0].waitForTimeout(350);
      const measured=await contexts[0].evaluate(()=>{
        const {samples,marks}=window.fmMeasurement;
        const transitions=marks.filter(row=>row.title.includes(' · MC · ')||row.title==='Named Public · First Song');
        return transitions.map(({title,at})=>{
          const before=samples.findLast(x=>x.at<at&&x.loud);
          const after=samples.find(x=>x.at>=at&&x.loud);
          return {title,quietMs:before&&after?Math.round(after.at-before.at):null};
        });
      });
      assert.equal(measured.length,2);
      assert.ok(measured.every(item=>item.quietMs!==null&&item.quietMs<650),JSON.stringify(measured));
      console.log('FM decoded boundary measurements (includes creative fades and speech pause): '+JSON.stringify(measured));
    }
    console.log('FM audio verified: independent browsers join one jingle in progress, then decode '+(realPack?'the actual MC':'mock MC')+' and return to music.');
  }
  assert.deepEqual(errors,[]);
  console.log('Station UI verified: authenticated directory, creation/edit/delete, independent audio playback, share link and revocation.');
}finally{
  await browser?.close();
  await vite?.close();
  await app?.close();
  await rm(temp,{recursive:true,force:true});
}
