// Own synthetic media, temporary DB and a fresh sandboxed headless browser.
// Never attach to an existing browser or a real user's server.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright';
import {build,createServer,mergeConfig} from 'vite';
import {createApp} from '../server/app.js';
import baseConfig from '../vite.config.js';
import {makeMp4} from '../tests/fixtures.js';
import {ffmpegPath} from '../server/media.js';
import sharp from 'sharp';

const dataDir=await mkdtemp(join(tmpdir(),'mirea-player-ui-')),output=resolve('.local/player-ui-checks');await mkdir(output,{recursive:true});
let app,vite,browser,page;const report=[],apiFailures=[];
try{
 await build(mergeConfig(baseConfig,{configFile:false}));
 app=await createApp({dataDir,rateLimit:false,allowRegistration:true});
 const owner=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'再生確認ユーザー',email:'player-qa@example.invalid',password:'synthetic-player-password'}})).json();
 const headers={authorization:'Bearer '+owner.token},shelf=(await app.inject({method:'POST',url:'/api/v1/shelves',headers,payload:{name:'再生確認'}})).json().id;
 const videoId=randomUUID(),audioId=randomUUID(),pdfId=randomUUID();
 const video=await makeMp4(join(dataDir,'fixture.mp4'),{duration:35,width:320,height:180,audio:true});
 await promisify(execFile)(ffmpegPath(),['-hide_banner','-loglevel','error','-y','-i',join(dataDir,'fixture.mp4'),'-vn','-c:a','copy',join(dataDir,'fixture.m4a')],{windowsHide:true});
 const audio=await readFile(join(dataDir,'fixture.m4a')),cover=await sharp({create:{width:300,height:300,channels:3,background:'#504a98'}}).webp().toBuffer();
 const {makePdf}=await import('../tests/fixtures.js'),db=new DatabaseSync(join(dataDir,'mirea.sqlite'));
 try{for(const [id,title,mime,bytes]of [[videoId,'合成動画','video/mp4',video],[audioId,'合成音声','audio/mp4',audio],[pdfId,'合成本','application/pdf',makePdf()]]){await writeFile(join(dataDir,'uploads',id),bytes);await writeFile(join(dataDir,'thumbnails',id+'.webp'),cover);db.prepare("INSERT INTO items VALUES(?,?,?,'fixture',?,?,?, ?,1,1)").run(id,shelf,title,mime,bytes.length,owner.user.id,Date.now());}}finally{db.close();}
 await app.listen({host:'127.0.0.1',port:0});const apiOrigin='http://127.0.0.1:'+app.server.address().port;
 const bootstrap="sessionStorage.setItem('mirea.session:web',"+JSON.stringify(JSON.stringify({origin:'',remember:false,session:owner}))+');';
 vite=await createServer(mergeConfig(baseConfig,{configFile:false,server:{host:'127.0.0.1',port:0,proxy:{'/api':apiOrigin}},plugins:[{name:'isolated-player-fixture',transformIndexHtml(){return [{tag:'script',attrs:{type:'module',src:'/qa-bootstrap.js'},injectTo:'head-prepend'}];},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/qa-bootstrap.js')return next();res.setHeader('Content-Type','text/javascript');res.end(bootstrap);});}}]}));
 await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;
 browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.MIREA_UI_BROWSER?{executablePath:process.env.MIREA_UI_BROWSER}:{})});
 for(const [name,viewport]of [['desktop',{width:1440,height:1000}],['phone',{width:390,height:844}],['small',{width:320,height:740}],['landscape',{width:844,height:390}]]){
  const context=await browser.newContext({viewport,colorScheme:'dark',serviceWorkers:'allow',acceptDownloads:false});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('response',async response=>{if(response.status()>=500&&response.url().includes('/api/')&&apiFailures.length<10)apiFailures.push({path:new URL(response.url()).pathname,status:response.status(),body:(await response.text().catch(()=>'' )).slice(0,3000)});});page.setDefaultTimeout(15000);
  await page.goto(origin,{waitUntil:'domcontentloaded',timeout:45000});await page.locator('.card-open[data-open="'+videoId+'"]').waitFor({timeout:30000});await page.locator('.app-launch').waitFor({state:'detached'});
  await page.evaluate(async()=>{const {recordDiagnostic,localDiagnostic}=await import('/src/error-diagnostics.js');recordDiagnostic(localDiagnostic());});
  if(name==='desktop')assert(await page.evaluate(async()=>{const {patchCollection}=await import('/src/collection-patch.js'),list=document.createElement('div');const markup=count=>`<article class="media-card"><button class="card-open" data-open-series="same-id"><div class="card-art"><img data-local-thumbnail="cover" data-thumbnail="/cover" alt="Title ${count}"><span class="series-count">${count}</span></div></button></article>`;patchCollection(list,markup(1));const card=list.firstElementChild,button=card.querySelector('button'),image=card.querySelector('img');patchCollection(list,markup(2));return list.firstElementChild===card&&card.querySelector('button')===button&&card.querySelector('img')===image&&card.querySelector('.series-count').textContent==='2'&&image.alt==='Title 2';}),'series updates retain the cover and refresh its count and accessible name');
  const shot=async label=>{await page.waitForTimeout(120);await page.screenshot({path:join(output,name+'-'+label+'.png')});const box=await page.locator('.viewer-screen').evaluate(n=>{const image=n.querySelector('.audio-art img'),cover=image&&!image.hidden?image.getBoundingClientRect():null,top=n.querySelector('.viewer-top').getBoundingClientRect(),controls=n.querySelector('.player-controls')?.getBoundingClientRect();return {width:n.clientWidth,scroll:n.scrollWidth,body:document.body.scrollWidth,viewport:innerWidth,...(cover?{coverTop:cover.top,coverBottom:cover.bottom,headerBottom:top.bottom,controlsTop:controls.top}:{})};});assert(box.scroll<=box.width+2&&box.body<=box.viewport+2,JSON.stringify({name,label,box}));if(box.coverTop!==undefined)assert(box.coverTop>=box.headerBottom-2&&box.coverBottom<=box.controlsTop+2,JSON.stringify({name,label,box}));report.push({name,label});};
  for(const [id,kind]of [[videoId,'video'],[audioId,'audio']]){
   await page.locator('.card-open[data-open="'+id+'"]').click();await page.locator('.mirea-player '+kind).waitFor({state:'attached'});
   await page.waitForFunction(kind=>document.querySelector('.mirea-player '+kind)?.readyState>=2,kind);
   await page.locator('.player-mode-controls .diagnostic-inline').waitFor();assert.equal(await page.locator('.diagnostic-floating').isVisible(),false,'diagnostic access must remain inline and never cover playback controls');
   await page.locator('.player-play').click();await page.waitForFunction(kind=>!document.querySelector('.mirea-player '+kind)?.paused,kind);
   await page.locator('.player-play').click();await page.locator('.player-speed select').selectOption('1.5');
   await page.evaluate(kind=>{document.querySelector('.mirea-player '+kind).currentTime=12;},kind);
   await page.waitForFunction(kind=>!document.querySelector('.mirea-player '+kind).seeking,kind);await shot(kind+'-paused');
   const unchanged=await page.locator('.mirea-player '+kind).evaluate(m=>({src:m.currentSrc,time:m.currentTime}));
   await page.locator('.player-equalizer').click();await page.locator('.equalizer-dialog[open]').waitFor();await page.locator('.eq-enabled').setChecked(false);await page.locator('.eq-enabled').check();await page.locator('.eq-preset').selectOption('bass');await page.waitForFunction(()=>document.querySelector('.eq-status')?.textContent==='イコライザーを適用中');
   assert.equal(await page.locator('[data-eq-band="0"]').inputValue(),'5');await page.locator('[data-eq-band="0"]').focus();await page.locator('[data-eq-band="0"]').press('ArrowUp');assert.equal(await page.locator('.eq-preset').inputValue(),'custom');await page.screenshot({path:join(output,name+'-'+kind+'-equalizer.png')});report.push({name,label:kind+'-equalizer'});
   const eqBox=await page.locator('.equalizer-dialog').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth,top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom,viewport:innerHeight}));assert(eqBox.scroll<=eqBox.width+2&&eqBox.top>=0&&eqBox.bottom<=eqBox.viewport+1,JSON.stringify(eqBox));await page.locator('.eq-close').click();
   const sameMedia=await page.locator('.mirea-player '+kind).evaluate(m=>({src:m.currentSrc,time:m.currentTime,paused:m.paused}));assert.equal(sameMedia.src,unchanged.src);assert.equal(sameMedia.paused,true);assert(Math.abs(sameMedia.time-unchanged.time)<.2,'equalizer settings must not seek');
   if(kind==='audio'){await page.locator('.player-play').click();await page.waitForFunction(()=>document.querySelector('.audio-player')?.classList.contains('audio-motion'));const first=await page.locator('.audio-player').evaluate(n=>getComputedStyle(n,'::before').transform);await shot('audio-flow-before');await page.waitForTimeout(1200);const next=await page.locator('.audio-player').evaluate(n=>getComputedStyle(n,'::before').transform);assert.notEqual(next,first,'audio light fields must visibly move');await shot('audio-flow-after');await page.locator('.player-play').click();}

   await page.locator('.player-reconnect').click();await page.waitForFunction(kind=>{const m=document.querySelector('.mirea-player '+kind);return m?.readyState>=2&&!m.seeking&&m.currentTime>=11&&m.paused&&m.playbackRate===1.5;},kind);
   await shot(kind+'-reconnected');await page.locator('.player-background').click();await page.locator('.playback-dock').waitFor();
   assert.equal(await page.locator('.viewer-screen').isVisible(),false);await page.evaluate(()=>document.querySelector('.playback-dock').querySelector('button[aria-label*="開く"],button[aria-label*="戻"]')?.click());
   if(!await page.locator('.viewer-screen').isVisible())await page.locator('.dock-art').click();
   await page.locator('.viewer-screen').waitFor();await shot(kind+'-restored');
   await page.evaluate(()=>document.querySelector('.viewer-screen').close());assert.equal(await page.locator('.mirea-player').count(),0);
  }

  if(name==='desktop'){
   const dsp=await page.evaluate(async()=>{
    const {createEqualizer}=await import('/src/equalizer.js'),rate=48000,count=rate*5,bytes=new ArrayBuffer(44+count*2),view=new DataView(bytes),str=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};str(0,'RIFF');view.setUint32(4,36+count*2,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,count*2,true);for(let i=0;i<count;i++)view.setInt16(44+i*2,Math.sin(i*2*Math.PI*60/rate)*6000,true);
    const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'})),media=document.createElement('audio');media.src=url;media.loop=true;document.body.append(media);const context=new AudioContext({sampleRate:rate});let tail,sources=0;const filter=context.createBiquadFilter.bind(context),source=context.createMediaElementSource.bind(context);context.createBiquadFilter=()=>tail=filter();context.createMediaElementSource=m=>{sources++;return source(m);};const eq=createEqualizer(media,{Context:function(){return context;},storage:{getItem(){return null;},setItem(){}}});
    try{await eq.set({enabled:true,gains:[0,0,0,0,0]});const analyser=context.createAnalyser();analyser.fftSize=2048;eq.output.connect(analyser);await media.play();const sleep=ms=>new Promise(r=>setTimeout(r,ms));const rms=async()=>{await sleep(200);let total=0;const data=new Float32Array(analyser.fftSize);for(let j=0;j<4;j++){await sleep(60);analyser.getFloatTimeDomainData(data);for(const v of data)total+=v*v;}return Math.sqrt(total/(data.length*4));};const original=media.currentSrc,start=media.currentTime,baseline=await rms();await eq.set({enabled:true,gains:[0,0,-12,0,0,0,0,0,0,0,0,0,0,0,0]});const cut=await rms();await eq.set({enabled:false,gains:[-12,0,0,0,0]});const restored=await rms();await eq.set({enabled:true,gains:Array(15).fill(12)});const boosted=await rms();const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);const peak=Math.max(...samples.map(Math.abs));return {baseline,cut,restored,boosted,peak,sources,srcUnchanged:media.currentSrc===original,advanced:media.currentTime-start};}finally{eq.dispose();media.pause();media.remove();URL.revokeObjectURL(url);}
   });assert(dsp.baseline>.02&&dsp.cut/dsp.baseline<.45&&dsp.cut/dsp.baseline>.15&&dsp.restored/dsp.baseline>.8&&dsp.restored/dsp.baseline<1.2&&dsp.boosted>.1&&dsp.peak<=1.001&&dsp.sources===1&&dsp.srcUnchanged&&dsp.advanced>.5,JSON.stringify(dsp));report.push({name,label:'equalizer-real-audio',...dsp});
  }
  await page.locator('.card-open[data-open="'+pdfId+'"]').click();await page.locator('.pdf-stage canvas').waitFor({state:'visible'});await shot('pdf');await page.evaluate(()=>document.querySelector('.viewer-screen').close());
  assert.deepEqual(errors,[],name+' browser errors');await context.close();page=null;
 }
 const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:'dark',serviceWorkers:'allow',acceptDownloads:false});
 await context.route('**/*',route=>new URL(route.request().url()).origin===apiOrigin?route.continue():route.abort('blockedbyclient'));
 await context.addInitScript(value=>sessionStorage.setItem('mirea.session:web',JSON.stringify({origin:'',remember:false,session:value})),owner);
 page=await context.newPage();page.setDefaultTimeout(20000);await page.goto(apiOrigin,{waitUntil:'domcontentloaded'});
 await page.locator('.card-open[data-open="'+audioId+'"]').waitFor();await page.locator('.app-launch').waitFor({state:'detached'});
 for(const id of [audioId,videoId]){await page.locator('.card-open[data-open="'+id+'"]').click({button:'right'});await page.locator('.action-download').click();await page.locator('.start-download').click();await page.waitForFunction(()=>document.querySelector('.download-status')?.textContent.startsWith('暗号化して保存しました'),{},{timeout:60000});await page.locator('dialog[open] .close-modal').click();}
 for(const [id,kind]of [[audioId,'audio'],[videoId,'video']]){
  await page.locator('.card-open[data-open="'+id+'"]').click();await page.waitForFunction(kind=>document.querySelector('.mirea-player '+kind)?.readyState>=2,kind);await page.locator('.player-play').click();await page.waitForFunction(kind=>!document.querySelector('.mirea-player '+kind)?.paused,kind);
  await page.locator('.player-background').click();
  await page.locator('.dock-art').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#app')?.inert);
  await page.evaluate(id=>{window.performanceFixture={card:document.querySelector('[data-open="'+id+'"]').closest('.media-card'),button:document.querySelector('[data-open="'+id+'"]'),image:document.querySelector('[data-open="'+id+'"] img'),media:document.querySelector('.mirea-player audio,.mirea-player video'),source:document.querySelector('.mirea-player audio,.mirea-player video').currentSrc};window.performanceFixture.button.focus({preventScroll:true});window.scrollTo(0,80);window.performanceFixture.scroll=scrollY;window.performanceFixture.media.addEventListener('waiting',()=>{window.performanceFixture.waiting=(window.performanceFixture.waiting??0)+1;});},id);
  const before=await page.locator('.mirea-player '+kind).evaluate(m=>m.currentTime);await context.setOffline(true);
  // Trigger the actual catalog fallback while the hidden player keeps running.
  await page.locator('#refresh-library').evaluate(button=>button.click());await page.waitForFunction(()=>document.querySelector('[data-open]')?.closest('.media-card'));await page.waitForTimeout(1500);
  assert(await page.locator('.mirea-player '+kind).evaluate(m=>!m.paused&&m.currentTime,kind)>before+.2,kind+' keeps playing across a live network loss');
  const same=()=>page.evaluate(id=>{const f=window.performanceFixture;return {card:f.card===document.querySelector('[data-open="'+id+'"]').closest('.media-card'),button:f.button===document.querySelector('[data-open="'+id+'"]'),image:f.image===document.querySelector('[data-open="'+id+'"] img'),source:f.source===f.media.currentSrc,focus:document.activeElement===f.button,scroll:Math.abs(scrollY-f.scroll)<=1,waiting:f.waiting??0,banner:Boolean(document.querySelector('#offline-library-notice:not([hidden])'))};},id);
  let identity=await same();assert.deepEqual(identity,{card:true,button:true,image:true,source:true,focus:true,scroll:true,waiting:0,banner:false},kind+' offline transition preserves UI and playback');
  await context.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(3000);identity=await same();assert.deepEqual(identity,{card:true,button:true,image:true,source:true,focus:true,scroll:true,waiting:0,banner:false},kind+' online return preserves UI and playback');
  await page.locator('.dock-art').click();
  await page.screenshot({path:join(output,'phone-'+kind+'-live-offline.png')});report.push({name:'phone',label:kind+'-live-offline'});await context.setOffline(false);await page.evaluate(()=>document.querySelector('.viewer-screen').close());
 }
 await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});await page.locator('.card-open[data-open="'+audioId+'"]:enabled').waitFor();await page.locator('.app-launch').waitFor({state:'detached'});
 for(const [id,kind]of [[audioId,'audio'],[videoId,'video']]){
  await context.setOffline(true);await page.locator('.card-open[data-open="'+id+'"]').click();await page.waitForFunction(kind=>document.querySelector('.mirea-player '+kind)?.readyState>=2,kind);
  await page.locator('.player-play').click();await page.waitForFunction(kind=>!document.querySelector('.mirea-player '+kind)?.paused,kind);await page.waitForTimeout(800);await page.locator('.player-play').click();await page.waitForFunction(()=>document.querySelector('.player-play')?.getAttribute('aria-label')==='再生');
  await page.screenshot({path:join(output,'phone-'+kind+'-offline.png')});report.push({name:'phone',label:kind+'-offline',encryptedPlayback:true,offlineReload:true});
  await context.setOffline(false);await page.locator('.player-reconnect').click();await page.waitForFunction(kind=>document.querySelector('.mirea-player '+kind)?.readyState>=2,kind);assert.equal(await page.locator('.mirea-player '+kind).evaluate(m=>m.paused),true);
  await page.screenshot({path:join(output,'phone-'+kind+'-online-return.png')});report.push({name:'phone',label:kind+'-online-return'});await page.evaluate(()=>document.querySelector('.viewer-screen').close());
 }
 await context.close();page=null;
 // A real HLS stream starts before the large ahead target is filled, survives
 // reachability changes, and renews authorization without resetting MSE.
 const longId=randomUUID(),input=join(dataDir,'buffer-input.mp4'),folder=join(dataDir,'videos',longId);
 await makeMp4(input,{duration:95,width:320,height:180,audio:true});
 // Browser fixture generation is independent of the runner's FFprobe version.
 // Full production conversion/probing is covered by API and container jobs.
 await mkdir(folder,{recursive:true});const encode=promisify(execFile),mp4=join(folder,'180p.mp4');
 await encode(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y','-i',input,'-map','0:v:0','-map','0:a:0','-c:v','libx264','-preset','veryfast','-profile:v','high','-level:v','4.1','-pix_fmt','yuv420p','-threads','1','-r','30','-g','120','-keyint_min','120','-sc_threshold','0','-force_key_frames','expr:gte(t,n_forced*4)','-c:a','aac','-t','95','-movflags','+faststart',mp4],{windowsHide:true,timeout:30000});
 await encode(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y','-i',mp4,'-c','copy','-hls_time','4','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_flags','independent_segments','-hls_fmp4_init_filename','180p-init.mp4','-hls_segment_filename',join(folder,'180p-%05d.m4s'),'-f','hls',join(folder,'180p.m3u8')],{cwd:folder,windowsHide:true,timeout:30000});
 const ladder={version:1,duration:95,codec:'H.264 + AAC',renditions:[{quality:'180p',width:320,height:180,bitrate:928000,size:(await readFile(mp4)).length,files:(await readdir(folder)).filter(name=>name!=='180p.mp4')}]};
 const canonical=await readFile(join(folder,ladder.renditions[0].quality+'.mp4'));await writeFile(join(dataDir,'uploads',longId),canonical);await writeFile(join(dataDir,'thumbnails',longId+'.webp'),cover);
 const fixtureDb=new DatabaseSync(join(dataDir,'mirea.sqlite'));try{fixtureDb.prepare("INSERT INTO items VALUES(?,?,?,'buffer.mp4','video/mp4',?,?,?,1,1)").run(longId,shelf,'先読み確認',canonical.length,owner.user.id,Date.now());fixtureDb.prepare('INSERT INTO video_assets VALUES(?,?,1)').run(longId,JSON.stringify(ladder));}finally{fixtureDb.close();}
 const streamContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});let firstTicket=true,renewals=0;
 await streamContext.addInitScript(value=>sessionStorage.setItem('mirea.session:web',JSON.stringify({origin:'',remember:false,session:value})),owner);
 await streamContext.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==apiOrigin)return route.abort('blockedbyclient');if(url.pathname.endsWith('/playback-ticket')&&url.pathname.includes(longId)){const response=await route.fetch();const json=await response.json();if(firstTicket){firstTicket=false;json.expiresAt=Date.now()+70000;}else renewals++;return route.fulfill({response,json});}if(url.pathname.includes('/hls/')&&url.pathname.endsWith('.m4s'))await new Promise(r=>setTimeout(r,180));return route.continue();});
 page=await streamContext.newPage();page.setDefaultTimeout(30000);await page.goto(apiOrigin,{waitUntil:'domcontentloaded'});await page.locator('[data-open="'+longId+'"]').waitFor();await page.locator('.app-launch').waitFor({state:'detached'});
 const start=Date.now();await page.locator('[data-open="'+longId+'"]').click();await page.waitForFunction(()=>document.querySelector('.mirea-player video')?.readyState>=2);await page.locator('.player-play').click();await page.waitForFunction(()=>{const v=document.querySelector('.mirea-player video');return v&&!v.paused&&v.currentTime>0;});
 const startMs=Date.now()-start,early=await page.evaluate(()=>{const v=document.querySelector('.mirea-player video');window.hlsFixture={v,source:v.currentSrc,resets:0};for(const name of ['emptied','loadstart','waiting'])v.addEventListener(name,()=>window.hlsFixture.resets++);return {ahead:v.buffered.length?v.buffered.end(v.buffered.length-1)-v.currentTime:0};});
 assert(early.ahead<60,'playback starts before filling its 60+ second ahead target');assert(startMs<10000,'start is independent of the ahead target');
 assert.equal(renewals,0,'authorization renewal must happen after playback starts');
 await page.waitForFunction(()=>{const v=document.querySelector('.mirea-player video');return v.buffered.length&&v.buffered.end(v.buffered.length-1)-v.currentTime>60;},null,{timeout:30000});for(let n=0;n<150&&renewals===0;n++)await page.waitForTimeout(100);assert(renewals>=1,'exercised automatic renewal while playing');
 const loaded=await page.evaluate(()=>{const v=window.hlsFixture.v;return {ahead:v.buffered.end(v.buffered.length-1)-v.currentTime,time:v.currentTime};});await streamContext.setOffline(true);await page.waitForTimeout(1500);await streamContext.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(1500);
 const preserved=await page.evaluate(()=>{const f=window.hlsFixture;return {source:f.v.currentSrc===f.source,resets:f.resets,advanced:f.v.currentTime,playing:!f.v.paused};});assert(preserved.source&&preserved.resets===0&&preserved.playing&&preserved.advanced>loaded.time+2,JSON.stringify(preserved));report.push({name:'phone',label:'hls-ahead-and-seamless-renewal',startMs,aheadSeconds:loaded.ahead,renewals,...preserved});await page.screenshot({path:join(output,'phone-hls-buffer.png')});await streamContext.close();page=null;
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({success:true,screenshots:report.length,output}));
}catch(error){if(apiFailures.length)console.error('Synthetic API failures:',JSON.stringify(apiFailures));if(page){console.error('Synthetic diagnostics:',JSON.stringify(await page.evaluate(async()=>{const {recentDiagnostics}=await import('/src/error-diagnostics.js');return recentDiagnostics();}).catch(()=>[])));await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}throw error;}
finally{await browser?.close();await vite?.close();await app?.close();assert(resolve(dataDir).startsWith(resolve(tmpdir())+sep+'mirea-player-ui-'));await rm(dataDir,{recursive:true,force:true});}
