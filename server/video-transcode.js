import {jobCancellationSignal} from './job-context.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { availableParallelism,totalmem } from 'node:os';
import bundledFfprobe from '@derhuerst/ffprobe-static';
import { ffmpegPath } from './media.js';
import { httpError } from './security.js';
import { mediaBinary } from './media-binary.js';

const exec = promisify(execFile);
const FORMATS = 'mov,matroska,webm,avi,asf,mpeg,mpegts,flv';
const TIERS = [{height:1080,rate:5000000},{height:720,rate:2800000},{height:480,rate:1400000},{height:360,rate:800000}];
const MAX_SECONDS = 6 * 60 * 60;
const MAX_FILE = 8 * 1024 ** 3;
const MAX_OUTPUT = 32 * 1024 ** 3;
const closingError=()=>Object.assign(new Error('Video processing paused for server shutdown'),{code:'SERVER_CLOSING'});
export const ffprobePath = () => mediaBinary('ffprobe', bundledFfprobe);

export async function probeVideo(source) {
  try {
    if(!ffprobePath())throw Object.assign(new Error('No FFprobe executable'),{code:'ENOENT'});
    const { stdout } = await exec(ffprobePath(), ['-v','error','-threads','1','-max_alloc','268435456','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,
      '-show_entries','format=format_name,duration:stream=index,codec_type,codec_name,width,height,bit_rate,pix_fmt,duration,sample_aspect_ratio,color_transfer:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation',
      '-of','json',source], {timeout:30000,maxBuffer:1024*1024,signal:jobCancellationSignal(),windowsHide:true,killSignal:'SIGKILL'});
    const data = JSON.parse(stdout), video = data.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    if(!video)throw Object.assign(new Error('No decoded video stream'),{code:'EMPTY_VIDEO_OUTPUT'});
    const duration = Number(video?.duration || data.format?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS ||
      !Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width < 2 || video.height < 2 ||
      video.width > 8192 || video.height > 8192 || video.width * video.height > 33554432) throw new Error('Unsupported video dimensions/duration');
    // Do not silently flatten HDR into washed-out SDR. A tone-mapping pipeline
    // needs a separate, tested colour policy before those sources are accepted.
    if (['smpte2084','arib-std-b67'].includes(video.color_transfer)) throw new Error('HDR is not supported');
    const rotation = Number(video.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
    const [sarN,sarD] = String(video.sample_aspect_ratio || '1:1').split(':').map(Number);
    const sar = sarN > 0 && sarD > 0 ? sarN / sarD : 1;
    let width = video.width * sar, height = video.height;
    if (Math.abs(rotation % 180) === 90) [width,height] = [height,width];
    return {duration,width,height,format:data.format?.format_name,video,audio:data.streams.find(s => s.codec_type === 'audio')};
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(503,'動画解析用のFFprobeが見つかりません。サーバー設定を確認してください。');
    throw Object.assign(httpError(422,'動画を解析できません。対応コンテナ・映像トラック・6時間以内／8K以下のSDR動画かを確認してください。'),{cause:error});
  }
}

export function videoLadder(width,height) {
  // Portrait tiers use the same bounding boxes rotated by 90 degrees.
  const portrait = height > width, short = Math.min(width,height), long = Math.max(width,height);
  let tiers = TIERS.filter(t => t.height <= short);
  if (!tiers.length) tiers = [{height:Math.floor(short/2)*2,rate:800000}];
  return tiers.map(t => {
    const scale = Math.min(1, t.height/short, (t.height*16/9)/long);
    return {quality:`${t.height}p`,width:Math.max(2,Math.floor(width*scale/2)*2),height:Math.max(2,Math.floor(height*scale/2)*2),bitrate:t.rate+128000,portrait};
  });
}

export function encoderThreads(concurrency=5,cpus=availableParallelism(),memory=process.constrainedMemory?.()||totalmem(),pixels=1920*1080,rank=0){
 const jobs=Math.max(1,concurrency),budget=Math.max(1,cpus-2),cpu=Math.floor(budget/jobs)+(rank<budget%jobs?1:0),perThread=Math.max(32*1024**2,pixels*12),ram=Math.floor(Math.max(perThread,memory-512*1024**2)/jobs/perThread);
 return Math.max(1,Math.min(16,cpu,ram));
}
export function createVideoTranscoder({active}={}) {
  let closed=false;
  const controllers=new Set();
  const threadBudget=(controller,pixels)=>encoderThreads(Math.max(1,controllers.size,active?.()??0),availableParallelism(),process.constrainedMemory?.()||totalmem(),pixels,Math.max(0,[...controllers].indexOf(controller)));
  async function run(args,{authorize,deadline,onProgress,folder,controller,duration,pixels}) {
    authorize();
    if (closed) throw closingError();
    if(!ffmpegPath())throw httpError(503,'動画変換用のFFmpegが見つかりません。');
    const threads=String(threadBudget(controller,pixels));
    const child=spawn(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y','-threads',threads,'-filter_threads',threads,'-filter_complex_threads','1','-max_alloc','268435456',...args],{cwd:folder,windowsHide:true,stdio:['ignore','pipe','pipe'],signal:jobCancellationSignal(),killSignal:'SIGKILL'});
    let failure,stderr='',progress='',checking=false;
    const kill=error=>{failure??=error;child.kill('SIGKILL');};
    const aborted=()=>kill(controller.signal.reason??closingError());
    controller.signal.addEventListener('abort',aborted,{once:true});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
    child.stdout.on('data',chunk=>{
      progress=(progress+chunk).slice(-8192);
      const matches=[...progress.matchAll(/out_time_us=(\d+)/g)];
      if(matches.length) onProgress?.(Math.min(99,Math.floor(Number(matches.at(-1)[1])/1000000/duration*100)));
    });
    const timer=setInterval(async()=>{
      if(checking)return;checking=true;
      try {
        authorize();
        if(Date.now()>deadline)throw new Error('Video processing deadline exceeded');
        const files=await readdir(folder);let total=0;
        for(const name of files){const info=await stat(join(folder,name));total+=info.size;if(info.size>MAX_FILE)throw new Error('Video output exceeds 8 GiB');}
        if(total>MAX_OUTPUT)throw new Error('Video outputs exceed 32 GiB');
      }catch(error){kill(error);}finally{checking=false;}
    },1000);
    try {
      await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0&&!failure?resolve():reject(failure??new Error(`FFmpeg failed (${code}): ${stderr}`)));});
      authorize();
    } finally {clearInterval(timer);controller.signal.removeEventListener('abort',aborted);}
  }
  async function convert(source,folder,{authorize,report}) {
    const controller=new AbortController();controllers.add(controller);
    const deadline=Date.now()+MAX_SECONDS*1000;
    try {
      if(closed)throw closingError();
      authorize();report({stage:'probe',percent:0});
      const info=await probeVideo(source),ladder=videoLadder(info.width,info.height);
      await mkdir(folder,{recursive:true,mode:0o700});
      for(const [index,tier] of ladder.entries()) {
        const mp4=join(folder,`${tier.quality}.mp4`);
        const settings={authorize,deadline,controller,folder,duration:info.duration,pixels:info.width*info.height,onProgress:percent=>report({stage:'encode',quality:tier.quality,percent,completed:index,total:ladder.length})};
        // Fixed 30fps, aligned 4-second keyframes in every rendition. Encode all
        // frames (never the 6-second preview). Silence is added only if no audio.
        const threads=String(threadBudget(controller,info.width*info.height));
        const encodeArgs=['-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-threads',threads,'-i',source,
          ...(!info.audio?['-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000']:[]),
          '-map',`0:${info.video.index}`,'-map',info.audio?`0:${info.audio.index}`:'1:a:0','-sn','-dn','-map_metadata','-1','-map_chapters','-1',
          '-vf',`scale=${tier.width}:${tier.height},setsar=1,fps=30`,
          '-c:v','libx264','-preset','veryfast','-profile:v','high','-level:v','4.1','-pix_fmt','yuv420p','-threads',threads,
          '-b:v',String(tier.bitrate-128000),'-maxrate',String(tier.bitrate-128000),'-bufsize',String((tier.bitrate-128000)*2),
          '-g','120','-keyint_min','120','-sc_threshold','0','-force_key_frames','expr:gte(t,n_forced*4)',
          '-c:a','aac','-ac','2','-ar','48000','-b:a','128k','-af','aresample=async=1:first_pts=0,apad',
          '-t',String(info.duration),'-movflags','+faststart','-progress','pipe:1','-f','mp4',mp4];
        await run(encodeArgs,settings);
        report({stage:'validate',quality:tier.quality,percent:0,completed:index,total:ladder.length});
        let result;
        try{result=await probeVideo(mp4);}catch(error){
          // Same narrow edit-list compatibility policy as thumbnail generation:
          // retry only proven-empty MOV/MP4 output, never valid authored edits.
          if(error.cause?.code!=='EMPTY_VIDEO_OUTPUT'||!info.format?.split(',').includes('mov'))throw error;
          await run(['-ignore_editlist','1',...encodeArgs],settings);
          result=await probeVideo(mp4);
        }
        const size=(await stat(mp4)).size;
        if(!size||size>MAX_FILE||result.video.codec_name!=='h264'||result.video.pix_fmt!=='yuv420p'||result.audio?.codec_name!=='aac'||result.video.width!==tier.width||result.video.height!==tier.height||
          Math.abs(result.duration-info.duration)>Math.max(.25,info.duration*.005)) throw new Error('Transcoded output validation failed');
        // Read every MP4 packet strictly while remuxing, then decode every HLS
        // frame below. The exact same encoded packets need only one full decode.
        await run(['-xerror','-err_detect','explode','-protocol_whitelist','file,pipe','-i',mp4,'-map','0:v:0','-map','0:a:0','-c','copy','-hls_time','4','-hls_playlist_type','vod',
          '-hls_segment_type','fmp4','-hls_flags','independent_segments','-hls_fmp4_init_filename',`${tier.quality}-init.mp4`,
          '-hls_segment_filename',join(folder,`${tier.quality}-%05d.m4s`),'-f','hls',join(folder,`${tier.quality}.m3u8`)],settings);
        const playlist=await readFile(join(folder,`${tier.quality}.m3u8`),'utf8');
        if(!playlist.includes('#EXT-X-ENDLIST')||!playlist.includes('#EXT-X-MAP:'))throw new Error('Incomplete HLS playlist');
        const names=[...playlist.matchAll(/URI="([^"]+)"|^([^#\s][^\r\n]*)/gm)].map(m=>m[1]||m[2]);
        if(!names.length)throw new Error('Empty HLS rendition');
        for(const name of names){if(!/^[0-9]+p-(?:init\.mp4|\d{5}\.m4s)$/.test(name)||(await stat(join(folder,name))).size<=0)throw new Error('Invalid HLS segment');}
        await run(['-xerror','-protocol_whitelist','file,crypto,data','-i',join(folder,`${tier.quality}.m3u8`),'-map','0:v:0','-map','0:a:0','-f','null','-'],settings);
        tier.size=size;tier.files=[`${tier.quality}.m3u8`,...names];
      }
      authorize();
      let total=0;for(const name of await readdir(folder))total+=(await stat(join(folder,name))).size;
      if(total>MAX_OUTPUT)throw new Error('Video outputs exceed 32 GiB');
      return {version:1,duration:info.duration,originalWidth:info.width,originalHeight:info.height,codec:'H.264 + AAC',renditions:ladder};
    }catch(error){
      if(error.statusCode||error.code==='SERVER_CLOSING')throw error;
      throw Object.assign(httpError(422,'動画の変換・検証に失敗しました。原本を保持しています。空き容量・FFmpeg設定・対応形式を確認して再試行してください。'),{cause:error});
    }finally{controllers.delete(controller);}
  }
  return {convert(...args){return convert(...args);},close(){closed=true;for(const controller of controllers)controller.abort(closingError());}};
}
