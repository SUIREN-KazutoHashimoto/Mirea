// Isolated browser verification: generated media, temporary DB, loopback only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright';
import {build,createServer,mergeConfig} from 'vite';
import sharp from 'sharp';
import {createApp} from '../server/app.js';
import {makePdf} from '../tests/fixtures.js';
import baseConfig from '../vite.config.js';
const dataDir=await mkdtemp(join(tmpdir(),'mirea-workspace-ui-')),output=resolve('.local/workspace-ui-checks');
let app,vite,browser,page;
try{
 await mkdir(output,{recursive:true});await build(mergeConfig(baseConfig,{configFile:false}));
 app=await createApp({dataDir,rateLimit:false,allowRegistration:true});
 const user=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Workspace QA',email:'workspace@example.invalid',password:'workspace-isolated-password'}})).json(),headers={authorization:'Bearer '+user.token};
 const shelf=(await app.inject({method:'POST',url:'/api/v1/shelves',headers,payload:{name:'画面確認'}})).json().id;
 const jpeg=await sharp({create:{width:200,height:300,channels:3,background:'#526baa'}}).jpeg().toBuffer(),cover=await sharp(jpeg).webp().toBuffer(),ids=[];
 const db=new DatabaseSync(join(dataDir,'mirea.sqlite'));try{for(let n=0;n<24;n++){const id=randomUUID(),bytes=makePdf();ids.push(id);await writeFile(join(dataDir,'uploads',id),bytes);await writeFile(join(dataDir,'thumbnails',id+'.webp'),cover);await writeFile(join(dataDir,'thumbnails',id+'.jpg'),jpeg);db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count,thumbnail_ready) VALUES(?,?,?,'fixture.pdf','application/pdf',?,?,?,1,1)").run(id,shelf,'確認の本 '+String(n+1).padStart(2,'0'),bytes.length,user.user.id,Date.now()-n);}}finally{db.close();}
 await app.listen({host:'127.0.0.1',port:0});const apiOrigin='http://127.0.0.1:'+app.server.address().port;
 const bootstrap="sessionStorage.setItem('mirea.session:web',"+JSON.stringify(JSON.stringify({origin:'',remember:false,session:user}))+');';
 vite=await createServer(mergeConfig(baseConfig,{configFile:false,server:{host:'127.0.0.1',port:0,proxy:{'/api':apiOrigin}},plugins:[{name:'workspace-fixture',transformIndexHtml(){return [{tag:'script',attrs:{type:'module',src:'/qa-workspace.js'},injectTo:'head-prepend'}];},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/qa-workspace.js')return next();res.setHeader('Content-Type','text/javascript');res.end(bootstrap);});}}]}));await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;
 browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.MIREA_UI_BROWSER?{executablePath:process.env.MIREA_UI_BROWSER}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'dark'});await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
 page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];let uploads=0;page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/uploads(?:\?|$)/.test(new URL(r.url()).pathname))uploads++;});
 await page.goto(origin,{waitUntil:'domcontentloaded'});await page.locator('.card-open[data-open="'+ids[0]+'"]').waitFor();await page.locator('.app-launch').waitFor({state:'detached'});
 await page.waitForFunction(()=>document.querySelector('#items img')?.naturalWidth>0);const originalUrl=page.url();await page.locator('.sidebar>a.brand').click();await page.locator('.mirea-about[open]').waitFor();assert.equal(page.url(),originalUrl);assert.equal(await page.locator('.mirea-about a[href="https://github.com/SUIREN-KazutoHashimoto/Mirea"]').count(),1);await page.screenshot({path:join(output,'desktop-about.png')});await page.keyboard.press('Escape');
 await page.locator('.collection-layout').selectOption('grid5');assert.equal(await page.locator('#items').getAttribute('data-layout'),'grid5');
 const columns=await page.locator('#items').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length);assert.equal(columns,5);assert.equal(await page.locator('.card-art>.media-type').first().isVisible(),false);await page.screenshot({path:join(output,'desktop-five-columns.png')});
 await page.locator('.card-open[data-open="'+ids[0]+'"]').click({button:'right'});await page.locator('.asset-context-menu').waitFor();assert.deepEqual(await page.locator('.asset-context-menu [role="menuitem"]').allTextContents(),['名前を変更','プレイリストに追加','暗号化ダウンロード','削除','プロパティ']);assert.equal(await page.locator('dialog[open]').count(),0);await page.screenshot({path:join(output,'desktop-context-menu.png')});await page.keyboard.press('Escape');assert.equal(await page.locator('.asset-context-menu').count(),0);
 await page.evaluate(()=>window.scrollTo(0,900));assert(Math.abs(await page.locator('.topbar').evaluate(n=>n.getBoundingClientRect().top))<2);await page.screenshot({path:join(output,'desktop-sticky-header.png')});await page.evaluate(()=>window.scrollTo(0,0));
 await page.evaluate(()=>{const data=new DataTransfer();data.items.add(new File(['synthetic'],'dropped.pdf',{type:'application/pdf'}));document.querySelector('.main-content').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));});await page.locator('.upload-selection:not([hidden])').waitFor();assert.match(await page.locator('.upload-selection').innerText(),/dropped/);await page.waitForTimeout(300);assert.equal(uploads,0,'dropping must select files, never send them');await page.screenshot({path:join(output,'desktop-drop-confirmation.png')});await page.keyboard.press('Escape');
 await page.evaluate(async()=>{const {recordDiagnostic,localDiagnostic}=await import('/src/error-diagnostics.js');recordDiagnostic(localDiagnostic());});assert.equal(await page.locator('.diagnostic-floating,.diagnostic-inline').count(),0,'old errors must not clutter an otherwise healthy screen');
 await page.locator('#add-series').click();await page.locator('.series-create input[name=title]').fill('検索の確認');await page.locator('.series-create [type=submit]').click();await page.locator('.series-candidate-search').waitFor();
 await page.locator('.series-candidate-search').fill('01');assert.equal(await page.locator('.series-candidate option').count(),1);await page.locator('.series-candidate').selectOption(ids[0]);await page.locator('.series-candidate-search').fill('02');assert.equal(await page.locator('.series-candidate option').count(),1);await page.locator('.series-candidate').selectOption(ids[1]);await page.locator('.series-candidate-search').fill('');assert.equal(await page.locator('.series-candidate option:checked').count(),2);await page.locator('.series-candidate-search').press('Enter');await page.waitForTimeout(150);assert.equal(await page.locator('.series-edit').count(),1,'Enter in search must not save/close the series');await page.locator('#series-add').click();assert.equal(await page.locator('.series-order>li').count(),2);await page.screenshot({path:join(output,'desktop-series-search.png')});await page.keyboard.press('Escape');
 // Exercise the browser's real exit confirmation with a local queued record.
 // No file or credentials are sent to create this condition.
 await page.locator('#nav-all').click();await page.evaluate(async()=>{const {recordUploadTransfer}=await import('/src/transfer-manager.js');window.leaveGuardFixture=recordUploadTransfer({clientTransferId:'isolated-beforeunload',title:'退出確認',notifications:false});window.leaveGuardMarker=true;});
 let exitPrompts=0;const dismiss=async dialog=>{assert.equal(dialog.type(),'beforeunload');exitPrompts++;await dialog.dismiss();};page.on('dialog',dismiss);
 // A dismissed navigation can reject as aborted or time out while awaiting a
 // document that must never commit. The prompt and retained marker prove it.
 await page.reload({waitUntil:'commit',timeout:2000}).catch(error=>assert.match(error.message,/ERR_ABORTED|interrupted|Timeout/));assert.equal(exitPrompts,1);assert.equal(await page.evaluate(()=>window.leaveGuardMarker),true);page.off('dialog',dismiss);await page.evaluate(()=>window.leaveGuardFixture.update({state:'processing',percent:100}));await page.reload({waitUntil:'domcontentloaded'});await page.locator('.card-open[data-open="'+ids[0]+'"]').waitFor();assert.equal(exitPrompts,1,'server-side processing must not block closing the page');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({success:true,screenshots:6,about:true,grid5:true,contextMenu:true,stickyHeader:true,dropDoesNotUpload:true,noStaleErrorLauncher:true,seriesSearchKeepsSelection:true,browserExitConfirmation:true,isolatedData:true}));
}catch(error){await page?.screenshot({path:join(output,'failure.png')}).catch(()=>{});throw error;}
finally{await browser?.close();await vite?.close();await app?.close();if(!resolve(dataDir).startsWith(resolve(tmpdir())+sep+'mirea-workspace-ui-'))throw Error('Unsafe fixture cleanup');await rm(dataDir,{recursive:true,force:true});}
