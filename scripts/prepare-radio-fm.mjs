// Local operator tool. No HTTP, database access, model download, or listener inputs.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,rename,rm,stat} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {parseArgs,promisify} from 'node:util';
import {ffmpegPath} from '../server/media.js';
import {probeAudio} from '../server/audio-transcode.js';

const {values}=parseArgs({options:{out:{type:'string'},voice:{type:'string'}}});
if(!values.out)throw Error('Expected --out NEW_PACK_DIR [--voice REVIEWED_VOICE_RENDER_DIR]');
const out=resolve(values.out), ffmpeg=ffmpegPath();
if(!ffmpeg)throw Error('FFmpeg unavailable');
const execute=promisify(execFile);
const run=args=>execute(ffmpeg,['-hide_banner','-nostdin',...args],{timeout:45_000,maxBuffer:128*1024,windowsHide:true});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=values.voice?resolve(values.voice):null;
const credit=source?JSON.parse(await readFile(join(source,'voice-render.json'),'utf8')):null;
if(source&&(credit?.version!==1||typeof credit.credit!=='string'||!credit.credit.trim()||credit.credit.length>120||
   !/^[a-f0-9]{64}$/.test(credit.modelSha256)||Array.isArray(credit.files)||!credit.files))throw Error('Invalid reviewed voice render');
const temp=await mkdtemp(join(dirname(out),'.'+basename(out)+'-'));
const wavFile=join(temp,'tmp-jingle.wav');

function jingle(enhanced) {
  // Synthesized, deliberately original motif made of a quiet bell lead and pad.
  const rate=48000, duration=enhanced?3.1:1.85, count=Math.round(rate*duration);
  const data=Buffer.alloc(44+count*4),byteCount=count*4;
  data.write('RIFF');data.writeUInt32LE(36+byteCount,4);data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(2,22);
  data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*4,28);data.writeUInt16LE(4,32);data.writeUInt16LE(16,34);
  data.write('data',36);data.writeUInt32LE(byteCount,40);
  const notes=(enhanced?[71,76,78,83,81,78,76]:[71,76,78,83]).map((note,i)=>({hz:440*2**((note-69)/12),start:0.09+i*(enhanced?0.32:0.35)}));
  for(let i=0;i<count;i++){
    const t=i/rate;
    for(let channel=0;channel<2;channel++){
      let value=0;
      for(const [n,{hz,start}] of notes.entries()){
        const x=t-start-(enhanced&&channel===1?0.012:0);
        if(x>=0&&x<0.95){
          const phase=2*Math.PI*hz*x, amp=Math.min(1,x/0.035)*Math.exp(-3.8*x)*Math.min(1,(0.95-x)/0.08);
          const pan=enhanced?(channel===n%2?0.98:0.61):0.86;
          value+=amp*pan*(Math.sin(phase)+0.21*Math.sin(2*phase)+0.075*Math.sin(3*phase))*0.27;
        }
      }
      if(enhanced){
        const pad=(Math.sin(2*Math.PI*164.81*t)+Math.sin(2*Math.PI*(channel===0?246.94:247.2)*t))*0.033;
        value+=pad*Math.min(1,t/0.33)*Math.max(0,Math.min(1,(duration-0.12-t)/0.44));
      }
      const soften=Math.min(1,(duration-t)/0.12);
      data.writeInt16LE(Math.round(Math.max(-1,Math.min(1,value*soften))*32767),44+i*4+channel*2);
    }
  }
  return data;
}

async function measure(input) {
  const {stderr}=await run(['-protocol_whitelist','file,pipe','-format_whitelist','mov','-i',input,'-t','30','-af','loudnorm=I=-17:TP=-2:LRA=7:print_format=json','-f','null','-']);
  const json=stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
  if(!json)throw Error('No loudness measurement');
  return JSON.parse(json);
}

const clips={};
try{
  for(const level of ['standard','enhanced']){
    await writeFile(wavFile,jingle(level==='enhanced'));
    await render('jingle-'+level,wavFile, level);
    if(source){
      const file=join(source,'mc-'+level+'.wav');
      if((await stat(file)).size>8*1024*1024||digest(await readFile(file))!==credit.files[level])throw Error('Voice WAV is missing or no longer matches reviewed render');
      await render('mc-'+level,file,level,credit.credit);
    }
  }
  await rm(wavFile);
  await writeFile(join(temp,'fm-pack.json'),JSON.stringify({version:1,clips},null,2)+'\n');
  // Publish only after encoding and checking every requested asset. Never overwrite the live pack.
  try{await stat(out);throw Error('Output pack already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  await rename(temp,out);
  console.log(JSON.stringify({ready:Object.keys(clips),measurements:Object.values(clips).map(({durationMs,lufs,truePeak})=>({durationMs,lufs,truePeak}))}));
}catch(error){await rm(temp,{recursive:true,force:true});throw error;}

async function render(id,input,level,voiceCredit){
  const sourceAudio=await probeAudio(input);
  if(!Number.isFinite(sourceAudio.duration)||sourceAudio.duration<0.7||sourceAudio.duration>20)throw Error('Source audio outside 0.7–20 seconds');
  // Align voice and IDs with one controlled target; measure true peak after the AAC encode.
  const dest=join(temp,id+'.m4a');
  const filters=id.startsWith('mc-')?'highpass=f=85,acompressor=threshold=0.126:ratio=2.4:attack=18:release=120,':'';
  await run(['-protocol_whitelist','file,pipe','-format_whitelist','wav','-i',input,'-map','0:a:0','-map_metadata','-1','-af',filters+'loudnorm=I=-17:TP=-2:LRA=7','-c:a','aac','-b:a',level==='enhanced'?'160k':'112k',
    '-ac','2','-ar','48000','-movflags','+faststart',dest]);
  const metadata=await probeAudio(dest), stats=await measure(dest), bytes=await readFile(dest);
  const durationMs=Math.round(metadata.duration*1000), lufs=Number(stats.input_i), truePeak=Number(stats.input_tp);
  if(metadata.audio.codec_name!=='aac'||!Number.isSafeInteger(durationMs)||durationMs<700||durationMs>20000||
     bytes.length>1024*1024||!Number.isFinite(lufs)||lufs< -21||lufs> -14||!Number.isFinite(truePeak)||truePeak> -1)
    throw Error('FM encode did not pass duration, loudness, true peak or size gates: '+JSON.stringify({id,codec:metadata.audio.codec_name,durationMs,lufs,truePeak,bytes:bytes.length}));
  clips[id]={durationMs,lufs,truePeak,sha256:digest(bytes),...(voiceCredit?{credit:voiceCredit}:{})};
}
