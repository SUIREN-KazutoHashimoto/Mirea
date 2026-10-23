// CI-only black-box check; never run against production DATA_DIR.
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,createDecipheriv,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import pkg from '../package.json' with {type:'json'};
if(process.env.GITHUB_ACTIONS!=='true'||!/^mirea-ci-\d+-\d+$/.test(process.env.COMPOSE_PROJECT_NAME??''))throw Error('An isolated GitHub CI project is required');
const mode=process.argv[2],base='http://127.0.0.1:3000',statePath=resolve(process.env.RUNNER_TEMP??'',process.env.COMPOSE_PROJECT_NAME+'.json');
if(!statePath.startsWith(resolve(process.env.RUNNER_TEMP)+sep))throw Error('Unsafe fixture state path');
const hash=b=>createHash('sha256').update(b).digest('hex');
const request=async(path,{token,body,method='GET',headers={}}={})=>fetch(base+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
const json=async(path,options)=>{const r=await request('/api/v1'+path,options);assert(r.ok,'HTTP '+r.status+' '+path);return r.status===204?null:r.json();};
function pdf(){const content='BT /F1 18 Tf 30 200 Td (Mirea container persistence) Tj ET',objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];let text='%PDF-1.4\n';const positions=[];objects.forEach((v,i)=>{positions.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${v}\nendobj\n`;});const xref=Buffer.byteLength(text);return Buffer.from(text+`xref\n0 6\n0000000000 65535 f \n`+positions.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);}
const bytes=pdf();
if(mode==='prepare'){
 const id=execFileSync('docker',['compose','ps','-q','mirea'],{encoding:'utf8'}).trim();assert(id);
 const [c]=JSON.parse(execFileSync('docker',['inspect',id],{encoding:'utf8'}));assert.equal(c.Config.Labels['com.docker.compose.project'],process.env.COMPOSE_PROJECT_NAME);assert.equal(c.Config.User,'1000:1000');assert.equal(c.HostConfig.Privileged,false);assert.equal(c.HostConfig.ReadonlyRootfs,true);assert(c.HostConfig.CapDrop.includes('ALL'));assert(c.HostConfig.SecurityOpt.some(v=>v.startsWith('no-new-privileges')));assert(!c.Mounts.some(v=>v.Destination.includes('docker.sock')));
 assert.equal((await(await request('/api/health')).json()).version,pkg.version);
 const session=await json('/auth/register',{method:'POST',body:{name:'Isolated container test',email:randomUUID()+'@example.invalid',password:randomUUID()+'-fixture-only'}}),token=session.token;
 const shelf=await json('/shelves',{token,method:'POST',body:{name:'Persistent CI shelf'}}),parent=(await json('/shelves/'+shelf.id+'/series',{token,method:'POST',body:{title:'Parent'}})).series,child=(await json('/shelves/'+shelf.id+'/series',{token,method:'POST',body:{title:'Child',parentId:parent.id}})).series;
 const upload=await json('/shelves/'+shelf.id+'/uploads',{token,method:'POST',body:{title:'Persistent PDF',seriesId:child.id,files:[{filename:'fixture.pdf',mime:'application/pdf',size:bytes.length}]}});
 const part=await fetch(base+`/api/v1/uploads/${upload.id}/files/0/parts/0`,{method:'PUT',headers:{authorization:'Bearer '+token,'content-type':'application/octet-stream','x-chunk-sha256':hash(bytes)},body:bytes,signal:AbortSignal.timeout(15000)});assert.equal(part.status,204);
 await json('/uploads/'+upload.id+'/complete',{token,method:'POST'});let status;
 for(let n=0;n<300;n++){status=await json('/uploads/'+upload.id,{token});if(status.state!=='processing')break;await new Promise(r=>setTimeout(r,100));}assert.equal(status.state,'complete');
 const cover=await request(status.item.thumbnailUrl,{token});assert.equal(cover.status,200);assert.equal(cover.headers.get('content-type'),'image/jpeg');assert((await cover.arrayBuffer()).byteLength>100);
 const p=await json('/items/'+upload.id+'/progress',{token});await json('/items/'+upload.id+'/progress',{token,method:'PUT',body:{revision:p.revision,updateId:randomUUID(),page:1,scrollX:0,scrollY:.5,zoom:'fit'}});
 const download=(await json('/items/'+upload.id+'/download',{token,method:'POST'})).manifest.id;
 await writeFile(statePath,JSON.stringify({token,userId:session.user.id,shelf:shelf.id,parent:parent.id,child:child.id,item:upload.id,download,sha256:hash(bytes)}),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({success:true,isolatedData:true,nonRoot:true,readOnlyRoot:true,privileged:false,pdfUpload:true,thumbnail:true,seriesAssignment:true,encryptedDownloadRegistered:true}));
}else if(mode==='verify'){
 const s=JSON.parse(await readFile(statePath,'utf8')),token=s.token;assert.equal((await json('/auth/me',{token})).user.id,s.userId);
 const catalog=await json('/library/catalog',{token});assert.equal(catalog.userId,s.userId);assert(catalog.shelves.some(v=>v.id===s.shelf));assert(catalog.series.some(v=>v.id===s.child&&v.parentId===s.parent));assert(catalog.items.some(v=>v.id===s.item&&v.series.id===s.child));assert.equal((await json('/items/'+s.item+'/progress',{token})).progress.scrollY,.5);
 const content=await request('/api/v1/items/'+s.item+'/content',{token});assert.equal(hash(Buffer.from(await content.arrayBuffer())),s.sha256);
 const range=await request('/api/v1/items/'+s.item+'/content',{token,headers:{range:'bytes=5-20'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(5,21));
 const grant=await json('/downloads/'+s.download+'/open',{token,method:'POST',body:{}});assert.equal(grant.userId,s.userId);assert.equal(grant.expiresAt-grant.serverTime,7*86400000);
 const response=await request('/api/v1/downloads/'+s.download+'/files/0/parts/0',{token});assert.equal(response.status,200);const encrypted=Buffer.from(await response.arrayBuffer());assert.equal(hash(encrypted),response.headers.get('x-chunk-sha256'));
 const decipher=createDecipheriv('aes-256-gcm',Buffer.from(grant.key,'base64'),encrypted.subarray(0,12));decipher.setAAD(Buffer.from(`mirea-download-v1|${s.download}|0|0|${bytes.length}`));decipher.setAuthTag(encrypted.subarray(-16));assert.deepEqual(Buffer.concat([decipher.update(encrypted.subarray(12,-16)),decipher.final()]),bytes);grant.key='';
 assert.equal((await request('/api/v1/library/catalog')).status,401);await unlink(statePath);console.log(JSON.stringify({success:true,containerRecreated:true,accountAndSessionPersisted:true,metadataAndNestedSeries:true,progressPersisted:true,originalBytesPreserved:true,range:true,downloadMasterKeyPreserved:true,sevenDayLease:true,unauthenticatedDenied:true}));
}else throw Error('Expected prepare or verify');
