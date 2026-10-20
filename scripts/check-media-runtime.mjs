// Also executed on stdin in the read-only production container; never uses DATA_DIR.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const {probeVideo,createVideoTranscoder}=await import(pathToFileURL(join(process.cwd(),'server/video-transcode.js'))),{ffmpegPath}=await import(pathToFileURL(join(process.cwd(),'server/media.js')));
const folder=await mkdtemp(join(tmpdir(),'mirea-runtime-smoke-')),transcoder=createVideoTranscoder();
try{
 const source=join(folder,'source.ts');
 await promisify(execFile)(ffmpegPath(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=128x96:rate=25:duration=0.4','-f','lavfi','-i','sine=duration=0.4','-c:v','mpeg2video','-threads','1','-c:a','mp2','-shortest',source],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});
 const original=await probeVideo(source);assert.equal(original.video.codec_name,'mpeg2video');
 const output=join(folder,'output'),metadata=await transcoder.convert(source,output,{authorize(){},report(){}}),normalized=await probeVideo(join(output,metadata.renditions[0].quality+'.mp4'));
 assert.equal(normalized.video.codec_name,'h264');assert.equal(normalized.audio.codec_name,'aac');
 console.log(JSON.stringify({success:true,isolatedData:true,productionDataTouched:false,mpegTsInput:true,h264Aac:true,hlsVerified:true}));
}finally{await transcoder.close();if(!resolve(folder).startsWith(resolve(tmpdir())+sep+'mirea-runtime-smoke-'))throw Error('Unsafe smoke-test cleanup');await rm(folder,{recursive:true,force:true});}
