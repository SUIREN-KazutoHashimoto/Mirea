import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {aiProcessEnvironment,runAiProcess,createAiRuntime} from '../server/ai-runtime.js';
test('inference child processes cannot inherit application secrets',()=>{
 const saved=process.env.MIREA_SYNTHETIC_SECRET;process.env.MIREA_SYNTHETIC_SECRET='DO NOT INHERIT';
 try{const env=aiProcessEnvironment();assert.equal(env.MIREA_SYNTHETIC_SECRET,undefined);assert.equal(env.HF_HUB_OFFLINE,'1');assert.equal(env.HF_HUB_DISABLE_TELEMETRY,'1');}finally{if(saved===undefined)delete process.env.MIREA_SYNTHETIC_SECRET;else process.env.MIREA_SYNTHETIC_SECRET=saved;}
});
test('CPU runtime process cancellation waits for the child, and output is bounded',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'mirea-ai-runtime-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const script=join(folder,'child.mjs');await writeFile(script,"if(process.argv[2]==='large')process.stdout.write('x'.repeat(100000));else setInterval(()=>{},1000);");
 const controller=new AbortController(),task=runAiProcess(process.execPath,[script],{signal:controller.signal,root:folder});setTimeout(()=>controller.abort(),100);
 if(process.platform==='linux'){await assert.rejects(task,{code:'AI_RUNTIME_UNAVAILABLE'});return;}
 await assert.rejects(task,{name:'AbortError'});await assert.rejects(runAiProcess(process.execPath,[script,'large'],{maxOutput:100,root:folder}),{code:'AI_OUTPUT_LIMIT'});
});
test('a missing optional runtime is reported without changing settings or starting downloads',async()=>{
 const runtime=createAiRuntime({root:join(tmpdir(),'mirea-missing-runtime'),settings:()=>({})});
 try{const supported=await runtime.supported();assert.equal(supported.cpu,false);assert.equal(supported.vulkan,false);assert.equal(supported.music,false);}finally{await runtime.close();}
});

test('local inference keeps an explicit total deadline and cancels or bounds a slow response without exposing tokens',async t=>{
 const {createServer}=await import('node:http'),{requestAiJson}=await import('../server/ai-http.js');let seen=0;
 const server=createServer((req,res)=>{seen++;if(req.url==='/v1/embeddings'){const timer=setTimeout(()=>res.end(JSON.stringify({data:[1]})),80);res.once('close',()=>clearTimeout(timer));}else res.end('x'.repeat(1000));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));const origin='http://127.0.0.1:'+server.address().port;
 assert.deepEqual(await requestAiJson(origin,'/v1/embeddings',{token:'synthetic',body:{},timeout:1000}),{data:[1]});
 await assert.rejects(requestAiJson(origin,'/v1/embeddings',{token:'synthetic',body:{},timeout:10}),{code:'AI_TIMEOUT'});
 const controller=new AbortController(),task=requestAiJson(origin,'/v1/embeddings',{token:'synthetic',body:{},signal:controller.signal});controller.abort();await assert.rejects(task,{name:'AbortError'});
 await assert.rejects(requestAiJson(origin,'/v1/chat/completions',{token:'synthetic',body:{},maxOutput:10}),{code:'AI_OUTPUT_LIMIT'});
 assert.throws(()=>requestAiJson('http://example.test','/v1/embeddings',{}));assert.throws(()=>requestAiJson(origin,'/arbitrary',{}));assert(seen>=3);
});

async function syntheticEngines(t,memoryMiB=512){
 const {createServer}=await import('node:http'),{EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream');
 const engines=[],gates=new Map();
 const config={backend:'cpu',threads:1,contextTokens:2048,outputTokens:512,memoryMiB,residentModels:3,loadTimeoutMs:5000,idleMs:60000};
 const runtime=createAiRuntime({settings:()=>config,spawnProcess:(program,args)=>{
  const child=new EventEmitter(),port=Number(args[args.indexOf('--port')+1]),model=args[args.indexOf('--model')+1];
  child.pid=Number.MAX_SAFE_INTEGER;child.stderr=new PassThrough();let killed=false,release;const gate=new Promise(resolve=>{release=resolve;});
  const server=createServer((req,res)=>{res.setHeader('Connection','close');res.setHeader('Content-Type','application/json');res.end(req.url==='/health'?'{}':JSON.stringify({data:[{index:0,embedding:Array(32).fill(.25)}]}));});
  const entry={child,server,model,killed:false,release};engines.push(entry);
  child.kill=()=>{if(killed)return true;killed=true;entry.killed=true;server.closeAllConnections();server.close(()=>{(gates.has(model)?gate:Promise.resolve()).then(()=>{child.emit('exit',0);child.emit('close',0);});});return true;};
  server.listen(port,'127.0.0.1',()=>child.emit('spawn'));return child;
 }});
 t.after(async()=>{for(const entry of engines)entry.release();await runtime.close();});
 const model=id=>({id,folder:join(tmpdir(),id),files:[{name:'synthetic.gguf',size:0}]});
 return {runtime,engines,model,hold(id){gates.set(join(tmpdir(),id,'synthetic.gguf'),true);},release(id){for(const entry of engines)if(entry.model===join(tmpdir(),id,'synthetic.gguf'))entry.release();}};
}
test('model eviction retains its memory reservation until the process has closed',async t=>{
 const f=await syntheticEngines(t,129);await f.runtime.embed(f.model('old'),['synthetic']);f.hold('old');
 const next=f.runtime.embed(f.model('next'),['synthetic']);
 assert.equal(f.engines[0].killed,true);assert.equal(f.runtime.uses('old'),true);
 await assert.rejects(f.runtime.embed(f.model('other'),['synthetic']),{code:'AI_RESOURCE_WAIT'});
 assert.equal(f.engines.length,1);f.release('old');await next;
 assert.equal(f.runtime.uses('old'),false);assert.equal(f.engines.length,2);
});
test('requests racing an eviction reuse the newly started model rather than starting it twice',async t=>{
 const f=await syntheticEngines(t);await f.runtime.embed(f.model('old'),['synthetic']);f.hold('old');
 const first=f.runtime.embed(f.model('next'),['synthetic']).then(()=>({ok:true}),error=>({error}));assert.equal(f.engines[0].killed,true);
 await f.runtime.embed(f.model('next'),['synthetic']).catch(error=>{throw new Error('Competing request failed',{cause:error});});f.release('old');const result=await first;assert.equal(result.ok,true,result.error?.code);
 assert.equal(f.engines.filter(entry=>entry.model===join(tmpdir(),'next','synthetic.gguf')).length,1);
});
