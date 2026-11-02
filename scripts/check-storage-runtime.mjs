// Synthetic fixture only. Also run on stdin inside the read-only image.
import {mkdtemp,mkdir,readFile,writeFile,lstat,stat,readdir,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash,createDecipheriv} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

export async function verifySeparateStorage(){
 const module=p=>import(pathToFileURL(join(process.cwd(),p))),{createApp}=await module('server/app.js'),{ffmpegPath}=await module('server/media.js'),{decryptBackup}=await module('server/backup-archive.js'),{default:sharp}=await import('sharp');
 // The container's /tmp is deliberately capped at 64 MiB. Backups enforce a
 // real free-space reserve, so place CI-only synthetic state on the data volume.
 const fixtureRoot=process.env.MIREA_STORAGE_FIXTURE_ROOT||tmpdir();
 const folder=await mkdtemp(join(fixtureRoot,'mirea-storage-smoke-')),dataDir=join(folder,'state');await mkdir(dataDir);
 // The container uses its allowed /tmp tmpfs; direct Linux tests retain the
 // real /dev/shm boundary. This selects a fixture, never a service write grant.
 const mediaFixtureRoot=process.env.MIREA_STORAGE_MEDIA_FIXTURE_ROOT||'/dev/shm';
 if(process.platform==='linux')assert(['/tmp','/dev/shm'].includes(mediaFixtureRoot),'Unexpected media fixture root');
 const shared=process.platform==='linux'?await mkdtemp(join(mediaFixtureRoot,'mirea-storage-media-')):join(folder,'media');if(process.platform!=='linux')await mkdir(shared);
 const options={dataDir,mediaDir:shared,rateLimit:false,cleanupGraceMs:0,serverAdminUserIds:[],backupConfigFile:join(folder,'fixture.env')},password=randomUUID()+'-fixture';await writeFile(options.backupConfigFile,'MIREA_STORAGE_FIXTURE=true\n');let app;
 const hash=b=>createHash('sha256').update(b).digest('hex');
 try{
  const crossDevice=(await stat(dataDir)).dev!==(await stat(shared)).dev;if(process.env.MIREA_EXPECT_CROSS_DEVICE==='1')assert(crossDevice,'A real EXDEV boundary is required');
  app=await createApp(options);const req=(method,path,body,headers={})=>app.inject({method,url:'/api/v1'+path,headers:{...(token?{authorization:'Bearer '+token}:{}),...headers},...(body!==undefined?{payload:body}:{})});let token;
  const account=(await req('POST','/auth/register',{name:'Storage fixture',email:randomUUID()+'@example.invalid',password})).json();token=account.token;options.serverAdminUserIds.push(account.user.id);assert(token);
  const shelf=(await req('POST','/shelves',{name:'Separated fixture'})).json().id;
  const pdfText='BT /F1 20 Tf 30 180 Td (Separated storage) Tj ET',objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${pdfText.length} >>\nstream\n${pdfText}\nendstream`];let pdf='%PDF-1.4\n';const offsets=[];objects.forEach((v,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${v}\nendobj\n`;});const xref=Buffer.byteLength(pdf);const pdfBytes=Buffer.from(pdf+`xref\n0 6\n0000000000 65535 f \n`+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  async function upload(title,files){
   let r=await req('POST',`/shelves/${shelf}/uploads`,{title,retainOriginal:true,files:files.map(f=>({filename:f.name,mime:f.mime,size:f.bytes.length}))});assert.equal(r.statusCode,201,r.body);const u=r.json();
   for(const [index,file]of files.entries())for(let n=0;n<Math.ceil(file.bytes.length/u.chunkSize);n++){const bytes=file.bytes.subarray(n*u.chunkSize,(n+1)*u.chunkSize);r=await req('PUT',`/uploads/${u.id}/files/${index}/parts/${n}`,bytes,{'content-type':'application/octet-stream','x-chunk-sha256':hash(bytes)});assert.equal(r.statusCode,204,r.body);}
   assert.equal((await req('POST','/uploads/'+u.id+'/complete')).statusCode,202);for(let n=0;n<600;n++){r=await req('GET','/uploads/'+u.id);if(r.json().state!=='processing')break;await new Promise(r=>setTimeout(r,50));}assert.equal(r.json().state,'complete',r.body);return u.id;
  }
  const pdfId=await upload('PDF',[{name:'fixture.pdf',mime:'application/pdf',bytes:pdfBytes}]);
  const png=await sharp({create:{width:100,height:160,channels:3,background:'#334488'}}).png().toBuffer(),imageId=await upload('Images',[1,2].map(n=>({name:n+'.png',mime:'image/png',bytes:png})));
  const audioSource=join(folder,'fixture.wav'),videoSource=join(folder,'fixture.mp4');execFileSync(ffmpegPath(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=duration=0.4','-threads','1',audioSource],{windowsHide:true,timeout:15000});execFileSync(ffmpegPath(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=128x96:rate=25:duration=0.4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',videoSource],{windowsHide:true,timeout:15000});
  const audioId=await upload('Audio',[{name:'fixture.wav',mime:'audio/wav',bytes:await readFile(audioSource)}]),videoId=await upload('Video',[{name:'fixture.mp4',mime:'video/mp4',bytes:await readFile(videoSource)}]);
  for(const id of [pdfId,imageId,audioId,videoId]){assert.equal((await req('GET','/items/'+id+'/thumbnail')).statusCode,200);await access(join(dataDir,'thumbnails',id+'.jpg'));}
  await assert.rejects(access(join(dataDir,'uploads')),{code:'ENOENT'});await assert.rejects(access(join(shared,'mirea.sqlite')),{code:'ENOENT'});await assert.rejects(access(join(shared,'keys')),{code:'ENOENT'});assert.deepEqual(await readFile(join(shared,'uploads',pdfId)),pdfBytes);await access(join(shared,'uploads','books',imageId,'1.png'));await access(join(shared,'originals',audioId));await access(join(dataDir,'previews',videoId+'.mp4'));
  const progress=(await req('GET','/items/'+pdfId+'/progress')).json();assert.equal((await req('PUT','/items/'+pdfId+'/progress',{revision:progress.revision,updateId:randomUUID(),page:1,scrollX:0,scrollY:.5,zoom:'fit'})).statusCode,200);
  const download=(await req('POST','/items/'+pdfId+'/download')).json().manifest.id,key=await readFile(join(dataDir,'keys','download-master.key'));
  async function job(id){for(let n=0;n<600;n++){const r=(await req('GET','/admin/jobs')).json().jobs.find(j=>j.id===id);if(['complete','failed'].includes(r?.state)){assert.equal(r.state,'complete',r.error);return;}await new Promise(r=>setTimeout(r,50));}throw Error('Storage job timeout');}
  for(const kind of ['transcode','thumbnail','preview']){const r=await req('POST','/admin/assets/'+videoId+'/regenerate',{kind,acknowledgeCost:true});assert.equal(r.statusCode,202,r.body);await job(r.json().job.id);}
  const custom=await req('POST','/thumbnails/custom',{assetIds:[pdfId,imageId],image:{mime:'image/png',base64:png.toString('base64')}});assert.equal(custom.statusCode,200,custom.body);
  for(const mode of ['metadata','full']){
   const r=await req('POST','/admin/backups',{currentPassword:password,mode,backupPassword:'separate-storage-backup',acknowledgeSensitive:true});assert.equal(r.statusCode,202,r.body);await job(r.json().id);const archive=join(dataDir,'admin-backups',r.json().id+'.mireabackup'),tar=join(folder,mode+'.tar.gz');await decryptBackup(archive,tar,'separate-storage-backup');const names=execFileSync(process.platform==='win32'?'C:/Windows/System32/tar.exe':'tar',['-tf',tar],{encoding:'utf8',windowsHide:true});assert(names.includes('data/mirea.sqlite')&&names.includes('data/keys/download-master.key'));assert.equal(names.includes('data/uploads/'+pdfId),mode==='full');assert.equal(names.includes('data/thumbnails/'+videoId+'.jpg'),mode==='full');
  }
  const orphan=randomUUID();await writeFile(join(shared,'uploads',orphan),'fixture orphan');const scan=(await req('POST','/admin/cleanup/scan')).json(),candidate=scan.candidates.find(c=>c.assetId===orphan);assert(candidate);assert(!scan.candidates.some(c=>[pdfId,imageId,videoId,audioId].includes(c.assetId)));const removed=await req('POST','/admin/cleanup/delete',{currentPassword:password,scanId:scan.scanId,ids:[candidate.id],confirmDelete:'DELETE',acknowledgeUnrecoverable:true});assert.equal(removed.statusCode,200,removed.body);assert(removed.json().results[0].deleted);await assert.rejects(access(join(shared,'uploads',orphan)),{code:'ENOENT'});
  assert.equal((await req('GET','/admin/updates/status')).json().enabled,false);
  await app.close();app=await createApp(options);assert.equal((await req('GET','/auth/me')).json().user.id,account.user.id);assert.equal((await req('GET','/items/'+pdfId+'/progress')).json().progress.scrollY,.5);assert.deepEqual(await readFile(join(dataDir,'keys','download-master.key')),key);
  const grant=(await req('POST','/downloads/'+download+'/open',{})).json();assert.equal(grant.expiresAt-grant.serverTime,7*86400000);const encrypted=(await req('GET','/downloads/'+download+'/files/0/parts/0')).rawPayload,decipher=createDecipheriv('aes-256-gcm',Buffer.from(grant.key,'base64'),encrypted.subarray(0,12));decipher.setAAD(Buffer.from(`mirea-download-v1|${download}|0|0|${pdfBytes.length}`));decipher.setAuthTag(encrypted.subarray(-16));assert.deepEqual(Buffer.concat([decipher.update(encrypted.subarray(12,-16)),decipher.final()]),pdfBytes);grant.key='';
  for(const id of [pdfId,imageId,audioId,videoId])assert.equal((await req('DELETE','/items/'+id)).statusCode,204);await assert.rejects(access(join(shared,'uploads',videoId)),{code:'ENOENT'});await assert.rejects(access(join(dataDir,'thumbnails',videoId+'.jpg')),{code:'ENOENT'});await assert.rejects(access(join(shared,'videos',videoId)),{code:'ENOENT'});
  return {success:true,isolatedData:true,productionDataTouched:false,separateRoots:true,realCrossDevice:crossDevice,pdfAndImageBooks:true,audioAndVideo:true,regeneration:true,customThumbnails:true,metadataAndFullBackup:true,orphanCleanup:true,accountProgressAndKeysPersisted:true,encryptedDownloadAfterRestart:true,deleteBothRoots:true,unsafeUpdaterDisabled:true};
 }finally{await app?.close();if(!resolve(folder).startsWith(resolve(fixtureRoot)+sep+'mirea-storage-smoke-'))throw Error('Unsafe fixture cleanup');await rm(folder,{recursive:true,force:true});if(process.platform==='linux'){if(!resolve(shared).startsWith(resolve(mediaFixtureRoot)+sep+'mirea-storage-media-'))throw Error('Unsafe shared fixture cleanup');await rm(shared,{recursive:true,force:true});}}
}
if(process.argv[1]?.endsWith('check-storage-runtime.mjs')||!process.argv[1])console.log(JSON.stringify(await verifySeparateStorage()));
