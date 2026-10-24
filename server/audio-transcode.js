import {jobCancellationSignal} from './job-context.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { audioPlaceholder } from './audio-art.js';
import { ffmpegPath } from './media.js';
import { ffprobePath } from './video-transcode.js';
import { httpError } from './security.js';

const exec = promisify(execFile);
const FORMATS = 'mp3,mov,aac,wav,flac,ogg,aiff,asf,matroska,webm';
const MAX_SECONDS = 6 * 3600, MAX_BYTES = 1024 ** 3;
const INPUT = ['-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-threads','1'];
const closingError = () => Object.assign(new Error('Audio processing paused for shutdown'),{code:'SERVER_CLOSING'});

export async function probeAudio(source) {
  try {
    if (!ffprobePath()) throw Object.assign(new Error('Missing FFprobe'),{code:'ENOENT'});
    const {stdout} = await exec(ffprobePath(),['-v','error','-max_alloc','268435456',...INPUT,
      '-show_entries','format=duration:stream=index,codec_type,codec_name,profile,channels,sample_rate,duration,width,height:stream_disposition=attached_pic',
      '-of','json',source],{timeout:30000,maxBuffer:1024*1024,signal:jobCancellationSignal(),windowsHide:true,killSignal:'SIGKILL'});
    const data=JSON.parse(stdout),audio=data.streams?.find(s=>s.codec_type==='audio');
    const duration=Number(audio?.duration || data.format?.duration);
    if (!audio || !Number.isFinite(duration) || duration<=0 || duration>MAX_SECONDS ||
      !Number.isInteger(audio.channels) || audio.channels<1 || audio.channels>8 ||
      !Number.isFinite(Number(audio.sample_rate)) || Number(audio.sample_rate)<8000 || Number(audio.sample_rate)>192000 ||
      data.streams.some(s=>s.codec_type==='video' && !s.disposition?.attached_pic)) throw new Error('Invalid audio-only source');
    const cover=data.streams.find(s=>s.codec_type==='video' && s.disposition?.attached_pic &&
      ['mjpeg','png','webp'].includes(s.codec_name) && s.width>0 && s.height>0 &&
      s.width<=8192 && s.height<=8192 && s.width*s.height<=33554432);
    return {duration,audio,cover};
  } catch(error) {
    if(error.code==='ENOENT')throw httpError(503,'音声解析用のFFprobeが見つかりません。サーバー設定を確認してください。');
    throw Object.assign(httpError(422,'音声を解析できません。対応形式・音声トラック・6時間以内のファイルかを確認してください。映像付きのファイルは動画として登録してください。'),{cause:error});
  }
}

export function createAudioTranscoder() {
  let closed=false;
  const children=new Set();
  async function run(args,{authorize,deadline,output,onProgress,duration}) {
    authorize();if(closed)throw closingError();
    if(!ffmpegPath())throw httpError(503,'音声変換用のFFmpegが見つかりません。');
    const child=spawn(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y',
      '-threads','1','-filter_threads','1','-max_alloc','268435456',...args],{windowsHide:true,stdio:['ignore','pipe','pipe'],signal:jobCancellationSignal(),killSignal:'SIGKILL'});
    let failure,stderr='',progress='',checking=false;
    const kill=error=>{failure??=error;child.kill('SIGKILL');};
    const active={kill};children.add(active);
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
    child.stdout.on('data',chunk=>{
      progress=(progress+chunk).slice(-8192);
      const matches=[...progress.matchAll(/out_time_us=(\d+)/g)];
      if(matches.length)onProgress?.(Math.min(99,Math.floor(Number(matches.at(-1)[1])/1000000/duration*100)));
    });
    const timer=setInterval(async()=>{
      if(checking)return;checking=true;
      try{authorize();if(Date.now()>deadline)throw new Error('Audio processing deadline exceeded');
        if(output && (await stat(output).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))?.size>MAX_BYTES)throw new Error('Audio output exceeds 1 GiB');
      }catch(error){kill(error);}finally{checking=false;}
    },1000);
    try{await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0&&!failure?resolve():reject(failure??new Error(`FFmpeg failed (${code}): ${stderr}`)));});authorize();if(closed)throw closingError();}
    finally{clearInterval(timer);children.delete(active);}
  }
  async function convert(source,folder,{authorize,report}) {
    const deadline=Date.now()+MAX_SECONDS*1000;
    try{
      if(closed)throw closingError();authorize();report({stage:'probe',percent:0});
      const info=await probeAudio(source);
      if(closed)throw closingError();
      await mkdir(folder,{recursive:true,mode:0o700});
      const output=join(folder,'audio.m4a'),thumbnail=join(folder,'thumbnail.jpg');
      const settings={authorize,deadline,output,duration:info.duration,onProgress:percent=>report({stage:'encode',percent})};
      report({stage:'encode',percent:0});
      await run(['-xerror',...INPUT,'-i',source,'-map',`0:${info.audio.index}`,'-vn','-sn','-dn',
        '-map_metadata','-1','-map_chapters','-1','-c:a','aac','-profile:a','aac_low',
        '-ac',info.audio.channels===1?'1':'2','-ar','48000','-b:a',info.audio.channels===1?'96k':'192k',
        '-movflags','+faststart','-progress','pipe:1','-f','ipod',output],settings);
      report({stage:'validate',percent:0});
      const result=await probeAudio(output),size=(await stat(output)).size;
      if(!size || size>MAX_BYTES || result.audio.codec_name!=='aac' || result.audio.profile!=='LC' || result.audio.channels!==(info.audio.channels===1?1:2) || Number(result.audio.sample_rate)!==48000 || result.cover ||
        Math.abs(result.duration-info.duration)>Math.max(2,info.duration*.02))throw new Error('Invalid normalized audio');
      await run(['-xerror',...INPUT,'-i',output,'-map','0:a:0','-f','null','-'],settings);
      report({stage:'thumbnail',percent:0});
      let artwork=false;
      if(info.cover){
        try{await run([...INPUT,'-i',source,'-map',`0:${info.cover.index}`,'-frames:v','1','-an',
          '-vf','scale=600:600:force_original_aspect_ratio=decrease','-c:v','mjpeg','-f','image2',thumbnail],{...settings,deadline:Math.min(deadline,Date.now()+30000),output:thumbnail});artwork=true;}
        catch(error){authorize();if(closed || error.code==='SERVER_CLOSING')throw closingError();/* Unusable art does not discard valid audio. */}
      }
      if(!artwork)await audioPlaceholder(thumbnail);
      authorize();if(closed)throw closingError();
      return {version:1,duration:result.duration,codec:'AAC-LC',bitrate:info.audio.channels===1?96000:192000,channels:result.audio.channels,sampleRate:48000,size,artwork};
    }catch(error){
      if(error.statusCode || error.code==='SERVER_CLOSING')throw error;
      throw Object.assign(httpError(422,'音声の変換・検証に失敗しました。原本を保持しています。空き容量・FFmpeg設定・対応形式を確認して再試行してください。'),{cause:error});
    }
  }
  return {convert(...args){return convert(...args);},close(){closed=true;for(const child of children)child.kill(closingError());}};
}
