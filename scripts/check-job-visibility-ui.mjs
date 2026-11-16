// Isolated loopback service with synthetic accounts and 1393 fixture assets.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright';
import {createServer,mergeConfig} from 'vite';
import {createApp} from '../server/app.js';
import baseConfig from '../vite.config.js';
const folder=await mkdtemp(join(tmpdir(),'mirea-job-ui-')),output=resolve('.local/ai-ui-checks');await mkdir(output,{recursive:true});
let app,vite,browser,db,pageUnderTest;
try{
 const admins=[];
 console.log('Starting synthetic job service');app=await createApp({dataDir:folder,rateLimit:false,serverAdminUserIds:admins,aiEnvironment:{},aiRuntime:{supported:async()=>({cpu:true}),inspect:()=>[],close:async()=>{}},aiResolveInput:async()=>({stamp:'fixture',pageCount:1}),aiAnalyzeUnit:async()=>({blocks:[]})});
 const req=(method,path,user,payload)=>app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},...(payload?{payload}:{})});
 const register=async name=>(await req('POST','/auth/register',null,{name,email:name+'@example.invalid',password:'synthetic-job-ui-password'})).json();
 console.log('Synthetic job service ready');const owner=await register('owner'),admin=await register('operator');admins.push(admin.user.id);
 const shelf=(await req('POST','/shelves',owner,{name:'合成ライブラリ'})).json().id,adminShelf=(await req('POST','/shelves',admin,{name:'管理者の合成本棚'})).json().id;
 console.log('Synthetic accounts ready');db=new DatabaseSync(join(folder,'mirea.sqlite'));db.exec('BEGIN');const ids=[];
 for(let n=0;n<1393;n++){const id=randomUUID();ids.push(id);db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,'fixture.pdf','application/pdf',10,?,?)").run(id,shelf,'合成作品 '+String(n).padStart(4,'0'),owner.user.id,n);}
 const adminAsset=randomUUID();db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,'所有アセットの名前','fixture.pdf','application/pdf',10,?,1)").run(adminAsset,adminShelf,admin.user.id);
 for(const [id,user]of [[ids[0],admin],[adminAsset,admin]])db.prepare("INSERT INTO ai_jobs(id,asset_id,requester_id,feature,model_id,input_stamp,profile_hash,state,created_at,updated_at) VALUES(?,?,?,'ocr','fixture','fixture','fixture','paused',1,1)").run(randomUUID(),id,user.user.id);
 const model='a'.repeat(64),manifest={id:model,key:'fixture',name:'合成モデル',repo:'example/fixture',revision:'b'.repeat(40),capabilities:['ocr'],engine:'llama',license:'mit',files:[]};
 db.prepare("INSERT INTO ai_models VALUES(?,?,'ready','{}',?,1,'accepted',NULL,1)").run(model,JSON.stringify(manifest),admin.user.id);db.exec('COMMIT');
 console.log('1393 synthetic assets prepared');const configured=await req('PATCH','/admin/ai/settings',admin,{currentPassword:'synthetic-job-ui-password',enabled:true,models:{ocr:model},quietHours:[(new Date().getHours()+1)%24,(new Date().getHours()+2)%24]});assert.equal(configured.statusCode,200,configured.body);
 await app.listen({host:'127.0.0.1',port:0});const apiOrigin='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer(mergeConfig(baseConfig,{configFile:false,server:{host:'127.0.0.1',port:0,watch:null,hmr:false,proxy:{'/api':apiOrigin}}}));await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;
 browser=await chromium.launch({headless:true,chromiumSandbox:true,...process.env.MIREA_UI_BROWSER?{executablePath:process.env.MIREA_UI_BROWSER}:{}});
 for(const [name,user,viewport]of [['owner-phone',owner,{width:390,height:844}],['admin-desktop',admin,{width:1440,height:1000}]]){
  const context=await browser.newContext({viewport,colorScheme:'dark',serviceWorkers:'block'});await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  await context.addInitScript(({user})=>sessionStorage.setItem('mirea.session:web',JSON.stringify({origin:'',remember:false,session:user})),{user});
  const page=pageUnderTest=await context.newPage(),errors=[];page.on('response',async response=>{if(response.url().endsWith('/ai/analyze')&&response.status()>=400)console.error('Synthetic bulk response',response.status(),await response.text());});page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(45000);await page.goto(origin,{waitUntil:'domcontentloaded'});await page.locator('.app-launch').waitFor({state:'detached'});
  if(name==='owner-phone'){
   await page.waitForFunction(()=>document.querySelector('#result-count')?.textContent.includes('1393'));await page.locator('.collection-actions-toggle').click();await page.locator('.bulk-ai-status').waitFor();const buttons=await page.locator('#library-actions-panel button:visible').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom};}));
   for(let a=0;a<buttons.length;a++)for(let b=a+1;b<buttons.length;b++){const x=buttons[a],y=buttons[b];assert(!(x.x<y.right-1&&y.x<x.right-1&&x.y<y.bottom-1&&y.y<x.bottom-1),'bulk action overlap');}
   assert(await page.locator('body').evaluate(n=>n.scrollWidth<=innerWidth+2));await page.screenshot({path:join(output,'owner-phone-library.png')});
   await page.locator('.bulk-ai-analyze').click();await page.locator('.ai-request [name=confirmed]').check();await page.locator('.ai-request .primary').click();await page.getByText('解析の状況を見る',{exact:true}).waitFor();assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_batch_assets').get().n,1393);db.prepare("UPDATE ai_batches SET state='paused'").run();
   await page.screenshot({path:join(output,'owner-phone-bulk.png')});await page.locator('.ai-request .primary').click();console.log('Opened analysis status');await page.screenshot({path:join(output,'owner-phone-analysis.png')});await page.locator('.ai-job-summary').waitFor();assert((await page.locator('.ai-job-summary').innerText()).includes('一時停止 1'));console.log('Analysis counts verified');console.log('Closing analysis status',await page.locator('dialog:has(.ai-user-jobs) .close-modal').count());await page.locator('dialog:has(.ai-user-jobs) .close-modal').click({timeout:5000,noWaitAfter:true});console.log('Closed analysis status');
   if(await page.locator('#open-drawer').isVisible())await page.locator('#open-drawer').click();console.log('Opening owner jobs');await page.locator('#nav-owned-jobs').click();console.log('Opened owner jobs');await page.screenshot({path:join(output,'owner-phone-jobs-pending.png')});await page.locator('.owned-jobs .job-title').first().waitFor();await page.locator('.owned-jobs .job-search').fill('合成作品 0000');await page.locator('.owned-jobs .job-title').filter({hasText:'合成作品 0000'}).waitFor();assert((await page.locator('.owned-jobs').innerText()).includes('合成作品 0000'));assert.equal(await page.locator('.owned-jobs .job-paused').innerText(),'1');assert.equal(await page.locator('.owned-jobs .job-main-row').filter({hasText:'一時停止'}).locator('.job-progress span').innerText(),'一時停止');await page.screenshot({path:join(output,'owner-phone-jobs.png')});let staleRequests=0;page.on('request',request=>{if(request.url().includes('/api/v1/jobs/list'))staleRequests++;});await page.evaluate(async user=>{const {setSession}=await import('/src/api.js');await setSession(user,{remember:false,broadcast:false});},admin);await page.locator('.owned-jobs-modal').waitFor({state:'detached',timeout:8000});assert.equal(staleRequests,0,'old account filters must not be sent after identity changes');
  }else{
   await page.locator('#nav-admin').click();await page.locator('[data-admin-tab=jobs]').click();await page.locator('.job-sort').selectOption('oldest');await page.locator('.job-title').filter({hasText:'他の利用者のアセット'}).first().waitFor();assert((await page.locator('.admin-panel').innerText()).includes('所有アセットの名前'));assert(!(await page.locator('.admin-panel').innerText()).includes('合成作品 0000'));assert((await page.locator('.admin-panel').innerText()).includes('AI · 本文・セリフ'));await page.screenshot({path:join(output,'admin-desktop-private-jobs.png')});await page.locator('[data-admin-tab=ai]').click();await page.locator('[data-ai-tab=jobs]').click();const hidden=page.locator('.ai-job-table tr').filter({hasText:'他の利用者のアセット'});await hidden.first().waitFor();assert.equal(await hidden.locator('button').count(),0,'read-only operator must not see unauthorized analysis actions');
  }
  assert.deepEqual(errors,[]);await context.close();console.log('Verified job visibility UI: '+name);
 }
}catch(error){console.error(error);if(pageUnderTest){await pageUnderTest.screenshot({path:join(output,'job-visibility-failure.png')}).catch(()=>{});console.error(await pageUnderTest.locator('dialog').allInnerTexts().catch(()=>[]));}throw error;}finally{await browser?.close();await vite?.close();await app?.close();db?.close();await rm(folder,{recursive:true,force:true});}
