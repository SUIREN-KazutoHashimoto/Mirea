// Development-only visual regression. A new, sandboxed headless browser, an
// ephemeral database and loopback listeners; never a user's browser or server.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright';
import {createServer,mergeConfig} from 'vite';
import {createApp} from '../server/app.js';
import baseConfig from '../vite.config.js';
import {makePdf} from '../tests/fixtures.js';
import sharp from 'sharp';

const dataDir=await mkdtemp(join(tmpdir(),'mirea-management-ui-'));
const output=resolve(process.env.MIREA_UI_ARTIFACT_DIR??'.local/ui-checks');await mkdir(output,{recursive:true});
let app,vite,browser,page;const report=[];
try{
 app=await createApp({dataDir,rateLimit:false,allowRegistration:true});
 const owner=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'表示確認ユーザー',email:'ui-qa@example.invalid',password:'synthetic-ui-check-password'}})).json();
 const headers={authorization:'Bearer '+owner.token},shelf=(await app.inject({method:'POST',url:'/api/v1/shelves',headers,payload:{name:'表示確認の本棚'}})).json().id;
 const privateShelf=(await app.inject({method:'POST',url:'/api/v1/shelves',headers,payload:{name:'プライベートの表示確認'}})).json().id;
 const db=new DatabaseSync(join(dataDir,'mirea.sqlite'));
 try{
  const pdf=makePdf(),cover=await sharp({create:{width:300,height:450,channels:3,background:'#5050aa'}}).webp().toBuffer();
  for(const n of [1,2,3,4]){
   const id=randomUUID();await writeFile(join(dataDir,'uploads',id),pdf);await writeFile(join(dataDir,'thumbnails',id+'.webp'),cover);
   db.prepare("INSERT INTO items VALUES(?,?,?,'fixture.pdf','application/pdf',?,?,?,1,1)").run(id,shelf,'表示確認の本・長いタイトル '+n,pdf.length,owner.user.id,Date.now()+n);
   db.prepare('INSERT INTO admin_jobs(id,kind,asset_id,state,progress_json,error,requested_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),'thumbnail',id,['running','queued','complete','failed'][n-1],JSON.stringify({stage:'thumbnail',percent:n===1?42:n===3?100:0}),n===4?'表紙を生成できませんでした（合成データ）':null,owner.user.id,Date.now()-n*60000,Date.now());
  }
  db.prepare("INSERT INTO user_access VALUES(?,'admin',0) ON CONFLICT(user_id) DO UPDATE SET server_role='admin'").run(owner.user.id);
  db.prepare('UPDATE shelves SET private=1 WHERE id=?').run(privateShelf);
 }finally{db.close();}
 await app.listen({host:'127.0.0.1',port:0});const apiOrigin='http://127.0.0.1:'+app.server.address().port;
 const bootstrap="sessionStorage.setItem('mirea.session:web',"+JSON.stringify(JSON.stringify({origin:'',remember:false,session:owner}))+');';
 vite=await createServer(mergeConfig(baseConfig,{configFile:false,server:{host:'127.0.0.1',port:0,proxy:{'/api':apiOrigin}},plugins:[{name:'isolated-ui-fixture',transformIndexHtml(){return [{tag:'script',attrs:{type:'module',src:'/qa-bootstrap.js'},injectTo:'head-prepend'}];},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/qa-bootstrap.js')return next();res.setHeader('Content-Type','text/javascript');res.setHeader('Cache-Control','no-store');res.end(bootstrap);});}}]}));
 await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;
 browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.MIREA_UI_BROWSER?{executablePath:process.env.MIREA_UI_BROWSER}:{})});
 for(const [name,viewport,colorScheme]of [['desktop-dark',{width:1440,height:1000},'dark'],['phone-dark',{width:390,height:844},'dark'],['phone-light',{width:320,height:740},'light'],['landscape',{width:844,height:390},'dark']]){
  const context=await browser.newContext({viewport,colorScheme,serviceWorkers:'block',acceptDownloads:false});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(15000);await page.goto(origin,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.querySelector('#nav-settings,.retry-connection'));
  if(await page.locator('.retry-connection').count())await page.locator('.retry-connection').click();
  await page.locator('#nav-settings').waitFor({state:'attached'});
  const nav=async selector=>{await page.waitForTimeout(200);const menu=page.locator('#open-drawer');if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')!=='true')await menu.click();await page.locator(selector).click();};
  const shot=async label=>{await page.screenshot({path:join(output,name+'-'+label+'.png')});const layout=await page.locator('dialog[open]').last().evaluate(node=>({width:node.clientWidth,scrollWidth:node.scrollWidth,height:node.clientHeight,scrollHeight:node.scrollHeight,overflows:[...node.querySelectorAll('.manager-panel,.job-table-wrap,.transfer-list,.upload-form-section')].filter(n=>n.getClientRects().length&&n.scrollWidth>n.clientWidth+2).map(n=>n.className)}));assert(layout.scrollWidth<=layout.width+2,JSON.stringify({name,label,layout}));assert.deepEqual(layout.overflows,[],name+' '+label+' content overflow');report.push({name,label,layout});const scroller=page.locator('dialog[open] .manager-panel:visible,dialog[open] .transfer-list:visible,dialog[open] .upload-batch-form:visible').last();if(await scroller.count()&&await scroller.evaluate(n=>n.scrollHeight>n.clientHeight+30)){const top=await scroller.evaluate(n=>{const top=n.scrollTop;n.scrollTop=n.scrollHeight;return top;});await page.screenshot({path:join(output,name+'-'+label+'-bottom.png')});await scroller.evaluate((n,top)=>n.scrollTop=top,top);}};
  await nav('#nav-settings');await page.locator('.account-form').waitFor({state:'attached'});
  for(const section of ['display','account','storage','updates','records','delete']){
   if(await page.locator('.manager-section-select').isVisible())await page.locator('.manager-section-select').selectOption(section);else await page.locator('[data-manager-section="'+section+'"]').click();
   assert.equal(await page.locator('[data-manager-panel]:visible').count(),1);await shot('settings-'+section);
  }
  assert(await page.locator('.account-delete button').isDisabled(),'last admin cannot delete own account');await page.locator('.settings-modal .close-modal').click();
  await nav('#nav-admin');await page.locator('.admin-modal[open]').waitFor();
  const adminTab=async tab=>{if(await page.locator('.admin-section-select').isVisible())await page.locator('.admin-section-select').selectOption(tab);else await page.locator('[data-admin-tab="'+tab+'"]').click();await page.locator('.admin-panel[aria-busy=false]').waitFor();};
  await adminTab('jobs');await page.locator('.job-main-row').first().waitFor();assert.equal(await page.locator('.admin-current-jobs .job-main-row').count(),2);
  await shot('jobs-current');await page.locator('.job-title').first().click();await page.locator('.job-title').first().focus();
  await page.evaluate(()=>{window.qaJob=document.querySelector('.job-title');});
  assert.equal(await page.evaluate(async()=>{const api=await import('/src/api.js');return api.reconnectSession();}),true);
  await page.locator('.refresh-jobs').click();assert.equal(await page.evaluate(()=>window.qaJob===document.querySelector('.job-title')),true,'polling must retain the actual row');assert.equal(await page.locator('.job-title').first().getAttribute('aria-expanded'),'true');await shot('jobs-details');
  await page.locator('.job-state-filter').selectOption('queued');assert.equal(await page.locator('.admin-current-jobs .job-main-row').count(),1);await page.locator('.job-state-filter').selectOption('all');
  await page.locator('[data-job-view=history]').click();assert.equal(await page.locator('.admin-job-history .job-main-row').count(),2);assert.equal(await page.locator('.admin-job-history button[data-kind]').count(),0);await shot('jobs-history');
  await page.locator('[data-job-view=assets]').click();await page.locator('.admin-assets .admin-card').first().waitFor();await shot('jobs-regenerate');
  for(const tab of ['overview','processing','cleanup','users','shelves','statistics','backups','updates','audit','reset']){await adminTab(tab);await shot('admin-'+tab);}
  await page.locator('.admin-modal .close-modal').click();
  await page.evaluate(async()=>{const {trackTransfer,clearTransferRecords}=await import('/src/transfer-manager.js');clearTransferRecords();window.qaTransfers=[];for(const [direction,state,title]of [['upload','running','フォルダ・18件のコンテンツ'],['download','running','長いタイトルの音楽・暗号化ダウンロード'],['download','failed','再試行が必要なダウンロード'],['upload','complete','送信完了・サーバーで後処理中']]){const row=trackTransfer({direction,title,notifications:false,cancel:()=>{},open:()=>{},work:update=>{window.qaTransfers.push(update);update({percent:42,message:'分割転送中'});return state==='complete'?Promise.resolve():state==='failed'?Promise.reject(Error('接続が切れました（合成データ）')):new Promise(()=>{});}});row.promise.catch(()=>{});}});
  await nav('#transfer-center');await page.locator('.transfer-row').first().waitFor();assert.equal(await page.locator('.transfer-row').count(),2);await shot('transfers-active');
  await page.locator('.transfer-details').first().focus();await page.evaluate(()=>{window.qaFocused=document.activeElement;window.qaTransfers[0]({percent:57});});assert.equal(await page.evaluate(()=>document.activeElement===window.qaFocused),true,'progress must retain focus');
  for(const [view,count]of [['attention',1],['complete',1],['all',4]]){await page.locator('[data-transfer-view='+view+']').click();assert.equal(await page.locator('.transfer-row').count(),count);await shot('transfers-'+view);}
  await page.locator('.transfer-direction').selectOption('download');assert.equal(await page.locator('.transfer-row').count(),2);await page.locator('.transfer-query').fill('再試行');assert.equal(await page.locator('.transfer-row').count(),1);await page.locator('.transfer-center .close-modal').click();
  await page.evaluate(async()=>{const transfers=await import('/src/transfer-manager.js');transfers.clearTransferRecords();});
  const remoteAssets=Array.from({length:616},(_,n)=>({id:randomUUID(),shelfId:shelf,title:'別端末の送信 '+String(n).padStart(4,'0'),mimeType:'application/pdf',totalBytes:1000}));const registration=await app.inject({method:'POST',url:'/api/v1/transfers/upload-queue',headers,payload:{assets:remoteAssets}});assert.equal(registration.statusCode,200,registration.body);
  await nav('#transfer-center');await page.waitForFunction(()=>document.querySelector('.transfer-active-count')?.textContent==='616');assert.equal(await page.locator('.transfer-row').count(),100);await page.locator('.transfer-show-more').click();assert.equal(await page.locator('.transfer-row').count(),200);await shot('transfers-assets');await page.locator('.transfer-query').fill(remoteAssets[0].title);await page.waitForFunction(()=>document.querySelectorAll('.transfer-row').length===1);await page.locator('.transfer-row').evaluate(n=>window.remoteRowFixture=n);
  const ledger=new DatabaseSync(join(dataDir,'mirea.sqlite')),uploadId=randomUUID();ledger.exec('PRAGMA foreign_keys=ON');try{const session=ledger.prepare('SELECT id FROM sessions WHERE user_id=?').get(owner.user.id).id,created=ledger.prepare('SELECT created_at FROM upload_queue WHERE id=?').get(remoteAssets[0].id).created_at;ledger.prepare("INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at) VALUES(?,?,?,?,?, ?,1000,'uploading',?,?)").run(uploadId,shelf,owner.user.id,session,remoteAssets[0].title,JSON.stringify([{filename:'fixture.pdf',mime:'application/pdf',size:1000}]),created,Date.now()+60000);ledger.prepare('UPDATE upload_queue SET upload_id=? WHERE id=?').run(uploadId,remoteAssets[0].id);ledger.prepare('INSERT INTO upload_parts VALUES(?,0,0,256,?)').run(uploadId,'0'.repeat(64));
   await page.locator('.transfer-refresh').click();await page.waitForFunction(()=>document.querySelector('.transfer-row')?.dataset.state==='running');assert.equal(await page.locator('.transfer-row progress').evaluate(n=>n.value),26);assert.equal(await page.locator('.transfer-row').evaluate(n=>n===window.remoteRowFixture),true);await shot('transfers-remote-progress');
   ledger.prepare("UPDATE upload_sessions SET state='processing',processing_json=? WHERE id=?").run(JSON.stringify({stage:'thumbnail',percent:40}),uploadId);await page.locator('.transfer-refresh').click();await page.waitForFunction(()=>document.querySelector('.transfer-row')?.dataset.state==='processing');await shot('transfers-remote-processing');ledger.prepare("UPDATE upload_sessions SET state='complete' WHERE id=?").run(uploadId);await page.locator('.transfer-refresh').click();await page.waitForFunction(()=>document.querySelector('.transfer-row')?.dataset.state==='complete');
  }finally{ledger.prepare('DELETE FROM upload_sessions WHERE id=?').run(uploadId);ledger.close();const cleanup=await app.inject({method:'POST',url:'/api/v1/transfers/upload-queue/cancel',headers,payload:{ids:remoteAssets.map(a=>a.id)}});assert.equal(cleanup.statusCode,200,cleanup.body);const remaining=(await app.inject({method:'GET',url:'/api/v1/transfers/uploads',headers})).json();assert.equal(remaining.queue.length,0,JSON.stringify(remaining.queue.slice(0,2)));}await page.locator('.transfer-center .close-modal').click();

  await nav('[data-shelf="'+shelf+'"]');await nav('#open-upload');await page.locator('.manager-upload').waitFor();await page.waitForFunction(()=>!document.querySelector('.manager-upload [type=submit]').disabled);await shot('upload');
  await page.locator('input[name=file]').setInputFiles([{name:'one.pdf',mimeType:'application/pdf',buffer:makePdf()},{name:'two.pdf',mimeType:'application/pdf',buffer:makePdf()}]);await page.locator('[data-entry-title]').first().waitFor();assert.equal(await page.locator('[data-entry-title]').count(),2);await shot('upload-selected');await page.locator('.manager-upload .close-modal').click();
  await nav('[data-shelf="'+privateShelf+'"]');await page.locator('.private-shelf-auth').waitFor();await shot('private-shelf-password');
  await page.locator('.private-shelf-auth input').fill('incorrect');await page.locator('.private-shelf-auth [type=submit]').click();await page.locator('.private-shelf-auth .form-error:not([hidden])').waitFor();await shot('private-shelf-error');
  await page.locator('.private-shelf-auth input').fill('synthetic-ui-check-password');await page.locator('.private-shelf-auth [type=submit]').click();await page.locator('.private-shelf-auth').waitFor({state:'detached'});await nav('#nav-all');await nav('[data-shelf="'+privateShelf+'"]');await page.locator('.private-shelf-auth').waitFor();await page.locator('.private-shelf-auth').evaluate(n=>n.closest('dialog').close());

  await nav('[data-shelf="'+shelf+'"]');await page.locator('.card-open[data-open]').first().click({button:'right'});await page.locator('.action-details').click();await page.locator('.detail-regenerate-thumbnail').waitFor();await page.locator('.detail-regenerate-thumbnail').click();await shot('owner-thumbnail-confirm');
  if(name==='landscape'){await page.locator('.start-thumbnail-job').click();await page.waitForFunction(()=>document.querySelector('.thumbnail-job-status')?.textContent==='サムネイルを更新しました。',{},{timeout:30000});await shot('owner-thumbnail-complete');}await page.locator('dialog[open] .close-modal').click();
  assert.deepEqual(errors,[],name+' browser errors');report.push({name,pageErrors:errors});await context.close();page=null;
 }
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({success:true,screenshots:report.filter(r=>r.label).length,output}));
}catch(error){if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});throw error;}
finally{await browser?.close();await vite?.close();await app?.close();assert(resolve(dataDir).startsWith(resolve(tmpdir())+sep+'mirea-management-ui-'));await rm(dataDir,{recursive:true,force:true});}
