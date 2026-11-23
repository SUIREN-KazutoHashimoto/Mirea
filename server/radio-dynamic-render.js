import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdtemp,rm,stat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {dynamicLimit} from './radio-dynamic.js';
import {ffmpegPath} from './media.js';
import {probeAudio} from './audio-transcode.js';
import {runAiProcess} from './ai-runtime.js';

const execute=promisify(execFile);
const cli=fileURLToPath(new URL('../scripts/render-radio-dynamic.py',import.meta.url));
const exec=(path,args,signal,timeout)=>execute(path,args,{timeout,maxBuffer:256*1024,signal,windowsHide:true});

function runVoice(config,args,signal,timeout){
  if(process.platform==='linux'){
    // Use the shipped network-denying inference helper rather than trusting
    // Python or any loaded vendor library to avoid outbound requests.
    return runAiProcess(config.python,args,{signal,timeout,maxOutput:256*1024,env:{LD_LIBRARY_PATH:''}});
  }
  return exec(config.python,args,signal,timeout);
}

export async function loadDynamicRenderer(configPath,pack) {
  if(!configPath)return null;
  const id=await stat(configPath);
  if(!id.isFile()||id.size>8192)throw Error('Invalid local radio renderer configuration');
  const raw=JSON.parse(await readFile(configPath,'utf8'));
  const pathFields=['python','core','onnx','dictionary','model'];
  if(pathFields.some(field=>typeof raw[field]!=='string'||!isAbsolute(raw[field])||raw[field].includes('\0'))||
      !raw.modelTermsReviewed||!Number.isInteger(raw.style)||raw.style<0||raw.style>65535||
      !/^[a-f0-9]{64}$/.test(raw.modelSha256??'')||
      [raw.credit,raw.spokenCredit].some(x=>typeof x!=='string'||!x.trim()||x.length>120||/[\r\n]/.test(x)))
    throw Error('Invalid local radio renderer configuration');
  if(process.platform==='linux'&&raw.python!=='/usr/bin/python3')throw Error('Linux radio requires the packaged Python interpreter');
  const config=Object.fromEntries([...pathFields,'style','modelSha256','modelTermsReviewed','spokenCredit'].map(key=>[key,raw[key]]));
  // Sound under the speech only uses Mirea's original generated pack, not the
  // listener's tracks. Missing assets fall back to speech or music, whichever is ready.
  const bed=pack.get('jingle-standard'), enhancedBed=pack.get('jingle-enhanced');
  const ffmpeg=ffmpegPath();
  if(!ffmpeg)throw Error('Missing local AAC renderer');
  const probe=await mkdtemp(join(tmpdir(),'mirea-fm-probe-'));
  try {
    const job=join(probe,'job.json');
    await writeFile(job,JSON.stringify({config}),{mode:0o600,flag:'wx'});
    await runVoice(config,['-E','-s','-B',cli,'--probe',job],undefined,18_000);
  } finally {
    await rm(probe,{recursive:true,force:true}).catch(()=>{});
  }
  return async(clips,prefs,signal)=>{
    const scratch=await mkdtemp(join(tmpdir(),'mirea-fm-dynamic-')), output=new Map();
    const job=join(scratch,'job.json');
    try{
      await writeFile(job,JSON.stringify({config,clips:clips.slice(0,dynamicLimit.clips).map(({text,quality})=>({text,quality}))}),{mode:0o600,flag:'wx'});
      await runVoice(config,['-E','-s','-B',cli,job],signal,85_000);
      if(bed)await writeFile(join(scratch,'bed.m4a'),bed.bytes);
      if(enhancedBed)await writeFile(join(scratch,'bed-enhanced.m4a'),enhancedBed.bytes);
      for(const [index,clip] of clips.entries()){
        if(signal.aborted)break;
        const wav=join(scratch,index+'.wav'), dest=join(scratch,index+'.m4a');
        try{
          const voice=await probeAudio(wav);
          if(voice.duration<0.7||voice.duration>18)continue;
          const sting=prefs.jingle==='enhanced'?enhancedBed:prefs.jingle==='standard'?bed:null;
          const backing=sting??bed??enhancedBed;
          const intro=sting?0.36:0;
          const duration=(voice.duration+intro+0.18).toFixed(3), fadeAt=(Number(duration)-0.28).toFixed(3);
          const spoken='highpass=f=85,acompressor=threshold=0.13:ratio=2.6:attack=15:release=110,adelay='+Math.round(intro*1000)+':all=1,apad';
          const outputFilter='afade=t=out:st='+fadeAt+':d=0.24,loudnorm=I=-17:TP=-2:LRA=7';
          const input=['-hide_banner','-nostdin','-loglevel','error','-protocol_whitelist','file,pipe','-format_whitelist','wav','-i',wav];
          if(backing){
            const file=join(scratch,backing===enhancedBed?'bed-enhanced.m4a':'bed.m4a');
            input.push('-stream_loop','-1','-protocol_whitelist','file,pipe','-format_whitelist','mov','-i',file,
              '-filter_complex','[0:a]'+spoken+',asplit=2[v][side];[1:a]volume='+(sting?'0.52':'0.17')+
              '[bed];[bed][side]sidechaincompress=threshold=0.028:ratio=12:attack=9:release=220[duck];[v][duck]amix=inputs=2:normalize=0,'+outputFilter+'[mix]','-map','[mix]');
          }else input.push('-af',spoken+','+outputFilter);
          await exec(ffmpeg,[...input,'-t',duration,'-map_metadata','-1','-c:a','aac','-b:a','96k','-ac','2','-ar','48000','-movflags','+faststart',dest],signal,15_000);
          const info=await probeAudio(dest), durationMs=Math.round(info.duration*1000), size=(await stat(dest)).size;
          if(!Number.isFinite(durationMs)||durationMs<700||durationMs>20000||size<16||size>dynamicLimit.bytes||info.audio.codec_name!=='aac')continue;
          // Verify post-encode levels, not just the requested target.
          const {stderr}=await exec(ffmpeg,['-hide_banner','-nostdin','-protocol_whitelist','file,pipe','-i',dest,
            '-af','loudnorm=I=-17:TP=-2:LRA=7:print_format=json','-f','null','-'],signal,12_000);
          const measurement=JSON.parse(stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1)??'null');
          const loudness=Number(measurement?.input_i),peak=Number(measurement?.input_tp);
          if(!Number.isFinite(loudness)||loudness< -21||loudness> -14||!Number.isFinite(peak)||peak> -1)continue;
          output.set(clip.id,{bytes:await readFile(dest),durationMs,credit:raw.credit,loudness,peak});
        }catch{/* Do not log station or filenames, or reserve room for missing audio. */}
      }
      return output;
    }finally{await rm(scratch,{recursive:true,force:true}).catch(()=>{});}
  };
}
