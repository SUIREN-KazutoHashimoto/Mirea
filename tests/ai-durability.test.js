import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {openDatabase} from '../server/database.js';
import {createAiStore} from '../server/ai-store.js';
import {createAiJobs} from '../server/ai-jobs.js';
import {createAiModels} from '../server/ai-models.js';
import {createAiBatches} from '../server/ai-batches.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t){
 const db=openDatabase(':memory:');t.after(()=>db.close());
 db.exec("INSERT INTO users VALUES('u','fixture@example.test','Synthetic','hash',1);INSERT INTO shelves(id,name,created_at) VALUES('s','Fixture',1);INSERT INTO memberships VALUES('s','u','owner')");
 const item=(id='a',pages=3)=>{db.prepare("INSERT INTO items VALUES(?,'s','Synthetic','fixture','application/pdf',1,'u',1,?,1)").run(id,pages);return db.prepare('SELECT * FROM items WHERE id=?').get(id);};
 return {db,item,store:createAiStore(db)};
}
test('analysis resumes committed units after restart, then retries only failed units',async t=>{
 const c=fixture(t),item=c.item(),dir=await mkdtemp(join(tmpdir(),'mirea-ai-recovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const config={enabled:false,models:{ocr:'model'},contextTokens:4096,outputTokens:1024,memoryMiB:1024,concurrentJobs:1,temporaryMiB:128,quietHours:null};
 const calls=[],options={...c,dataDir:dir,settings:{get value(){return config;}},models:{resolve:()=>({id:'model',files:[]})},runtime:{},maintenance:{locked:false},enabledUser:()=>true,resolveInput:async()=>({stamp:'source',pageCount:3}),analyzeUnit:async({unit})=>{calls.push(unit);return {blocks:[{id:'p'+unit,page:unit+1,text:'Synthetic '+unit}]};}};
 let jobs=createAiJobs(options);const queued=await jobs.enqueue(item,'u',['ocr'],{requestId:randomUUID()});const id=queued.jobIds[0];
 c.db.prepare("INSERT INTO ai_units VALUES(?,0,?)").run(id,JSON.stringify({blocks:[{id:'p0',page:1,text:'Committed'}]}));c.db.prepare("UPDATE ai_jobs SET checkpoint=1,state='running' WHERE id=?").run(id);await jobs.close();
 config.enabled=true;jobs=createAiJobs(options);try{
 await jobs.pump();for(let i=0;i<100&&jobs.get(id).state!=='complete';i++)await pause(20);
 assert.equal(jobs.get(id).state,'complete');assert.deepEqual(calls,[1,2]);assert.equal(c.store.read('a','ocr').unitCount,3);
 c.db.prepare("UPDATE ai_jobs SET state='partial',checkpoint=3 WHERE id=?").run(id);c.db.prepare("UPDATE ai_units SET result_json=? WHERE job_id=? AND unit=1").run(JSON.stringify({errorCode:'AI_ANALYSIS_FAILED'}),id);
 jobs.control(id,'retry');for(let i=0;i<100&&jobs.get(id).state!=='complete';i++)await pause(20);
 assert.equal(jobs.get(id).state,'complete');assert.deepEqual(calls,[1,2,1]);
 assert.equal(c.store.read('a','ocr').result.blocks[0].text,'Committed');
 }finally{await jobs.close();}
});
test('large books publish page units and preserve unresolved corrections without applying them elsewhere',t=>{
 const c=fixture(t),item=c.item('a',1001);
 const source=(function*(){for(let unit=0;unit<1001;unit++)yield {unit,value:{blocks:[{id:'p'+unit,page:unit+1,text:'Synthetic page '+unit}]}};})();
 c.store.publishUnits(item,'ocr','source','model',source,{pageCount:1001});
 const last=c.store.read('a','ocr',{offset:1000,limit:1});assert.equal(last.result.blocks[0].page,1001);assert.equal(last.hasMore,false);
 c.store.edit(item,'ocr','u',{requestId:randomUUID(),revision:0,resultRevision:1,patch:{blocks:{p1000:{text:'Correction'}}}},{pageCount:1001});
 c.store.publish(item,'ocr','source','model-new',{blocks:[{id:'different',page:1,text:'Different passage'}]},{pageCount:1001});
 const current=c.store.read('a','ocr');assert.equal(current.result.blocks[0].text,'Different passage');assert.equal(current.unresolved[0].edit.text,'Correction');
});
test('model download resumes verified partial data and validates every final file',async t=>{
 const c=fixture(t),dir=await mkdtemp(join(tmpdir(),'mirea-ai-models-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const names=['Qwen3VL-4B-Instruct-Q8_0.gguf','mmproj-Qwen3VL-4B-Instruct-F16.gguf'],bytes=Buffer.from('synthetic verified weights'),hash=createHash('sha256').update(bytes).digest('hex');
 const manifest={key:'vision-4b',repo:'Qwen/Qwen3-VL-4B-Instruct-GGUF',license:'apache-2.0',revision:'a'.repeat(40),files:names.map(name=>({name,size:bytes.length,sha256:hash}))};
 let interrupted=false,ranged=false,interrupt;const fetcher=async(url,options)=>{
   const offset=Number(options.headers?.Range?.match(/bytes=(\d+)-/)?.[1]??0);if(offset)ranged=true;
   if(!interrupted){interrupted=true;const stream=new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,10));interrupt=()=>controller.error(Error('Synthetic interruption'));}});return new Response(stream);}
   return new Response(bytes.subarray(offset),{status:offset?206:200,headers:offset?{'content-range':'bytes '+offset+'-'+(bytes.length-1)+'/'+bytes.length}:{}});
 };
 const models=createAiModels({db:c.db,dataDir:dir,fetcher});try{
 const {validateModelManifest}=await import('../server/ai-models.js'),{aiHash}=await import('../server/ai-validation.js'),checked=validateModelManifest(manifest);
 models.accept(manifest,'u',aiHash({id:checked.id,license:manifest.license}));
 for(let i=0;i<100&&models.get(checked.id).progress.receivedBytes!==10;i++)await pause(10);assert.equal(models.get(checked.id).progress.receivedBytes,10);interrupt();
 for(let i=0;i<100&&models.get(checked.id).state==='downloading';i++)await pause(10);
 assert.equal(models.get(checked.id).state,'failed');models.start(checked.id);
 for(let i=0;i<100&&models.get(checked.id).state==='downloading';i++)await pause(10);
 assert.equal(models.get(checked.id).state,'ready');assert.equal(ranged,true);
 assert.deepEqual(await readFile(join(models.resolve(checked.id).folder,names[0])),bytes);
 }finally{await models.close();}
});
test('shelf analysis snapshots more than 1000 assets and is idempotent before expansion',async t=>{
 const c=fixture(t);for(let n=0;n<1001;n++)c.item('asset'+n,1);
 const batches=createAiBatches({db:c.db,enqueue:async()=>({jobIds:[]}),enabledUser:()=>true});try{
 const body={shelfId:'s',features:['ocr'],requestId:randomUUID()},first=batches.create('u',body);
 assert.equal(first.total,1001);assert.equal(batches.create('u',body).batchId,first.batchId);
 assert.throws(()=>batches.create('u',{...body,features:['tags']}),{statusCode:409});
 batches.control('u',first.batchId,'pause');await pause(1100);assert.equal(batches.list('u')[0].waiting,1001);
 }finally{await batches.close();}
});

test('a large prefix of dependency-blocked jobs cannot starve a runnable asset',async t=>{
 const c=fixture(t),dir=await mkdtemp(join(tmpdir(),'mirea-ai-fairness-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(let n=0;n<120;n++){const item=c.item('blocked'+n,1);for(const feature of ['ocr','tags'])c.db.prepare("INSERT INTO ai_jobs(id,asset_id,requester_id,feature,model_id,input_stamp,profile_hash,state,created_at,updated_at) VALUES(?,?,'u',?,'model','source',? ,?,1,1)").run(randomUUID(),item.id,feature,feature,feature==='ocr'?'paused':'queued');}
 const item=c.item('runnable',1),config={enabled:false,models:{ocr:'model'},contextTokens:4096,outputTokens:1024,memoryMiB:1024,concurrentJobs:1,temporaryMiB:128};
 const jobs=createAiJobs({...c,dataDir:dir,settings:{get value(){return config;}},models:{resolve:()=>({id:'model',files:[]})},runtime:{},maintenance:{locked:false},enabledUser:()=>true,resolveInput:async()=>({stamp:'source',pageCount:1}),analyzeUnit:async()=>({blocks:[{id:'synthetic',page:1,text:'Ready'}]})});
 try{const id=(await jobs.enqueue(item,'u',['ocr'],{requestId:randomUUID()})).jobIds[0];config.enabled=true;await jobs.pump();for(let i=0;i<100&&jobs.get(id).state!=='complete';i++)await pause(20);assert.equal(jobs.get(id).state,'complete');assert.equal(c.db.prepare("SELECT count(*) n FROM ai_jobs WHERE state='paused'").get().n,120);}finally{await jobs.close();}
});
