import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createCipheriv } from 'node:crypto';
import { attachVideoStream } from '../web/src/video-stream.js';
import { bindVideoProgress } from '../web/src/progress.js';
import { bindContinuationVideo, createSeriesContinuation } from '../web/src/series-continuation.js';
import { validateManifest, importDownloadKey, encryptedRangeResponse } from '../web/src/download-core.js';
import { AUDIO_EXTENSIONS, AUDIO_TYPES, isTimedKind } from '../server/audio-types.js';

class Audio extends EventTarget {
  currentTime=0;duration=180;paused=true;ended=false;readyState=3;value='';
  canPlayType(){return '';}
  set src(value){this.value=value;this.currentTime=0;}
  get src(){return this.value;}
  load(){this.dispatchEvent(new Event('loadedmetadata'));}
  async play(){this.paused=false;this.dispatchEvent(new Event('play'));}
}
test('audio uses progressive streaming (no full-file blob) and renewed ticket restores current playback rather than old bookmark',async()=>{
  const audio=new Audio(),ticket={url:'/audio?ticket=first',expiresAt:Date.now()+3600000};
  let snapshot;const saved=[];
  const progress={initial:{positionMs:20000,durationMs:180000},bind:fn=>{snapshot=fn;},capture(){const p=snapshot();if(p)saved.push(p);},checkpoint(){this.capture();}};
  const unbind=bindVideoProgress(audio,progress),stream=attachVideoStream(audio,{ticket,absoluteUrl:p=>'https://mirea.test'+p,renew:async()=>({...ticket,url:'/audio?ticket=next'})});
  try{
    assert.match(audio.src,/^https:\/\/mirea.test\/audio\?/);audio.load();assert.equal(audio.currentTime,20);audio.dispatchEvent(new Event('seeked'));assert.equal(saved.length,0);
    await audio.play();audio.currentTime=23;audio.dispatchEvent(new Event('timeupdate'));assert.equal(saved.at(-1).positionMs,23000);
    await stream.reconnect();assert.equal(audio.currentTime,23);assert.equal(audio.paused,false);assert.match(audio.src,/ticket=next/);
    audio.ended=true;audio.dispatchEvent(new Event('ended'));assert.equal(saved.at(-1).positionMs,180000);
  }finally{stream.dispose();unbind();}
});
test('audio ended advances an ordered series once; autoplay denial/cancellation is respected',async()=>{
  const audio=new Audio(),moves=[],a=randomUUID(),b=randomUUID(),context={series:{id:'album'},items:[{id:a,kind:'audio'},{id:b,kind:'audio'}],currentIndex:0};
  const core=createSeriesContinuation({assetId:a,loadContext:async()=>context,move:async(...args)=>moves.push(args),delayMs:0});core.setContext(context);
  const cleanup=bindContinuationVideo(audio,{autoplay:true,onEnded:()=>core.videoEnded(),onReset:()=>core.cancel()});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(audio.paused,false);
  audio.dispatchEvent(new Event('ended'));audio.dispatchEvent(new Event('ended'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(moves.length,1);assert.equal(moves[0][0].id,b);assert.equal(moves[0][1].autoplay,true);
  cleanup();core.dispose();
  const blocked=[];audio.play=async()=>{throw Error('policy');};
  const stop=bindContinuationVideo(audio,{autoplay:true,onBlocked:reason=>blocked.push(reason)});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(blocked,['policy']);stop();
  assert.equal(isTimedKind('audio'),true);for(const mime of Object.values(AUDIO_EXTENSIONS))assert.ok(AUDIO_TYPES.includes(mime));
});
test('encrypted audio Range playback authenticates each chunk and denies expired grants and kind/MIME confusion',async()=>{
  const plain=randomBytes(1048576+71),rawKey=randomBytes(32),m={id:randomUUID(),assetId:randomUUID(),version:1,algorithm:'AES-256-GCM',chunkSize:1048576,kind:'audio',pageCount:1,files:[{index:0,number:1,size:plain.length,chunks:2,mime:'audio/mp4'}]};
  validateManifest(m);const parts=[];
  for(let p=0;p<2;p++){
    const bytes=plain.subarray(p*m.chunkSize,(p+1)*m.chunkSize),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',rawKey,iv);cipher.setAAD(Buffer.from(`mirea-download-v1|${m.id}|0|${p}|${bytes.length}`));parts.push({bytes:Buffer.concat([iv,cipher.update(bytes),cipher.final(),cipher.getAuthTag()])});
  }
  const key=await importDownloadKey(rawKey.toString('base64')),grant={key,manifest:m,expiresAt:1000};let reads=0;
  const response=encryptedRangeResponse(new Request('https://local/audio',{headers:{Range:'bytes=1048570-1048590'}}),grant,0,async(_id,_file,p)=>{reads++;return parts[p];},{now:()=>100});
  assert.equal(reads,0);assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'audio/mp4');assert.deepEqual(Buffer.from(await response.arrayBuffer()),plain.subarray(1048570,1048591));assert.equal(reads,2);
  assert.equal(encryptedRangeResponse(new Request('https://local/audio'),grant,0,()=>assert.fail(),{now:()=>1001}).status,403);
  for(const changed of [{kind:'pdf'},{files:[{...m.files[0],mime:'video/mp4'}]},{files:[{...m.files[0],quality:'720p'}]}])assert.throws(()=>validateManifest({...m,...changed}));
  parts[0].bytes[20]^=1;const bad=encryptedRangeResponse(new Request('https://local/audio',{headers:{Range:'bytes=0-4'}}),grant,0,async()=>parts[0],{now:()=>100});await assert.rejects(()=>bad.arrayBuffer());
});
