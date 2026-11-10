import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {httpError} from './security.js';
export function createAiSelfTest({dataDir,models,runtime,settings,maintenance}){
 let task,controller,closing=false,result=null;
 async function run(music){
  await mkdir(join(dataDir,'ai'),{recursive:true,mode:0o700});
  const folder=await mkdtemp(join(dataDir,'ai','self-test-')),signal=controller.signal;
  try{
   const available=await runtime.supported();result.runtime=available;
   const check=async(feature,work)=>{const start=Date.now();try{const value=await work();result.checks.push({feature,state:'passed',elapsedMs:Date.now()-start,...value});}catch(error){result.checks.push({feature,state:signal.aborted?'cancelled':'failed',elapsedMs:Date.now()-start,code:/^AI_[A-Z_]+$/.test(error.code??'')?error.code:'AI_SELF_TEST_FAILED'});}};
   const vision=['ocr','tags','chapters'].map(f=>settings.value.models[f]).find(Boolean);
   if(vision)await check('ocr',async()=>{
    const {createCanvas}=await import('@napi-rs/canvas');const canvas=createCanvas(900,400),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,900,400);ctx.fillStyle='black';ctx.font='42px sans-serif';ctx.fillText('MIREA LOCAL TEST',60,150);const image=join(folder,'page.png');await writeFile(image,await canvas.encode('png'));
    const value=await runtime.generate(models.resolve(vision),{images:[image],text:'Read the text in this test image. Return JSON {"text":"the text"}.',signal});if(!String(value.text??'').toUpperCase().includes('MIREA'))throw Error('Recognition test did not match');return {note:'合成画像の文字認識'};
   });
   if(settings.value.models.embedding&&!signal.aborted)await check('embedding',async()=>{const rows=await runtime.embed(models.resolve(settings.value.models.embedding),['Mirea synthetic local test.','Mirea synthetic local test.'],{signal});if(rows[0].length!==rows[1].length||rows[0].some((v,i)=>Math.abs(v-rows[1][i])>.0001))throw Error('Embedding test did not match');return {note:'同じ合成文の索引生成',dimensions:rows[0].length};});
   if(settings.value.models.transcript&&!signal.aborted)await check('transcript',async()=>{const count=16000*2,bytes=Buffer.alloc(44+count*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(count*2,40);const path=join(folder,'silence.wav');await writeFile(path,bytes);await runtime.transcribe(models.resolve(settings.value.models.transcript),path,{signal,folder});return {note:'無音データによる読込確認（認識精度の評価ではありません）'};});
   if(music&&settings.value.models.structure&&!signal.aborted)await check('structure',async()=>{const model=models.resolve(settings.value.models.structure);model.stems=models.resolveByKey('music-stems');const count=44100*15,bytes=Buffer.alloc(44+count*8);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(3,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(44100,24);bytes.writeUInt32LE(44100*8,28);bytes.writeUInt16LE(8,32);bytes.writeUInt16LE(32,34);bytes.write('data',36);bytes.writeUInt32LE(count*8,40);for(let i=0;i<count;i++){const value=Math.sin(i*2*Math.PI*440/44100)*.15;bytes.writeFloatLE(value,44+i*8);bytes.writeFloatLE(value,48+i*8);}const path=join(folder,'music.wav');await writeFile(path,bytes);const value=await runtime.structure(model,path,{signal,folder});if(!Array.isArray(value.segments))throw Error('Structure test invalid');return {note:'合成音による処理確認（楽曲分類の評価ではありません）'};});
   result.state=signal.aborted?'cancelled':result.checks.length&&result.checks.every(c=>c.state==='passed')?'complete':'attention';result.sessions=runtime.inspect();
  }finally{result.finishedAt=Date.now();await rm(folder,{recursive:true,force:true});}
 }
 return {get status(){return result;},start({music=false}={}){if(closing||maintenance.locked)throw httpError(409,'保守処理が終わってから確認してください。');if(task)throw httpError(409,'動作確認を実行中です。');controller=new AbortController();result={id:randomUUID(),state:'running',createdAt:Date.now(),checks:[]};task=run(music).catch(()=>{result.state=controller.signal.aborted?'cancelled':'attention';result.finishedAt=Date.now();}).finally(()=>{task=null;});return result;},cancel(){controller?.abort();return result;},get busy(){return Boolean(task);},async close(){closing=true;controller?.abort();await task;}};
}
