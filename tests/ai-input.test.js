import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Worker} from 'node:worker_threads';import sharp from 'sharp';
import {waitForMediaWorker} from '../server/media-worker-lifecycle.js';import {makePdf} from './fixtures.js';
for(const mode of ['image','pdf'])test('AI '+mode+' preparation publishes only after the native worker has exited',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mirea-ai-page-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=join(dir,mode==='pdf'?'source.pdf':'source.png'),destination=join(dir,'page.png');
 await writeFile(source,mode==='pdf'?makePdf():await sharp({create:{width:1200,height:1100,channels:3,background:'white'}}).png().toBuffer());
 const worker=new Worker(new URL('../server/ai-page-worker.js',import.meta.url),{workerData:{source,destination,page:1,mode},resourceLimits:{maxOldGenerationSizeMb:512}});
 worker.once('message',result=>t.diagnostic(JSON.stringify({prepared:!result.error,code:result.code})));
 const result=await waitForMediaWorker(worker,{timeoutMs:10000});assert(!result.error,JSON.stringify(result));assert.equal(worker.threadId,-1);assert.equal((await sharp(destination).metadata()).format,'png');
});
