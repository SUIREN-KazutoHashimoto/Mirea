import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';

const temporary=await mkdtemp(join(tmpdir(),'mirea-admin-queues-ui-'));
let server,browser;
try{
  server=await createServer({root:'web',configFile:false,cacheDir:join(temporary,'vite'),
    server:{host:'127.0.0.1',port:0,hmr:false,watch:null},plugins:[{
      name:'synthetic-job-queues-fixture',
      configureServer(vite){vite.middlewares.use('/job-queue-fixture',(_req,res)=>{
        res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic job queues</title><section class="admin-panel"></section>');
      });}
    }]});
  await server.listen();
  const origin='http://127.0.0.1:'+server.httpServer.address().port;
  browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.MIREA_UI_BROWSER?{executablePath:process.env.MIREA_UI_BROWSER}:{})});
  async function open({width,height,ownerOnly=false,legacy=false}){
    const context=await browser.newContext({viewport:{width,height},colorScheme:'dark',serviceWorkers:'block'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(8000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/job-queue-fixture');
    await page.evaluate(async({ownerOnly,legacy})=>{
      await Promise.all([import('/src/style.css'),import('/src/admin.css'),import('/src/management.css')]);
      const {mountAdminJobs}=await import('/src/admin-jobs-ui.js'), panel=document.querySelector('.admin-panel');
      const n=(running=0,queued=0,paused=0,failed=0)=>({running,queued,paused,failed});
      const overview={thumbnail:n(3,245),preview:n(2,4),transcode:n(1,20,0,6),ai:n(4,9,2,1),transfer:n(1,0),repair:n(0,1),other:n()};
      window.fixture={calls:[],confirmations:[],settings:0,status:[]};
      const f=window.fixture;
      const api=async(path,opts)=>{
        f.calls.push({path,method:opts?.method??'GET'});
        if(opts?.method)throw Error('Fixture must never execute queued operations');
        const q=new URL(path,location.origin).searchParams;
        if(path.startsWith('/admin/jobs/list?')||path.startsWith('/jobs/list?')){
          const hist=q.get('view')==='history';
          const rows=hist?[{id:'fixture-failure',assetId:'fixture-asset',kind:'transcode',state:'failed',error:'Synthetic conversion failed',source:'admin',createdAt:Date.now()}]:
            [{id:'fixture-progress',assetId:'fixture-asset',title:'Synthetic progress',kind:'thumbnail',state:'running',progress:{percent:42},source:'admin',createdAt:Date.now()}];
          return {rows,summary:n(11,279,2,7),total:1,offset:0,limit:Number(q.get('limit')),nextOffset:null,previousOffset:null,...(legacy||ownerOnly?{}:{families:overview})};
        }
        if(path.startsWith('/admin/assets?q='))return {assets:[],nextCursor:null};
        if(path==='/admin/assets/repair-preview')return {count:1,busy:0,healthy:3,assets:[{title:'Synthetic repair',reasons:['Trial missing artifact']}]};
        throw Error('Unexpected fixture route '+path);
      };
      await mountAdminJobs({panel,api,ownerOnly,esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;'),bytes:n=>String(n),
        valid:()=>true,status:e=>f.status.push(String(e)),openProcessing:()=>f.settings++,confirm:(title,description)=>f.confirmations.push({title,description})});
    },{ownerOnly,legacy});
    return {page,context,errors};
  }
  const desktop=await open({width:1280,height:900}),page=desktop.page;
  const thumbnail=page.locator('[data-queue-family=thumbnail]');
  assert.equal(await page.locator('.job-queue-card').count(),7);
  assert.equal(await thumbnail.locator('[data-queue-state=running] strong').textContent(),'3');
  assert.equal(await thumbnail.locator('[data-queue-state=queued] strong').textContent(),'245');
  assert.equal(await page.locator('[data-queue-family=other] [data-queue-state=queued] strong').textContent(),'0');
  assert.equal(await page.locator('.job-summary').isVisible(),false,'legacy overview does not duplicate card counts');
  assert.equal(await page.locator('[data-queue-bulk]').count(),3);
  assert.equal(await page.locator('[data-queue-tool=repair]').count(),1,'missing-artifact action is global');
  await thumbnail.locator('[data-queue-bulk]').click();
  assert.match(await page.evaluate(()=>window.fixture.confirmations[0].title),/全アセットの表紙/);
  assert.equal(await page.evaluate(()=>window.fixture.calls.some(c=>c.method!=='GET')),false);
  await thumbnail.locator('[data-queue-state=running]').click();
  await page.getByText('Synthetic progress',{exact:true}).waitFor();
  assert.equal(await page.locator('.job-state-filter').inputValue(),'running');
  assert.equal(await page.evaluate(()=>new URL(window.fixture.calls.at(-1).path,location.origin).searchParams.get('family')),'thumbnail');
  await page.locator('.admin-current-jobs .job-title').click();
  assert.equal(await page.locator('.job-detail-row').isVisible(),true);
  assert.equal(await page.locator('.job-progress progress').evaluate(x=>x.value),42);
  await page.locator('[data-job-view=queues]').click();
  await page.locator('[data-queue-family=transcode] [data-queue-state=failed]').click();
  await page.locator('.admin-job-history .job-title').click();
  await page.getByText('Synthetic conversion failed',{exact:true}).waitFor();
  assert.equal(await page.locator('.job-state-filter').inputValue(),'failed');
  await page.locator('[data-job-view=queues]').click();
  await page.locator('[data-queue-tool=settings]').click();
  assert.equal(await page.evaluate(()=>window.fixture.settings),1);
  await page.locator('[data-queue-tool=repair]').click();
  await page.waitForFunction(()=>window.fixture.confirmations.length===2);
  assert.equal(await page.evaluate(()=>window.fixture.calls.some(c=>c.method!=='GET')),false);
  assert.deepEqual(await page.evaluate(()=>window.fixture.status),[]);
  const mobile=await open({width:390,height:844});
  assert.equal(await mobile.page.locator('.job-queue-card').count(),7);
  assert(await mobile.page.locator('.admin-panel').evaluate(x=>x.scrollWidth<=x.clientWidth+1),'390px card/actions fit');
  assert(await mobile.page.locator('.job-queue-card').evaluateAll(cards=>cards.every(x=>x.scrollWidth<=x.clientWidth+1)));
  const owner=await open({width:390,height:844,ownerOnly:true});
  assert.equal(await owner.page.locator('.job-queue-card').count(),0,'owner view unchanged');
  const legacy=await open({width:1000,height:800,legacy:true});
  assert.equal(await legacy.page.locator('.job-queue-unavailable').isVisible(),true);
  assert.equal(await legacy.page.locator('[data-queue-state=queued] strong').first().textContent(),'—','missing counts are not rendered as 0');
  for(const x of [desktop,mobile,owner,legacy]){assert.deepEqual(x.errors,[]);await x.context.close();}
  console.log('Chrome queue cards: accurate large counts, authorized family drill-down, details/history, confirmation only, legacy/owner fallback, desktop + 390px.');
}finally{await browser?.close();await server?.close();await rm(temporary,{recursive:true,force:true});}
