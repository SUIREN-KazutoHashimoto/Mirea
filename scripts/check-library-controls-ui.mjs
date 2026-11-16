// Temporary service, synthetic accounts/media, and loopback-only browser traffic.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright';
import {createServer,mergeConfig} from 'vite';
import sharp from 'sharp';
import {createApp} from '../server/app.js';
import {makePdf} from '../tests/fixtures.js';
import baseConfig from '../vite.config.js';
const dataDir=await mkdtemp(join(tmpdir(),'mirea-library-controls-')),output=resolve('.local/library-ui-checks');
let app,vite,browser,page;const errors=[];
try{
 await mkdir(output,{recursive:true});app=await createApp({dataDir,rateLimit:false});
 const req=async(method,path,user,payload)=>{const r=await app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},...(payload?{payload}:{})});assert(r.statusCode<400,r.body);return r.json();};
 const users={};for(const id of ['a','b'])users[id]=await req('POST','/auth/register',null,{name:'画面確認 '+id,email:'controls-'+id+'@example.invalid',password:'synthetic-controls-password'});
 const shelf=(await req('POST','/shelves',users.a,{name:'合成ライブラリ'})).id;
 await req('POST','/shelves/'+shelf+'/members',users.a,{email:users.b.user.email,role:'editor'});
 const groups=[];for(const title of ['読書シリーズ','音楽資料'])groups.push((await req('POST','/shelves/'+shelf+'/series',users.a,{title})).series);
 const child=(await req('POST','/shelves/'+shelf+'/series',users.a,{title:'小さなコレクション',parentId:groups[0].id})).series;
 const jpeg=await sharp({create:{width:240,height:320,channels:3,background:'#6964b3'}}).jpeg().toBuffer(),cover=await sharp(jpeg).webp().toBuffer();
 const db=new DatabaseSync(join(dataDir,'mirea.sqlite'));
 try{for(const [index,group] of [...groups,child].entries()){const ids=[];for(let n=0;n<5;n++){const id=randomUUID(),pdf=makePdf();ids.push(id);await Promise.all([writeFile(join(dataDir,'uploads',id),pdf),writeFile(join(dataDir,'thumbnails',id+'.webp'),cover),writeFile(join(dataDir,'thumbnails',id+'.jpg'),jpeg)]);db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count,thumbnail_ready) VALUES(?,?,?,'fixture.pdf','application/pdf',?,?,?,1,1)").run(id,shelf,'サンプル '+(n+1),pdf.length+n,users.a.user.id,Date.now()-n*1000-index*10000);}
 await req('PUT','/series/'+group.id,users.a,{revision:(await req('GET','/series/'+group.id,users.a)).series.revision,title:group.title,description:'',items:ids.map(assetId=>({assetId,label:''})),orderMode:'manual'});}}finally{db.close();}
 await app.listen({host:'127.0.0.1',port:0});const apiOrigin='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer(mergeConfig(baseConfig,{configFile:false,server:{watch:null,hmr:false,host:'127.0.0.1',port:0,proxy:{'/api':apiOrigin}}}));await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;
 browser=await chromium.launch({headless:true,chromiumSandbox:true,...process.env.MIREA_UI_BROWSER?{executablePath:process.env.MIREA_UI_BROWSER}:{}});
 const createDevice=async(viewport,colorScheme)=>{const context=await browser.newContext({viewport,colorScheme,serviceWorkers:'block'});await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));await context.addInitScript(users=>{const user=users[localStorage.getItem('qa-account')||'a'];const key='mirea.library-view.v1|'+location.origin+'|'+user.user.id+'|all||';if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({layout:'grid3',details:'full'}));sessionStorage.setItem('mirea.session:web',JSON.stringify({origin:'',remember:false,session:user}));},users);return context;};
 const desktop=await createDevice({width:1440,height:1000},'dark'),phone=await createDevice({width:390,height:844},'light');
 const boot=async(context)=>{page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin,{waitUntil:'domcontentloaded'});await page.locator('[data-open-series="'+groups[0].id+'"]').waitFor();await page.locator('.app-launch').waitFor({state:'detached'});return page;};
 const p=await boot(desktop);assert.equal(await p.locator('#items').getAttribute('data-layout'),'grid3','retain existing display preference');await p.locator('#sort').selectOption('name');
 const original=await p.locator('#items').boundingBox();assert.equal(await p.locator('.collection-layout').isVisible(),false);assert.equal(await p.locator('.bulk-ai-analyze').isVisible(),false);
 await p.locator('.library-display-toggle').click();await p.locator('.collection-layout').selectOption('grid5');await p.locator('.collection-details').selectOption('compact');assert.equal(await p.locator('#items').getAttribute('data-layout'),'grid5');const after=await p.locator('#items').boundingBox();for(const key of ['x','y','width'])assert.equal(after[key],original[key],'display controls must not move the collection');
 await p.keyboard.press('Escape');assert.equal(await p.locator('.library-display-toggle').getAttribute('aria-expanded'),'false');assert.equal(await p.locator('.library-display-toggle').evaluate(n=>n===document.activeElement),true);
 await p.locator('.collection-actions-toggle').click();assert(await p.locator('.bulk-ai-analyze').isVisible());assert(await p.locator('.bulk-ai-status').isVisible());assert.equal(await p.locator('dialog[open]').count(),0);await p.locator('.collection-heading').click();assert.equal(await p.locator('#library-actions-panel').isVisible(),false);
 await p.screenshot({path:join(output,'desktop-library.png')});
 const open=async(page,id)=>{await page.locator('[data-open-series="'+id+'"]').click();await page.waitForFunction(id=>document.querySelector('.series-context h2')?.textContent===id,groups.concat(child).find(g=>g.id===id).title);};
 await open(p,groups[0].id);assert.equal(await p.locator('#count-all').innerText(),'10');assert.equal(await p.locator('#sort').inputValue(),'series');await p.locator('#sort').selectOption('oldest');
 await open(p,child.id);assert.equal(await p.locator('#sort').inputValue(),'series');await p.locator('#sort').selectOption('size-desc');await p.locator('.clear-series').click();assert.equal(await p.locator('#sort').inputValue(),'oldest');
 await p.locator('.series-actions-toggle').click();assert(await p.locator('.edit-series').isVisible());await p.keyboard.press('Escape');await p.screenshot({path:join(output,'desktop-series.png')});
 await p.locator('.clear-series').click();assert.equal(await p.locator('#sort').inputValue(),'name');await open(p,groups[1].id);assert.equal(await p.locator('#sort').inputValue(),'series');await p.locator('#sort').selectOption('name-desc');await p.locator('.clear-series').click();await open(p,groups[0].id);assert.equal(await p.locator('#sort').inputValue(),'oldest');
 await p.reload({waitUntil:'domcontentloaded'});await p.locator('.series-context h2').waitFor();assert.equal(await p.locator('#sort').inputValue(),'oldest');
 await p.locator('[data-shelf="'+shelf+'"]').click();await open(p,groups[0].id);assert.equal(await p.locator('#sort').inputValue(),'oldest','same series preference through its bookshelf');
 // Account switch shares browser storage but must not share sort preferences.
 await p.evaluate(()=>localStorage.setItem('qa-account','b'));await p.goto(origin,{waitUntil:'domcontentloaded'});await p.locator('[data-open-series="'+groups[0].id+'"]').waitFor();await open(p,groups[0].id);assert.equal(await p.locator('#sort').inputValue(),'series');await p.locator('#sort').selectOption('progress');
 await p.evaluate(()=>localStorage.setItem('qa-account','a'));await p.goto(origin,{waitUntil:'domcontentloaded'});await p.locator('[data-open-series="'+groups[0].id+'"]').waitFor();await open(p,groups[0].id);assert.equal(await p.locator('#sort').inputValue(),'oldest');
 const m=await boot(phone);assert.equal(await m.locator('#sort').inputValue(),'recent');await open(m,groups[0].id);assert.equal(await m.locator('#sort').inputValue(),'series');await m.locator('#sort').selectOption('name-desc');
 for(const width of [390,320]){await m.setViewportSize({width,height:844});const searchBox=await m.locator('#search').boundingBox(),headerBox=await m.locator('.topbar').boundingBox();assert(searchBox.y>=headerBox.y+headerBox.height,'navigation must not put search under the sticky header');await m.screenshot({path:join(output,'phone-'+width+'-series.png')});assert(await m.locator('body').evaluate(n=>n.scrollWidth<=innerWidth+1));await m.locator('.collection-actions-toggle').click();await m.locator('.bulk-ai-analyze').waitFor();const boxes=await m.locator('#library-actions-panel button:visible').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};}));for(let a=0;a<boxes.length;a++){assert(boxes[a].left>=0&&boxes[a].right<=width);for(let b=a+1;b<boxes.length;b++)assert(!(boxes[a].left<boxes[b].right-1&&boxes[b].left<boxes[a].right-1&&boxes[a].top<boxes[b].bottom-1&&boxes[b].top<boxes[a].bottom-1));}await m.screenshot({path:join(output,'phone-'+width+'-actions.png')});await m.keyboard.press('Escape');}
 await m.reload({waitUntil:'domcontentloaded'});await m.locator('.series-context h2').waitFor();assert.equal(await m.locator('#sort').inputValue(),'name-desc');await p.reload({waitUntil:'domcontentloaded'});await p.locator('.series-context h2').waitFor();assert.equal(await p.locator('#sort').inputValue(),'oldest');
 assert.deepEqual(errors,[]);await desktop.close();await phone.close();console.log('Verified grouped controls, 320/390px layouts, keyboard/dismissal, nested series and account/device sort isolation.');
}catch(error){if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});throw error;}finally{await browser?.close();await vite?.close();await app?.close();assert(resolve(dataDir).startsWith(resolve(tmpdir())+sep+'mirea-library-controls-'));await rm(dataDir,{recursive:true,force:true});}
