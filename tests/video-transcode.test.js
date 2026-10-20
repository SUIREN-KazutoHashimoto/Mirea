import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, createDecipheriv } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { createMediaProcessor, ffmpegPath } from '../server/media.js';
import { probeVideo, videoLadder } from '../server/video-transcode.js';
import { makeMp4 } from './fixtures.js';

async function setup(t,overrides={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-transcode-'));
  const options={dataDir,rateLimit:false,chunkSize:65536,logger:process.env.TEST_LOG==='1',...overrides};
  const c={dataDir,options,app:await createApp(options)};
  t.after(async()=>{await c.app.close();await rm(dataDir,{recursive:true,force:true});});
  c.req=(method,url,user,payload)=>c.app.inject({method,url:'/api/v1'+url,headers:user?{authorization:`Bearer ${user.token}`}:{},...(payload===undefined?{}:{payload})});
  c.register=async name=>(await c.req('POST','/auth/register',null,{name,email:name+'@example.test',password:'video-testing-password'})).json();
  c.owner=await c.register('owner');c.viewer=await c.register('viewer');c.outsider=await c.register('outsider');
  c.shelf=(await c.req('POST','/shelves',c.owner,{name:'Video'})).json().id;
  await c.req('POST',`/shelves/${c.shelf}/members`,c.owner,{email:c.viewer.user.email,role:'viewer'});
  c.start=async(bytes,{mime='video/mp4',filename='test.mp4',retainOriginal=false}={})=>{
    const response=await c.req('POST',`/shelves/${c.shelf}/uploads`,c.owner,{title:filename,retainOriginal,files:[{filename,mime,size:bytes.length}]});
    assert.equal(response.statusCode,201,response.body);const upload=response.json();
    for(let part=0;part<Math.ceil(bytes.length/upload.chunkSize);part++){
      const chunk=bytes.subarray(part*upload.chunkSize,(part+1)*upload.chunkSize);
      const result=await c.app.inject({method:'PUT',url:`/api/v1/uploads/${upload.id}/files/0/parts/${part}`,headers:{authorization:`Bearer ${c.owner.token}`,'content-type':'application/octet-stream','x-chunk-sha256':createHash('sha256').update(chunk).digest('hex')},payload:chunk});
      assert.equal(result.statusCode,204,result.body);
    }
    assert.equal((await c.req('POST',`/uploads/${upload.id}/complete`,c.owner)).statusCode,202);return upload;
  };
  c.wait=async(id,state='complete')=>{
    for(let n=0;n<1500;n++){const r=await c.req('GET',`/uploads/${id}`,c.owner);assert.equal(r.statusCode,200,r.body);const s=r.json();if(s.state!=='processing'){assert.equal(s.state,state,r.body);return s;}await delay(20);}assert.fail('Transcode timeout');
  };
  return c;
}

test('ladder respects source bounds for landscape, portrait, square and tiny sources',()=>{
  for(const [width,height] of [[1920,1080],[1080,1920],[1080,1080],[64,64],[320,180]]){
    const ladder=videoLadder(width,height);
    assert.ok(ladder.length);for(const r of ladder){assert.ok(r.width<=width&&r.height<=height);assert.equal(r.width%2,0);assert.equal(r.height%2,0);}
  }
  assert.deepEqual(videoLadder(1920,1080).map(r=>r.quality),['1080p','720p','480p','360p']);
  assert.deepEqual(videoLadder(1280,720).map(r=>r.quality),['720p','480p','360p']);
});

test('new upload validates full H264/AAC + all HLS variants before deleting original; ACL protects every playlist/segment; selected-quality download stays encrypted',async t=>{
  const c=await setup(t),original=await makeMp4(join(c.dataDir,'input.mp4'),{duration:8.2,width:1280,height:720,audio:true});
  const upload=await c.start(original),{item}=await c.wait(upload.id);
  assert.equal(item.id,upload.id);assert.equal(item.mimeType,'video/mp4');
  const metadata=(await c.req('GET',`/items/${item.id}/video`,c.owner)).json();
  assert.deepEqual(metadata.renditions.map(r=>r.quality),['720p','480p','360p']);assert.equal(metadata.originalRetained,false);
  const canonical=await probeVideo(join(c.dataDir,'uploads',item.id));
  assert.equal(canonical.video.codec_name,'h264');assert.equal(canonical.audio.codec_name,'aac');assert.ok(canonical.duration>8,'not the 6-second preview');
  await assert.rejects(stat(join(c.dataDir,'originals',item.id)),{code:'ENOENT'});
  for(const dir of ['uploads/staging','uploads/transfers'])assert.ok(!(await readdir(join(c.dataDir,dir))).includes(item.id));
  const ticket=(await c.req('POST',`/items/${item.id}/playback-ticket`,c.viewer)).json();
  const master=await c.app.inject(ticket.hlsUrl);assert.equal(master.statusCode,200);assert.equal(master.headers['cache-control'],'private, no-store, no-transform');
  assert.match(master.body,/RESOLUTION=1280x720/);
  const base=new URL('https://mirea.test'+ticket.hlsUrl),variant=new URL(master.body.split('\n').find(s=>s.startsWith('360p.')),base);
  const playlist=await c.app.inject(variant.pathname+variant.search);assert.equal(playlist.statusCode,200);
  const segment=new URL(playlist.body.split('\n').find(s=>s.endsWith('.m4s'+variant.search)),variant);
  assert.equal((await c.app.inject(segment.pathname+segment.search)).statusCode,200);
  assert.equal((await c.app.inject(segment.pathname)).statusCode,401);
  assert.equal((await c.req('GET',`/items/${item.id}/hls/360p-00000.m4s`,c.outsider)).statusCode,404);
  assert.equal((await c.app.inject(ticket.hlsUrl.replace(item.id,randomUUID()))).statusCode,401);
  assert.equal((await c.req('GET',`/items/${item.id}/hls/thumbnail.jpg`,c.owner)).statusCode,404);
  const download=await c.req('POST',`/items/${item.id}/download`,c.viewer,{quality:'360p'});assert.equal(download.statusCode,200,download.body);
  const manifest=download.json().manifest;assert.equal(manifest.files[0].quality,'360p');assert.equal(download.json().key,undefined);
  const opened=await c.req('POST',`/downloads/${manifest.id}/open`,c.viewer),key=Buffer.from(opened.json().key,'base64');
  const chunk=await c.req('GET',`/downloads/${manifest.id}/files/0/parts/0`,c.viewer),bytes=chunk.rawPayload;
  const length=Math.min(manifest.chunkSize,manifest.files[0].size),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(`mirea-download-v1|${manifest.id}|0|0|${length}`));decipher.setAuthTag(bytes.subarray(-16));
  const plain=Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]);
  const rendition=await readFile(join(c.dataDir,'videos',item.id,'360p.mp4'));assert.deepEqual(plain,rendition.subarray(0,length));assert.notDeepEqual(bytes.subarray(0,length),plain);
  assert.equal((await c.req('POST',`/items/${item.id}/download`,c.viewer,{quality:'2160p'})).statusCode,400);
  const secondQuality=await c.req('POST',`/items/${item.id}/download`,c.viewer,{quality:'720p'});
  assert.notEqual(secondQuality.json().manifest.id,manifest.id);
  assert.equal((await c.req('POST',`/downloads/${manifest.id}/open`,c.viewer)).statusCode,200,'another device/quality must not revoke this cached package');
  await c.req('DELETE',`/shelves/${c.shelf}/members/${c.viewer.user.id}`,c.owner);
  assert.equal((await c.app.inject(segment.pathname+segment.search)).statusCode,404);
  assert.equal((await c.req('POST',`/downloads/${manifest.id}/open`,c.viewer)).statusCode,404);
});

test('server shutdown keeps processing state and verified source, then startup resumes the same asset ID',async t=>{
  let entered,rejectJob;
  const started=new Promise(resolve=>{entered=resolve;});
  const videoTranscoder={convert(){entered();return new Promise((_resolve,reject)=>{rejectJob=reject;});},close(){rejectJob?.(Object.assign(new Error('Shutdown'),{code:'SERVER_CLOSING'}));}};
  const c=await setup(t,{videoTranscoder}),original=await makeMp4(join(c.dataDir,'restart.mp4'));
  const upload=await c.start(original);await started;await c.app.close();
  const db=new DatabaseSync(join(c.dataDir,'mirea.sqlite'));
  assert.equal(db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(upload.id).state,'processing');db.close();
  assert.deepEqual(await readFile(join(c.dataDir,'uploads','staging',upload.id,'raw-1')),original);
  c.app=await createApp({...c.options,videoTranscoder:undefined});
  const {item}=await c.wait(upload.id);assert.equal(item.id,upload.id);
  await assert.rejects(stat(join(c.dataDir,'originals',item.id)),{code:'ENOENT'});
});

test('conversion/postprocessing failure and restart preserve raw source indefinitely, retry succeeds, opt-in original remains byte-identical',async t=>{
  let fail=true;
  const media=createMediaProcessor(),c=await setup(t,{mediaProcessor:{...media,preview:async(...args)=>{if(fail)throw new Error('Synthetic postprocessing failure');return media.preview(...args);}}});
  const original=await makeMp4(join(c.dataDir,'input.mp4'),{duration:.3});
  const upload=await c.start(original,{retainOriginal:true});await c.wait(upload.id,'failed');
  assert.deepEqual(await readFile(join(c.dataDir,'uploads','staging',upload.id,'raw-1')),original);
  assert.equal((await c.req('GET',`/items/${upload.id}/content`,c.owner)).statusCode,404);
  await c.app.close();
  const db=new DatabaseSync(join(c.dataDir,'mirea.sqlite'));db.prepare('UPDATE upload_sessions SET expires_at=1 WHERE id=?').run(upload.id);db.close();
  c.app=await createApp(c.options);
  const failed=(await c.req('GET','/uploads',c.owner)).json().uploads;assert.equal(failed[0].sourceRetained,true);assert.equal(failed[0].retainOriginal,true);
  assert.deepEqual(await readFile(join(c.dataDir,'uploads','staging',upload.id,'raw-1')),original);
  fail=false;assert.equal((await c.req('POST',`/uploads/${upload.id}/retry`,c.owner)).statusCode,202);
  await c.wait(upload.id);
  assert.deepEqual(await readFile(join(c.dataDir,'originals',upload.id)),original);
  const output=await probeVideo(join(c.dataDir,'uploads',upload.id));assert.equal(output.audio.codec_name,'aac','silent source gets AAC without losing video');
  await c.req('DELETE',`/items/${upload.id}`,c.owner);
  await assert.rejects(stat(join(c.dataDir,'originals',upload.id)),{code:'ENOENT'});
  await assert.rejects(stat(join(c.dataDir,'videos',upload.id)),{code:'ENOENT'});
});

test('common non-MP4 containers/codecs are probed and normalized; audio-only and playlist inputs are refused without source deletion',async t=>{
  const c=await setup(t);
  const formats=[['mov','video/quicktime','prores_ks','pcm_s16le'],['mkv','video/x-matroska','ffv1','pcm_s16le'],['webm','video/webm','libvpx-vp9','libopus'],['avi','video/x-msvideo','mpeg4','libmp3lame'],['wmv','video/x-ms-wmv','wmv2','wmav2'],['mpg','video/mpeg','mpeg2video','mp2'],['ts','video/mp2t','mpeg2video','mp2'],['flv','video/x-flv','flv','libmp3lame']];
  for(const [ext,mime,v,a] of formats)await t.test(ext,async()=>{
    const path=join(c.dataDir,'source.'+ext);
    await promisify(execFile)(ffmpegPath(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=128x96:rate=25:duration=0.4','-f','lavfi','-i','sine=duration=0.4','-c:v',v,'-threads','1','-c:a',a,'-shortest',path],{windowsHide:true,timeout:15000});
    // Production staging files have no extension. Include the bounded probe
    // cause for this synthetic fixture so platform-specific demuxer failures
    // are diagnosable without exposing real uploaded media or weakening checks.
    const unlabelled=join(c.dataDir,'probe-input');await writeFile(unlabelled,await readFile(path));
    try{await probeVideo(unlabelled);}catch(error){assert.fail(`Synthetic ${ext} probe: ${error.cause?.stderr||error.cause?.message||error.message}`);}
    const upload=await c.start(await readFile(path),{mime,filename:'video.'+ext}),{item}=await c.wait(upload.id);
    const result=await probeVideo(join(c.dataDir,'uploads',item.id));assert.equal(result.video.codec_name,'h264');assert.equal(result.audio.codec_name,'aac');
  });
  const audioOnly=join(c.dataDir,'audio-only.mp4');
  await promisify(execFile)(ffmpegPath(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=duration=0.2','-c:a','aac',audioOnly],{windowsHide:true,timeout:15000});
  for(const bytes of [Buffer.from('#EXTM3U\nhttp://127.0.0.1/secret'),Buffer.from('not a video'),await readFile(audioOnly)]){
    const upload=await c.start(bytes,{mime:'video/x-matroska',filename:'fake.mkv'});await c.wait(upload.id,'failed');
    assert.deepEqual(await readFile(join(c.dataDir,'uploads','staging',upload.id,'raw-1')),bytes);
    await c.req('DELETE',`/uploads/${upload.id}`,c.owner);
    await assert.rejects(stat(join(c.dataDir,'uploads','staging',upload.id)),{code:'ENOENT'});
  }
});
