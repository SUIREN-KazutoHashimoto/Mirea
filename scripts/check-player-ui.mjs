// Own synthetic media, temporary DB and a fresh sandboxed headless browser.
// Never attach to an existing browser or a real user's server.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
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
import {createVideoTranscoder} from '../server/video-transcode.js';
import sharp from 'sharp';

const dataDir=await mkdtemp(join(tmpdir(),'mirea-player-ui-')),output=resolve('.local/player-ui-checks');await mkdir(output,{recursive:true});
let app,vite,browser,page;const report=[];
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
  page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
  await page.goto(origin,{waitUntil:'domcontentloaded',timeout:45000});await page.locator('.card-open[data-open="'+videoId+'"]').waitFor({timeout:30000});await page.locator('.app-launch').waitFor({state:'detached'});
  if(name==='desktop')assert(await page.evaluate(async()=>{const {patchCollection}=await import('/src/collection-patch.js'),list=document.createElement('div');const markup=count=>`<article class="media-card"><button class="card-open" data-open-series="same-id"><div class="card-art"><img data-local-thumbnail="cover" data-thumbnail="/cover" alt="Title ${count}"><span class="series-count">${count}</span></div></button></article>`;patchCollection(list,markup(1));const card=list.firstElementChild,button=card.querySelector('button'),image=card.querySelector('img');patchCollection(list,markup(2));return list.firstElementChild===card&&card.querySelector('button')===button&&card.querySelector('img')===image&&card.querySelector('.series-count').textContent==='2'&&image.alt==='Title 2';}),'series updates retain the cover and refresh its count and accessible name');
  const shot=async label=>{await page.waitForTimeout(120);await page.screenshot({path:join(output,name+'-'+label+'.png')});const box=await page.locator('.viewer-screen').evaluate(n=>{const image=n.querySelector('.audio-art img'),cover=image&&!image.hidden?image.getBoundingClientRect():null,top=n.querySelector('.viewer-top').getBoundingClientRect(),controls=n.querySelector('.player-controls')?.getBoundingClientRect();return {width:n.clientWidth,scroll:n.scrollWidth,body:document.body.scrollWidth,viewport:innerWidth,...(cover?{coverTop:cover.top,coverBottom:cover.bottom,headerBottom:top.bottom,controlsTop:controls.top}:{})};});assert(box.scroll<=box.width+2&&box.body<=box.viewport+2,JSON.stringify({name,label,box}));if(box.coverTop!==undefined)assert(box.coverTop>=box.headerBottom-2&&box.coverBottom<=box.controlsTop+2,JSON.stringify({name,label,box}));report.push({name,label});};
  for(const [id,kind]of [[videoId,'video'],[audioId,'audio']]){
   await page.locator('.card-open[data-open="'+id+'"]').click();await page.locator('.mirea-player '+kind).waitFor({state:'attached'});
   await page.waitForFunction(kind=>document.querySelector('.mirea-player '+kind)?.readyState>=2,kind);
   await page.locator('.player-play').click();await page.waitForFunction(kind=>!document.querySelector('.mirea-player '+kind)?.paused,kind);
   await page.locator('.player-play').click();await page.locator('.player-speed select').selectOption('1.5');
   await page.evaluate(kind=>{document.querySelector('.mirea-player '+kind).currentTime=12;},kind);
   await page.waitForFunction(kind=>!document.querySelector('.mirea-player '+kind).seeking,kind);await shot(kind+'-paused');
   await page.locator('.player-reconnect').click();await page.waitForFunction(kind=>{const m=document.querySelector('.mirea-player '+kind);return m?.readyState>=2&&!m.seeking&&m.currentTime>=11&&m.paused&&m.playbackRate===1.5;},kind);
   await shot(kind+'-reconnected');await page.locator('.player-background').click();await page.locator('.playback-dock').waitFor();
   assert.equal(await page.locator('.viewer-screen').isVisible(),false);await page.evaluate(()=>document.querySelector('.playback-dock').querySelector('button[aria-label*="開く"],button[aria-label*="戻"]')?.click());
   if(!await page.locator('.viewer-screen').isVisible())await page.locator('.dock-art').click();
   await page.locator('.viewer-screen').waitFor();await shot(kind+'-restored');
   await page.evaluate(()=>document.querySelector('.viewer-screen').close());assert.equal(await page.locator('.mirea-player').count(),0);
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
 const longId=randomUUID(),input=join(dataDir,'buffer-input.mp4'),folder=join(dataDir,'videos',longId),converter=createVideoTranscoder();
 await makeMp4(input,{duration:95,width:320,height:180,audio:true});
 let ladder;try{ladder=await converter.convert(input,folder,{authorize(){},report(){}});}finally{converter.close();}
 const canonical=await readFile(join(folder,ladder.renditions[0].quality+'.mp4'));await writeFile(join(dataDir,'uploads',longId),canonical);await writeFile(join(dataDir,'thumbnails',longId+'.webp'),cover);
 const fixtureDb=new DatabaseSync(join(dataDir,'mirea.sqlite'));try{fixtureDb.prepare("INSERT INTO items VALUES(?,?,?,'buffer.mp4','video/mp4',?,?,?,1,1)").run(longId,shelf,'先読み確認',canonical.length,owner.user.id,Date.now());fixtureDb.prepare('INSERT INTO video_assets VALUES(?,?,1)').run(longId,JSON.stringify(ladder));}finally{fixtureDb.close();}
 const streamContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});let firstTicket=true,renewals=0;
 await streamContext.addInitScript(value=>sessionStorage.setItem('mirea.session:web',JSON.stringify({origin:'',remember:false,session:value})),owner);
 await streamContext.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==apiOrigin)return route.abort('blockedbyclient');if(url.pathname.endsWith('/playback-ticket')&&url.pathname.includes(longId)){const response=await route.fetch();const json=await response.json();if(firstTicket){firstTicket=false;json.expiresAt=Date.now()+61000;}else renewals++;return route.fulfill({response,json});}if(url.pathname.includes('/hls/')&&url.pathname.endsWith('.m4s'))await new Promise(r=>setTimeout(r,180));return route.continue();});
 page=await streamContext.newPage();page.setDefaultTimeout(30000);await page.goto(apiOrigin,{waitUntil:'domcontentloaded'});await page.locator('[data-open="'+longId+'"]').waitFor();await page.locator('.app-launch').waitFor({state:'detached'});
 const start=Date.now();await page.locator('[data-open="'+longId+'"]').click();await page.waitForFunction(()=>document.querySelector('.mirea-player video')?.readyState>=2);await page.locator('.player-play').click();await page.waitForFunction(()=>{const v=document.querySelector('.mirea-player video');return v&&!v.paused&&v.currentTime>0;});
 const startMs=Date.now()-start,early=await page.evaluate(()=>{const v=document.querySelector('.mirea-player video');window.hlsFixture={v,source:v.currentSrc,resets:0};for(const name of ['emptied','loadstart','waiting'])v.addEventListener(name,()=>window.hlsFixture.resets++);return {ahead:v.buffered.length?v.buffered.end(v.buffered.length-1)-v.currentTime:0};});
 assert(early.ahead<60,'playback starts before filling its 60+ second ahead target');assert(startMs<10000,'start is independent of the ahead target');
 await page.waitForFunction(()=>{const v=document.querySelector('.mirea-player video');return v.buffered.length&&v.buffered.end(v.buffered.length-1)-v.currentTime>60;},null,{timeout:30000});assert(renewals>=1,'exercised automatic renewal');
 const loaded=await page.evaluate(()=>{const v=window.hlsFixture.v;return {ahead:v.buffered.end(v.buffered.length-1)-v.currentTime,time:v.currentTime};});await streamContext.setOffline(true);await page.waitForTimeout(1500);await streamContext.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(1500);
 const preserved=await page.evaluate(()=>{const f=window.hlsFixture;return {source:f.v.currentSrc===f.source,resets:f.resets,advanced:f.v.currentTime,playing:!f.v.paused};});assert(preserved.source&&preserved.resets===0&&preserved.playing&&preserved.advanced>loaded.time+2,JSON.stringify(preserved));report.push({name:'phone',label:'hls-ahead-and-seamless-renewal',startMs,aheadSeconds:loaded.ahead,renewals,...preserved});await page.screenshot({path:join(output,'phone-hls-buffer.png')});await streamContext.close();page=null;
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({success:true,screenshots:report.length,output}));
}catch(error){if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});throw error;}
finally{await browser?.close();await vite?.close();await app?.close();assert(resolve(dataDir).startsWith(resolve(tmpdir())+sep+'mirea-player-ui-'));await rm(dataDir,{recursive:true,force:true});}
