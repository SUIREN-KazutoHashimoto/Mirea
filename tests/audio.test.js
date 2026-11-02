import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, createDecipheriv } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, stat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { ffmpegPath, createMediaProcessor } from '../server/media.js';
import { createAudioTranscoder, probeAudio } from '../server/audio-transcode.js';
import { matchesFileType } from '../server/security.js';

const exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function makeAudio(file,{duration=1,cover}={}){
  await exec(ffmpegPath(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${duration}`,
    ...(cover?['-i',cover,'-map','0:a:0','-map','1:v:0','-c:v','copy','-disposition:v','attached_pic']:[]),
    '-threads','1','-ac','2',...(file.endsWith('.weba')?['-f','webm']:[]),file],{timeout:15000,windowsHide:true,maxBuffer:1024*1024});
  return readFile(file);
}
async function setup(t,overrides={}){
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-audio-'));
  const options={dataDir,rateLimit:false,chunkSize:65536,logger:process.env.TEST_LOG==='1',...overrides};
  const c={dataDir,options,app:await createApp(options)};
  t.after(async()=>{await c.app.close();await rm(dataDir,{recursive:true,force:true});});
  c.req=(method,url,user,payload,headers={})=>c.app.inject({method,url:'/api/v1'+url,headers:{...(user?{authorization:`Bearer ${user.token}`} : {}),...headers},...(payload===undefined?{}:{payload})});
  c.register=async name=>(await c.req('POST','/auth/register',null,{name,email:name+'@example.test',password:'audio-testing-password'})).json();
  c.owner=await c.register('owner');c.viewer=await c.register('viewer');c.outsider=await c.register('outsider');
  c.shelf=(await c.req('POST','/shelves',c.owner,{name:'Music'})).json().id;
  await c.req('POST',`/shelves/${c.shelf}/members`,c.owner,{email:c.viewer.user.email,role:'viewer'});
  c.start=async(bytes,{mime='audio/wav',filename='music.wav',retainOriginal=false}={})=>{
    const response=await c.req('POST',`/shelves/${c.shelf}/uploads`,c.owner,{title:filename,retainOriginal,files:[{filename,mime,size:bytes.length}]});
    assert.equal(response.statusCode,201,response.body);const upload=response.json();
    for(let part=0;part<Math.ceil(bytes.length/upload.chunkSize);part++){
      const chunk=bytes.subarray(part*upload.chunkSize,(part+1)*upload.chunkSize);
      const result=await c.req('PUT',`/uploads/${upload.id}/files/0/parts/${part}`,c.owner,chunk,{'content-type':'application/octet-stream','x-chunk-sha256':hash(chunk)});
      assert.equal(result.statusCode,204,result.body);
    }
    assert.equal((await c.req('POST',`/uploads/${upload.id}/complete`,c.owner)).statusCode,202);
    return upload;
  };
  c.wait=async(id,state='complete')=>{
    for(let n=0;n<1500;n++){
      const r=await c.req('GET',`/uploads/${id}`,c.owner);assert.equal(r.statusCode,200,r.body);const value=r.json();
      if(value.state!=='processing'){assert.equal(value.state,state,r.body);if(state==='complete'){for(let n=0;n<250;n++){if(!(await stat(join(c.dataDir,'uploads','staging',id)).catch(()=>null)))break;await delay(20);}}return value;}await delay(20);
    }assert.fail('Audio job timeout');
  };
  return c;
}

test('common audio containers normalize to seekable AAC/M4A and always have a real thumbnail',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'mirea-audio-formats-')),processor=createAudioTranscoder();
  t.after(async()=>{processor.close();await rm(folder,{recursive:true,force:true});});
  for(const [extension,mime] of [['mp3','audio/mpeg'],['m4a','audio/mp4'],['m4b','audio/mp4'],['aac','audio/aac'],['wav','audio/wav'],['flac','audio/flac'],['ogg','audio/ogg'],['opus','audio/ogg'],['aiff','audio/aiff'],['wma','audio/x-ms-wma'],['weba','audio/webm']]){
    const source=join(folder,'input.'+extension),bytes=await makeAudio(source);
    assert.equal(matchesFileType(mime,bytes.subarray(0,16)),true,extension);
    const output=join(folder,extension),metadata=await processor.convert(source,output,{authorize(){},report(){}});
    assert.equal(metadata.codec,'AAC-LC');assert.equal(metadata.artwork,false);
    const info=await probeAudio(join(output,'audio.m4a'));assert.equal(info.audio.codec_name,'aac');assert.ok(info.duration>.8);
    assert.equal((await sharp(join(output,'thumbnail.jpg')).metadata()).format,'jpeg');
    const canonical=await readFile(join(output,'audio.m4a'));
    assert.ok(canonical.indexOf(Buffer.from('moov'))<canonical.indexOf(Buffer.from('mdat')),'faststart '+extension);
  }
});

test('audio upload, Range streaming, resume, series, detailed logs and encrypted downloads enforce shelf ACL',async t=>{
  const c=await setup(t),original=await makeAudio(join(c.dataDir,'song.wav'),{duration:9});
  const upload=await c.start(original),{item}=await c.wait(upload.id);
  assert.equal(item.kind,'audio');assert.equal(item.mimeType,'audio/mp4');assert.match(item.filename,/\.m4a$/);
  const canonical=await readFile(join(c.dataDir,'uploads',item.id));assert.ok((await probeAudio(join(c.dataDir,'uploads',item.id))).duration>8.5);
  await assert.rejects(stat(join(c.dataDir,'originals',item.id)),{code:'ENOENT'});
  for(const dir of ['uploads/staging','uploads/transfers'])assert.ok(!(await readdir(join(c.dataDir,dir))).includes(item.id));
  const listing=await c.req('GET',`/shelves/${c.shelf}/items`,c.viewer);assert.equal(listing.statusCode,200,listing.body);assert.equal(listing.json().items[0].kind,'audio');
  const thumbnail=await c.req('GET',`/items/${item.id}/thumbnail`,c.viewer);assert.equal(thumbnail.statusCode,200);assert.equal(thumbnail.headers['content-type'],'image/webp');
  // A missing thumbnail can be repaired without needing the deleted source.
  await unlink(join(c.dataDir,'thumbnails',item.id+'.jpg'));
  assert.equal((await c.req('GET',`/items/${item.id}/thumbnail`,c.owner)).statusCode,200);
  const ticket=(await c.req('POST',`/items/${item.id}/playback-ticket`,c.viewer)).json();assert.equal(ticket.hlsUrl,undefined);
  const ranged=await c.app.inject({url:ticket.url,headers:{range:'bytes=12-63'}});
  assert.equal(ranged.statusCode,206);assert.equal(ranged.headers['content-type'],'audio/mp4');assert.deepEqual(ranged.rawPayload,canonical.subarray(12,64));
  assert.equal((await c.req('GET',`/items/${item.id}/content`,null)).statusCode,401);
  assert.equal((await c.req('GET',`/items/${item.id}/content`,c.outsider)).statusCode,404);
  const p=await c.req('PUT',`/items/${item.id}/progress`,c.viewer,{revision:0,updateId:randomUUID(),positionMs:3500,durationMs:9000});
  assert.equal(p.statusCode,200,p.body);assert.equal((await c.req('GET',`/items/${item.id}/progress`,c.viewer)).json().progress.positionMs,3500);
  assert.equal((await c.req('GET',`/items/${item.id}/progress`,c.owner)).json().progress,null);
  assert.equal((await c.req('PUT',`/items/${item.id}/progress`,c.viewer,{revision:1,updateId:randomUUID(),page:1})).statusCode,422);
  const series=await c.req('POST',`/shelves/${c.shelf}/series`,c.owner,{title:'Album'});assert.equal(series.statusCode,201,series.body);
  const s=series.json().series;const arrange=await c.req('PUT',`/series/${s.id}`,c.owner,{revision:s.revision,title:s.title,description:s.description,items:[{assetId:item.id,label:'Track 1'}]});
  assert.equal(arrange.statusCode,200,arrange.body);assert.equal((await c.req('GET',`/items/${item.id}/series`,c.viewer)).json().items[0].kind,'audio');
  const view={id:randomUUID(),assetId:item.id,context:'viewer',platform:'web',clientVersion:'test'},at=Date.now();
  const base={visible:true,focused:true,idle:false,playing:true,seeking:false,buffering:false,rate:1,durationMs:9000};
  const events=[{id:randomUUID(),seq:1,type:'view_start',at,elapsedMs:0,toMs:0,...base},
    {id:randomUUID(),seq:2,type:'interval',at:at+1000,elapsedMs:1000,intervalMs:1000,visibleMs:1000,activeMs:1000,watchMs:1000,fromMs:0,toMs:1000,...base}];
  const logged=await c.req('POST','/analytics/events',c.viewer,{view,events});assert.equal(logged.statusCode,200,logged.body);
  const summary=(await c.req('GET','/analytics/me/summary',c.viewer)).json();assert.equal(summary.assets[0].kind,'audio');assert.equal(summary.assets[0].watchMs,1000);assert.equal(summary.pages.length,0);assert.equal(summary.videoBins[0].watchMs,1000);
  assert.equal((await c.req('GET','/analytics/me/events',c.owner)).json().events.length,0);
  assert.equal((await c.req('GET',`/shelves/${c.shelf}/analytics/summary`,c.owner)).json().assets.length,0,'small audio cohorts stay suppressed');
  assert.equal((await c.req('POST','/analytics/events',c.viewer,{view:{...view,id:randomUUID(),context:'preview'},events})).statusCode,422,'no automatic sound previews');
  const download=await c.req('POST',`/items/${item.id}/download`,c.viewer);assert.equal(download.statusCode,200,download.body);
  const manifest=download.json().manifest;assert.equal(manifest.kind,'audio');assert.equal(manifest.files[0].mime,'audio/mp4');assert.equal(download.json().key,undefined);
  const opened=(await c.req('POST',`/downloads/${manifest.id}/open`,c.viewer)).json();
  const encrypted=(await c.req('GET',`/downloads/${manifest.id}/files/0/parts/0`,c.viewer)).rawPayload;
  const length=Math.min(manifest.chunkSize,canonical.length),decipher=createDecipheriv('aes-256-gcm',Buffer.from(opened.key,'base64'),encrypted.subarray(0,12));
  decipher.setAAD(Buffer.from(`mirea-download-v1|${manifest.id}|0|0|${length}`));decipher.setAuthTag(encrypted.subarray(-16));
  assert.deepEqual(Buffer.concat([decipher.update(encrypted.subarray(12,-16)),decipher.final()]),canonical.subarray(0,length));assert.notDeepEqual(encrypted.subarray(0,length),canonical.subarray(0,length));
  await c.req('DELETE',`/shelves/${c.shelf}/members/${c.viewer.user.id}`,c.owner);
  assert.equal((await c.app.inject(ticket.url)).statusCode,404);assert.equal((await c.req('POST',`/downloads/${manifest.id}/open`,c.viewer)).statusCode,404);
  assert.equal((await c.req('DELETE',`/items/${item.id}`,c.owner)).statusCode,204);
  await assert.rejects(stat(join(c.dataDir,'uploads',item.id)),{code:'ENOENT'});
});

test('embedded cover and explicit original retention survive normalization, and deletion removes both',async t=>{
  const c=await setup(t),cover=join(c.dataDir,'cover.jpg');await sharp({create:{width:220,height:220,channels:3,background:'#fb4218'}}).jpeg().toFile(cover);
  const original=await makeAudio(join(c.dataDir,'covered.mp3'),{cover});
  const {item}=await c.wait((await c.start(original,{mime:'audio/mpeg',filename:'covered.mp3',retainOriginal:true})).id);
  assert.deepEqual(await readFile(join(c.dataDir,'originals',item.id)),original);
  const image=await sharp(join(c.dataDir,'thumbnails',item.id+'.jpg')).resize(1,1).raw().toBuffer();assert.ok(image[0]>200&&image[1]<100);
  const db=new DatabaseSync(join(c.dataDir,'mirea.sqlite'));const row=db.prepare('SELECT * FROM audio_assets WHERE item_id=?').get(item.id);assert.equal(row.original_retained,1);assert.equal(JSON.parse(row.metadata_json).artwork,true);db.close();
  assert.equal((await c.req('DELETE',`/items/${item.id}`,c.owner)).statusCode,204);await assert.rejects(stat(join(c.dataDir,'originals',item.id)),{code:'ENOENT'});
});

test('failed processing retains complete sources indefinitely, permits retry, and only removes them after success',async t=>{
  const media=createMediaProcessor();let fail=true;
  const c=await setup(t,{mediaProcessor:{...media,validateImage:async(...args)=>{if(fail)throw Error('Injected cover verification failure');return media.validateImage(...args);}}});
  const original=await makeAudio(join(c.dataDir,'retry.wav'));
  const upload=await c.start(original),failed=await c.wait(upload.id,'failed');assert.equal(failed.sourceRetained,true);
  assert.deepEqual(await readFile(join(c.dataDir,'originals',upload.id)),original);
  assert.equal(failed.item.originalPlayback,false,'encoding can finish even if artwork fails');
  await c.app.close();const db=new DatabaseSync(join(c.dataDir,'mirea.sqlite'));db.prepare('UPDATE upload_sessions SET expires_at=1 WHERE id=?').run(upload.id);db.close();
  fail=false;c.app=await createApp({...c.options,mediaProcessor:media});
  assert.equal((await c.req('GET',`/uploads/${upload.id}`,c.owner)).json().sourceRetained,true);
  assert.equal((await c.req('POST',`/uploads/${upload.id}/retry`,c.owner)).statusCode,202);
  const retried=await c.wait(upload.id);assert.equal(retried.item.id,upload.id);
  await assert.rejects(stat(join(c.dataDir,'uploads','staging',upload.id)),{code:'ENOENT'});
});

test('audio job shutdown is durable and startup resumes, while the immutable original is already published',async t=>{
  let entered,rejectJob;const started=new Promise(resolve=>{entered=resolve;});
  const audioTranscoder={convert(){entered();return new Promise((_resolve,reject)=>{rejectJob=reject;});},close(){rejectJob?.(Object.assign(Error('Shutdown'),{code:'SERVER_CLOSING'}));}};
  const c=await setup(t,{audioTranscoder}),original=await makeAudio(join(c.dataDir,'restart.wav'));
  const upload=await c.start(original);await started;await c.app.close();
  const db=new DatabaseSync(join(c.dataDir,'mirea.sqlite'));assert.equal(db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(upload.id).state,'processing');assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n,1);assert.equal(db.prepare('SELECT canonical_ready FROM media_ingest WHERE asset_id=?').get(upload.id).canonical_ready,0);db.close();
  c.app=await createApp({...c.options,audioTranscoder:undefined});assert.equal((await c.wait(upload.id)).item.kind,'audio');
});

test('multipart compatibility uploads use the same normalization; malformed and mixed audio uploads are rejected',async t=>{
  const c=await setup(t),bytes=await makeAudio(join(c.dataDir,'multipart.wav'));
  const boundary='mirea-audio-boundary',payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nMusic\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="music.wav"\r\nContent-Type: audio/x-wav\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const result=await c.req('POST',`/shelves/${c.shelf}/items`,c.owner,payload,{'content-type':`multipart/form-data; boundary=${boundary}`});
  assert.equal(result.statusCode,201,result.body);assert.equal(result.json().item.kind,'audio');
  const bad=await c.start(Buffer.from('not audio'),{mime:'audio/mpeg',filename:'bad.mp3'});assert.equal((await c.wait(bad.id,'failed')).sourceRetained,true);
  const mixed=await c.req('POST',`/shelves/${c.shelf}/uploads`,c.owner,{title:'Mixed',files:[{filename:'a.mp3',mime:'audio/mpeg',size:100},{filename:'b.mp3',mime:'audio/mpeg',size:100}]});assert.equal(mixed.statusCode,400);
  const noAccess=await c.req('POST',`/shelves/${c.shelf}/uploads`,c.viewer,{title:'No',files:[{filename:'a.wav',mime:'audio/wav',size:bytes.length}]});assert.equal(noAccess.statusCode,403);
});

test('audio probes reject video/playlist inputs; disabling the uploader stops encoding and preserves the published original',async t=>{
  const media=createMediaProcessor();let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const c=await setup(t,{mediaProcessor:{...media,validateImage:async(...args)=>{entered();await gate;return media.validateImage(...args);}}});
  const list=join(c.dataDir,'remote.m3u8');await writeFile(list,'#EXTM3U\n#EXTINF:1,\nhttps://example.test/private.aac\n');await assert.rejects(probeAudio(list),{statusCode:422});
  const video=join(c.dataDir,'video.mp4');await exec(ffmpegPath(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=s=32x32:d=1','-f','lavfi','-i','sine=duration=1','-threads','1','-c:v','libx264','-c:a','aac','-shortest',video],{timeout:15000,windowsHide:true});await assert.rejects(probeAudio(video),{statusCode:422});
  const original=await makeAudio(join(c.dataDir,'revoked.wav')),upload=await c.start(original);await started;
  const control=new DatabaseSync(join(c.dataDir,'mirea.sqlite'));control.prepare("INSERT INTO user_access VALUES(?,'user',1)").run(c.owner.user.id);control.close();release();
  for(let n=0;n<250;n++){
    const db=new DatabaseSync(join(c.dataDir,'mirea.sqlite')),row=db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(upload.id),items=db.prepare('SELECT COUNT(*) n FROM items').get().n;db.close();
    if(row.state==='failed'){assert.equal(items,1);break;}if(n===249)assert.fail('Revoked job did not stop');await delay(20);
  }
  assert.deepEqual(await readFile(join(c.dataDir,'originals',upload.id)),original);
  await assert.rejects(stat(join(c.dataDir,'uploads',upload.id)),{code:'ENOENT'});
});
