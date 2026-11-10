// Synthetic, loopback-only visual and interaction verification.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createServer,mergeConfig} from 'vite';
import {createApp} from '../server/app.js';
import {DatabaseSync} from 'node:sqlite';
import {createAiStore} from '../server/ai-store.js';
import baseConfig from '../vite.config.js';
import {makePdf} from '../tests/fixtures.js';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFile} from 'node:fs/promises';import {ffmpegPath} from '../server/media.js';
import sharp from 'sharp';
const dataDir=await mkdtemp(join(tmpdir(),'mirea-ai-ui-')),output=resolve('.local/ai-ui-checks');await mkdir(output,{recursive:true});
let app,vite,browser;
try{
 app=await createApp({dataDir,rateLimit:false,allowRegistration:true});
 const owner=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'合成ユーザー',email:'ai-qa@example.invalid',password:'synthetic-ui-check-password'}})).json(),headers={authorization:'Bearer '+owner.token};
 const shelf=(await app.inject({method:'POST',url:'/api/v1/shelves',headers,payload:{name:'合成ライブラリ'}})).json().id;
 const audioId=randomUUID(),audioPath=join(dataDir,'tone.m4a');await promisify(execFile)(ffmpegPath(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:duration=12','-c:a','aac',audioPath],{windowsHide:true});const audio=await readFile(audioPath);
  const db=new DatabaseSync(join(dataDir,'mirea.sqlite')),id=randomUUID(),pdf=makePdf();
 try{await writeFile(join(dataDir,'uploads',id),pdf);await writeFile(join(dataDir,'thumbnails',id+'.webp'),await sharp({create:{width:300,height:450,channels:3,background:'#7066b2'}}).webp().toBuffer());
 db.prepare("INSERT INTO items VALUES(?,?,?,'fixture.pdf','application/pdf',?,?,?,1,1)").run(id,shelf,'青い鳥と静かな庭',pdf.length,owner.user.id,Date.now());
 db.prepare("INSERT INTO user_access VALUES(?,'admin',0) ON CONFLICT(user_id) DO UPDATE SET server_role='admin'").run(owner.user.id);
 const item=db.prepare('SELECT * FROM items WHERE id=?').get(id),store=createAiStore(db);
 store.publish(item,'ocr','fixture-generation','fixture-model',{blocks:[{id:'p1text',page:1,text:'青い鳥は静かな庭を訪れました。',box:[.1,.2,.7,.1]}]},{pageCount:1});
 store.setTags(item,owner.user.id,{scope:'shared',revision:0,tags:['物語','鳥']},true);
  await writeFile(join(dataDir,'uploads',audioId),audio);db.prepare("INSERT INTO items VALUES(?,?,?,'tone.m4a','audio/mp4',?,?,?,1,1)").run(audioId,shelf,'合成音源',audio.length,owner.user.id,Date.now());store.publish(db.prepare('SELECT * FROM items WHERE id=?').get(audioId),'structure','tone','synthetic-model',{segments:[{id:'first',startMs:0,endMs:6000,label:'イントロ'},{id:'second',startMs:6000,endMs:12000,label:'サビ'}]},{durationMs:12000});
 }finally{db.close();}
 await app.listen({host:'127.0.0.1',port:0});const apiOrigin='http://127.0.0.1:'+app.server.address().port;
 const bootstrap="sessionStorage.setItem('mirea.session:web',"+JSON.stringify(JSON.stringify({origin:'',remember:false,session:owner}))+');';
 vite=await createServer(mergeConfig(baseConfig,{configFile:false,server:{host:'127.0.0.1',port:0,watch:null,hmr:false,proxy:{'/api':apiOrigin}},plugins:[{name:'ai-fixture',transformIndexHtml(){return [{tag:'script',attrs:{type:'module',src:'/qa-bootstrap.js'},injectTo:'head-prepend'}];},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/qa-bootstrap.js')return next();res.setHeader('Content-Type','text/javascript');res.end(bootstrap);});}}]}));
 await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;browser=await chromium.launch({headless:true,chromiumSandbox:true,...process.env.MIREA_UI_BROWSER?{executablePath:process.env.MIREA_UI_BROWSER}:{}});
 for(const [name,viewport]of [['desktop',{width:1440,height:1000}],['phone',{width:390,height:844}]]){
  const context=await browser.newContext({viewport,colorScheme:'dark',serviceWorkers:'block'});await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(45000);await page.goto(origin,{waitUntil:'domcontentloaded',timeout:60000});
  await page.locator('.app-launch').waitFor({state:'detached'});await page.locator('.ai-open-search').click();await page.locator('.ai-search-form [name=query]').fill('静かな庭');await page.locator('.ai-search-form .primary').click();await page.locator('.ai-search-card').waitFor();assert.equal(await page.locator('.ai-search-card').count(),1);
  await page.screenshot({path:join(output,name+'-search.png'),animations:'disabled'});
  await page.locator('.ai-search-card .text-button').click();await page.locator('.ai-tag-form textarea').first().waitFor();await page.locator('.ai-tag-form textarea').last().fill('あとで読む');await page.locator('.ai-tag-form .button').last().click();await page.getByText('タグを保存しました。',{exact:true}).waitFor();
  await page.screenshot({path:join(output,name+'-tags.png'),animations:'disabled'});
  await page.getByRole('button',{name:'認識した内容',exact:true}).click();await page.locator('.ai-content-row').waitFor();await page.locator('.ai-content-row button').last().click();await page.locator('.ai-edit textarea').fill('青い鳥が庭に来ました。');await page.locator('.ai-edit .primary').click();await page.locator('.ai-content-row p').filter({hasText:'青い鳥が庭に来ました。'}).waitFor();
  await page.screenshot({path:join(output,name+'-content.png'),animations:'disabled'});
   const revision=(await app.inject({url:'/api/v1/items/'+id+'/ai/ocr',headers})).json().editRevision;await page.getByRole('button',{name:'訂正の履歴',exact:true}).click();await page.getByRole('button',{name:'現在の解析結果（訂正なし）',exact:true}).click();await page.getByRole('button',{name:'この訂正に戻す',exact:true}).click();await page.locator('.ai-content-row p').filter({hasText:'静かな庭'}).waitFor();await page.getByRole('button',{name:'訂正の履歴',exact:true}).click();await page.getByRole('button',{name:new RegExp(' · 訂正 '+revision+String.fromCharCode(36))}).click();await page.screenshot({path:join(output,name+'-history.png'),animations:'disabled'});await page.getByRole('button',{name:'この訂正に戻す',exact:true}).click();await page.locator('.ai-content-row p').filter({hasText:'青い鳥が庭に来ました。'}).waitFor();
await page.getByRole('button',{name:'解析情報を端末に保存',exact:true}).click();await page.getByText('解析情報を端末に保存しました。',{exact:true}).waitFor();
   await page.locator('.ai-content-row button').first().click();await page.locator('.book-stage canvas').waitFor({state:'visible'});await page.locator('.viewer-chrome-toggle').click();await page.locator('.ai-reader-toggle').click();await page.locator('.ai-reader-region').first().waitFor();await page.screenshot({path:join(output,name+'-reader.png'),animations:'disabled'});await page.locator('.ai-reader-region').first().click();await page.locator('.ai-recognized-text p').waitFor();assert((await page.locator('.ai-recognized-text p').innerText()).includes('青い鳥'));await page.locator('dialog:has(.ai-recognized-text) .close-modal').click();await page.keyboard.press('Escape');await page.locator('.ai-close-search').click();
  await page.locator('.card-open[data-open="'+audioId+'"]').click();await page.waitForFunction(()=>document.querySelector('.audio-player audio')?.readyState>=3);await page.locator('.ai-player-toggle').click();await page.locator('.ai-segment-row').last().waitFor();await page.locator('.ai-player-panel').getByRole('button',{name:'固定',exact:true}).click();await page.locator('.ai-segment-row').last().getByRole('button',{name:'サビを区間リピート',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.audio-player audio').currentTime>=6);await page.evaluate(()=>{const audio=document.querySelector('.audio-player audio');audio.currentTime=11.99;audio.dispatchEvent(new Event('timeupdate'));});await page.waitForFunction(()=>document.querySelector('.audio-player audio').currentTime<8);await page.locator('.ai-timeline-markers i').first().waitFor({state:'attached'});await page.locator('.ai-loop-range summary').click();await page.locator('.ai-loop-range [name=start]').fill('2');await page.locator('.ai-loop-range [name=end]').fill('4');await page.locator('.ai-loop-range .primary').click();await page.waitForFunction(()=>document.querySelector('.audio-player audio').currentTime>=2&&document.querySelector('.audio-player audio').currentTime<4);await page.evaluate(()=>{const audio=document.querySelector('.audio-player audio');audio.currentTime=3.99;audio.dispatchEvent(new Event('timeupdate'));});await page.waitForFunction(()=>document.querySelector('.audio-player audio').currentTime<3);await page.locator('.ai-player-panel').getByRole('button',{name:'次のサビへ',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.audio-player audio').currentTime>=6);await page.locator('.ai-loop-range summary').click();await page.screenshot({path:join(output,name+'-player.png'),animations:'disabled'});await page.evaluate(()=>document.querySelector('.viewer-screen').close());
   if(await page.locator('#open-drawer').isVisible())await page.locator('#open-drawer').click();await page.locator('#nav-admin').click();await page.locator('.admin-panel[aria-busy=false]').waitFor();
  if(await page.locator('.admin-section-select').isVisible())await page.locator('.admin-section-select').selectOption('ai');else await page.locator('[data-admin-tab=ai]').click();
  await page.locator('.ai-settings').waitFor();await page.screenshot({path:join(output,name+'-settings.png'),animations:'disabled'});
  await page.locator('[data-ai-tab=models]').click();await page.locator('.ai-model-card').first().waitFor();await page.screenshot({path:join(output,name+'-models.png'),animations:'disabled'});
  await page.locator('[data-ai-tab=jobs]').click();await page.locator('.ai-job-table').waitFor();await page.screenshot({path:join(output,name+'-jobs.png'),animations:'disabled'});
  assert.deepEqual(errors,[]);assert(await page.locator('dialog[open]').evaluate(n=>n.scrollWidth<=n.clientWidth+2),'dialog horizontal overflow');
  await context.close();console.log('Verified AI UI: '+name);
 }
}finally{await browser?.close();await vite?.close();await app?.close();await rm(dataDir,{recursive:true,force:true});}
