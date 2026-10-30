// Fresh sandboxed browsers + synthetic loopback server only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright';
import {createServer,mergeConfig} from 'vite';
import baseConfig from '../vite.config.js';
import {createApp} from '../server/app.js';
import {makePdf} from '../tests/fixtures.js';
const dataDir=await mkdtemp(join(tmpdir(),'mirea-manual-ui-')),output=resolve(process.env.MIREA_UI_ARTIFACT_DIR??'.local/manual-ui-checks'),report=[];
await mkdir(output,{recursive:true});let app,vite,browser,page;
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:()=>resolve()};};
async function until(check){for(let n=0;n<600;n++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('Synthetic manual UI deadline');}
try{
 app=await createApp({dataDir,rateLimit:false});
 const password='synthetic-manual-ui-password',owner=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Manual UI',email:'manual-ui@example.invalid',password}})).json(),headers={authorization:'Bearer '+owner.token};
 const shelf=(await app.inject({method:'POST',url:'/api/v1/shelves',headers,payload:{name:'追加先の本棚・表示確認'}})).json().id;
 const parent=(await app.inject({method:'POST',url:'/api/v1/shelves/'+shelf+'/series',headers,payload:{title:'親シリーズ'}})).json().series.id;
 const child=(await app.inject({method:'POST',url:'/api/v1/shelves/'+shelf+'/series',headers,payload:{title:'子シリーズ・長い名前の追加先の表示確認',parentId:parent}})).json().series.id;
 const db=new DatabaseSync(join(dataDir,'mirea.sqlite'));
 try{db.prepare("INSERT INTO user_access VALUES(?,'admin',0)").run(owner.user.id);}finally{db.close();}
 const settings=await app.inject({method:'PATCH',url:'/api/v1/admin/processing-settings',headers,payload:{maxConcurrentUploads:1,maxConcurrentJobs:1,maxUploadAssets:1000,currentPassword:password}});assert.equal(settings.statusCode,200,settings.body);
 await app.listen({host:'127.0.0.1',port:0});const apiOrigin='http://127.0.0.1:'+app.server.address().port;
 const bootstrap="sessionStorage.setItem('mirea.session:web',"+JSON.stringify(JSON.stringify({origin:'',remember:false,session:owner}))+');';
 vite=await createServer(mergeConfig(baseConfig,{configFile:false,server:{host:'127.0.0.1',port:0,proxy:{'/api':apiOrigin}},plugins:[{name:'manual-ui-fixture',transformIndexHtml(){return [{tag:'script',attrs:{type:'module',src:'/qa-bootstrap.js'},injectTo:'head-prepend'}];},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/qa-bootstrap.js')return next();res.setHeader('Content-Type','text/javascript');res.end(bootstrap);});}}]}));await vite.listen();
 const origin='http://127.0.0.1:'+vite.httpServer.address().port;
 browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.MIREA_UI_BROWSER?{executablePath:process.env.MIREA_UI_BROWSER}:{})});
 for(const [name,viewport]of [['desktop',{width:1440,height:1000}],['phone',{width:390,height:844}]]){
  const context=await browser.newContext({viewport,serviceWorkers:'block'}),normalGate=deferred(),manualGate=deferred();let firstId,manualId;
  try{
   await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
   await context.route('**/api/v1/uploads/*/files/*/parts/*',async route=>{
    const id=new URL(route.request().url()).pathname.split('/')[4];
    if(!firstId)firstId=id;
    if(id===firstId)await normalGate.promise;
    else if(!manualId||id===manualId){manualId=id;await manualGate.promise;}
    await route.continue().catch(()=>{});
   });
   page=await context.newPage();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(origin,{waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#nav-settings,.retry-connection'));
   if(await page.locator('.retry-connection').count())await page.locator('.retry-connection').click();
   const nav=async selector=>{const menu=page.locator('#open-drawer');if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')!=='true')await menu.click();await page.locator(selector).click();};
   await page.locator('#nav-settings').waitFor({state:'attached'});await nav('[data-shelf="'+shelf+'"]');await nav('#open-upload');
   await page.locator('select[name=seriesId] option[value="'+child+'"]').waitFor({state:'attached'});await page.locator('select[name=seriesId]').selectOption(child);
   const titles=['First','Waiting','Selected'].map(s=>name+' '+s),pdf=makePdf();
   await page.locator('input[name=file]').setInputFiles(titles.map(title=>({name:title+'.pdf',mimeType:'application/pdf',buffer:pdf})));
   await page.locator('.manager-upload [type=submit]').click();await until(()=>!!firstId);
   await page.locator('.manager-upload .close-modal').click();await nav('#transfer-center');
   const queued=page.locator('.transfer-row').filter({hasText:titles[2]});
   await queued.locator('.transfer-start:visible').waitFor();await queued.locator('.transfer-start').click();await until(()=>!!manualId);
   await page.locator('.transfer-refresh').click();await page.waitForFunction(()=>[...document.querySelectorAll('.transfer-row')].filter(n=>n.dataset.state==='running').length===2);
   const waiting=page.locator('.transfer-row').filter({hasText:titles[1]});assert(await waiting.locator('.transfer-start').isDisabled());
   assert((await queued.locator('.transfer-destination-label').textContent()).includes('親シリーズ'));
   const listing=(await app.inject({url:'/api/v1/transfers/uploads',headers})).json();
   assert.equal(listing.queue.filter(r=>r.state==='uploading'&&titles.includes(r.title)).length,2);
   assert.equal(listing.queue.find(r=>r.title===titles[1]).state,'queued');
   assert.equal(listing.manualSlot.state,'uploading');
   await page.screenshot({path:join(output,name+'-manual-running.png')});
   const overflow=await page.locator('.transfer-center').evaluate(n=>n.scrollWidth>n.clientWidth+2);assert.equal(overflow,false);
   manualGate.resolve();
   await until(async()=>{const r=(await app.inject({url:'/api/v1/transfers/uploads',headers})).json();return !r.manualSlot&&[...r.queue,...r.uploads].some(x=>x.title===titles[2]&&['processing','complete'].includes(x.state));});
   await page.locator('.transfer-refresh').click();await waiting.locator('.transfer-destination').click();
   await page.locator('.transfer-center').waitFor({state:'detached'});assert.equal(await page.locator('.series-folder-name h2').textContent(),'子シリーズ・長い名前の追加先の表示確認');
   await page.screenshot({path:join(output,name+'-destination.png')});
   normalGate.resolve();
   await until(async()=>{const r=(await app.inject({url:'/api/v1/transfers/uploads',headers})).json();return titles.every(title=>r.uploads.some(x=>x.title===title&&x.state==='complete'));});
   const verify=new DatabaseSync(join(dataDir,'mirea.sqlite'));
   try{for(const title of titles){const row=verify.prepare('SELECT si.series_id FROM items i JOIN series_items si ON si.asset_id=i.id WHERE i.title=? AND i.shelf_id=?').get(title,shelf);assert.equal(row.series_id,child);}}finally{verify.close();}
   assert.deepEqual(errors,[]);report.push({name,normalLimit:1,normalAndManualUploading:2,selectedLaterAsset:true,dialogClosed:true,destinationJump:true,allAssetsInTarget:true,errors});
  }catch(error){if(page)await page.screenshot({path:join(output,name+'-failure.png')}).catch(()=>{});throw error;}finally{normalGate.resolve();manualGate.resolve();await context.close();page=null;}
 }
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({success:true,checks:report,output}));
}catch(error){if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});throw error;}
finally{await browser?.close();await vite?.close();await app?.close();assert(resolve(dataDir).startsWith(resolve(tmpdir())+sep+'mirea-manual-ui-'));await rm(dataDir,{recursive:true,force:true});}
