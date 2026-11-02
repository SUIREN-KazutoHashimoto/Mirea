import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import sharp from 'sharp';
import {createApp} from '../server/app.js';
import {ffmpegPath} from '../server/media.js';
import {makePdf,makeMp4} from './fixtures.js';
import {planUploads,createUploadBatch} from '../web/src/upload-batch.js';
import {createResumableUpload} from '../web/src/resumable-upload.js';
import {folderUploadJobs,prepareFolderSeries} from '../web/src/folder-upload.js';
import {createMediaProcessor} from '../server/media.js';
import {setTimeout as delay} from 'node:timers/promises';

test('folder import publishes real PDFs and individual images into the correct nested series through concurrent chunked transfers',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'mirea-folder-integration-')),app=await createApp({dataDir,rateLimit:false,chunkSize:512}),endpoint=await app.listen({host:'127.0.0.1',port:0});
 const before=Object.fromEntries(['localStorage','XMLHttpRequest'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)])),saved=new Map();
 t.after(async()=>{for(const[k,d]of Object.entries(before)){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}await app.close();assert(resolve(dataDir).startsWith(resolve(tmpdir())+sep+'mirea-folder-integration-'));await rm(dataDir,{recursive:true,force:true});});
 const owner=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Folder QA',email:'folders@example.test',password:'isolated-folder-password'}})).json(),headers={authorization:'Bearer '+owner.token};
 const api=async(path,options={})=>{const r=await app.inject({method:options.method??'GET',url:'/api/v1'+path,headers,...(options.body?{payload:options.body}:{})});assert(r.statusCode<300,r.body);return r.statusCode===204?null:r.json();};
 const shelf=(await api('/shelves',{method:'POST',body:{name:'Folders'}})).id;
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
 Object.defineProperty(globalThis,'XMLHttpRequest',{configurable:true,value:class{
   upload={};headers={};controller=new AbortController();open(method,url){this.method=method;this.url=url;}setRequestHeader(k,v){this.headers[k]=v;}abort(){this.controller.abort();this.onabort?.();}
   async send(body){try{const r=await fetch(this.url,{method:this.method,headers:this.headers,body,signal:this.controller.signal});this.status=r.status;this.responseText=await r.text();this.onload();}catch{this.onerror();}}
 }});
 const image=await sharp({create:{width:32,height:32,channels:3,background:'#456789'}}).png().toBuffer();
 const files=[['Folder/Part 1/book.pdf',makePdf()],['Folder/Part 2/book.pdf',makePdf()],['Folder/Part 1/cover.png',image]].map(([path,bytes])=>{const f=new File([bytes],path.split('/').at(-1),{lastModified:1});Object.defineProperty(f,'webkitRelativePath',{value:path});return f;});
 const jobs=folderUploadJobs(files,planUploads),targets=await prepareFolderSeries(jobs,{api,shelfId:shelf});
 const identity={endpoint,token:owner.token,userId:owner.user.id,unauthorized:()=>assert.fail('Unexpected auth failure')};
 const result=await createUploadBatch(jobs,{start:(j,p)=>createResumableUpload(identity,shelf,j.files,j.title,p,{seriesId:targets.get(j.key)})}).promise;
 assert(result.rows.every(r=>r.state==='complete'),JSON.stringify(result.rows.map(r=>[r.job.relativePath,r.error])));
 const catalog=await api('/library/catalog');assert.equal(catalog.series.length,3);assert.equal(catalog.items.length,3);assert.equal(catalog.items.filter(i=>i.kind==='image-book')[0].pageCount,1);
 const root=catalog.series.find(s=>s.title==='Folder');assert.equal(root.assetCount,3);assert.equal(root.childCount,2);
 for(const j of jobs)assert.equal(catalog.items.find(i=>i.title===j.title&&i.series.id===targets.get(j.key))?.series.id,targets.get(j.key));
 assert.equal((await api('/uploads')).activeCount,0);assert.equal(saved.size,0);
});

test('six mixed assets publish through real concurrent resumable transfers without exceeding server slots or mixing image-book pages',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'mirea-batch-integration-')),app=await createApp({dataDir,rateLimit:false,chunkSize:512}),endpoint=await app.listen({host:'127.0.0.1',port:0});
 const before=Object.fromEntries(['localStorage','XMLHttpRequest'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),saved=new Map();let peak=0;
 t.after(async()=>{for(const[key,descriptor]of Object.entries(before)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}await app.close();assert(resolve(dataDir).startsWith(resolve(tmpdir())+sep+'mirea-batch-integration-'));await rm(dataDir,{recursive:true,force:true});});
 const owner=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Batch QA',email:'batch@example.test',password:'isolated-batch-password'}})).json(),headers={authorization:'Bearer '+owner.token};
 const shelf=(await app.inject({method:'POST',url:'/api/v1/shelves',headers,payload:{name:'Batch QA'}})).json().id;
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
 Object.defineProperty(globalThis,'XMLHttpRequest',{configurable:true,value:class{
   upload={};headers={};controller=new AbortController();open(method,url){this.method=method;this.url=url;}setRequestHeader(k,v){this.headers[k]=v;}abort(){this.controller.abort();this.onabort?.();}
   async send(body){try{const current=(await app.inject({url:'/api/v1/uploads',headers})).json();peak=Math.max(peak,current.activeCount);const r=await fetch(this.url,{method:this.method,headers:this.headers,body,signal:this.controller.signal});this.status=r.status;this.responseText=await r.text();this.upload.onprogress?.({lengthComputable:true,loaded:body.size});this.onload();}catch{if(!this.controller.signal.aborted)this.onerror();}}
 }});
 const video=await makeMp4(join(dataDir,'fixture.mp4'));
 execFileSync(ffmpegPath(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=220:duration=0.3','-c:a','aac',join(dataDir,'fixture.m4a')],{windowsHide:true,timeout:15000});
 const image=await sharp({create:{width:64,height:64,channels:3,background:'#4a66d9'}}).png().toBuffer(),blob=(bytes,name)=>new File([bytes],name,{lastModified:1});
 const jobs=planUploads([blob(makePdf(),'first.pdf'),blob(video,'movie.mp4'),blob(await readFile(join(dataDir,'fixture.m4a')),'song.m4a'),blob(image,'10.png'),blob(image,'2.png'),blob(makePdf(),'second.pdf'),blob(makePdf(),'third.pdf')]);assert.equal(jobs.length,6);
 const identity={endpoint,token:owner.token,userId:owner.user.id,unauthorized:()=>assert.fail('Unexpected authentication failure')};
 const result=await createUploadBatch(jobs,{start:(job,progress)=>createResumableUpload(identity,shelf,job.files,job.title,progress)}).promise;
 assert(result.rows.every(row=>row.state==='complete'),JSON.stringify(result.rows.map(r=>[r.job.title,r.state,r.error])));assert.ok(peak>=3&&peak<=8);assert.equal(saved.size,0);
 const library=(await app.inject({url:`/api/v1/shelves/${shelf}/items`,headers})).json();assert.equal(library.items.length,6);assert.deepEqual(library.items.map(i=>i.kind).sort(),['audio','image-book','pdf','pdf','pdf','video']);assert.equal(library.items.find(i=>i.kind==='image-book').pageCount,2);
 const sessions=(await app.inject({url:'/api/v1/uploads',headers})).json();assert.equal(sessions.activeCount,0);assert.equal(sessions.uploads.length,0);
});
test('protocol v2 drains transfers while converters are blocked, reserves series placement and resumes a lost creation response',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'mirea-accepted-018-')),media=createMediaProcessor();let release,entered=0;const gate=new Promise(resolve=>{release=resolve;});
 const app=await createApp({dataDir,rateLimit:false,chunkSize:256,mediaProcessor:{...media,thumbnail:async(...args)=>{entered++;await gate;return media.thumbnail(...args);}}}),endpoint=await app.listen({host:'127.0.0.1',port:0});
 const before=Object.fromEntries(['localStorage','XMLHttpRequest'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)])),saved=new Map();
 t.after(async()=>{release();for(const[k,d]of Object.entries(before)){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}await app.close();assert(resolve(dataDir).startsWith(resolve(tmpdir())+sep+'mirea-accepted-018-'));await rm(dataDir,{recursive:true,force:true});});
 const user=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Synthetic transfer',email:'accepted@example.invalid',password:'isolated-transfer-test-password'}})).json(),headers={authorization:'Bearer '+user.token};
 const api=async(path,method='GET',payload)=>{const r=await app.inject({method,url:'/api/v1'+path,headers,payload});assert(r.statusCode<300,r.body);return r.statusCode===204?null:r.json();};
 const shelf=(await api('/shelves','POST',{name:'Transfer test'})).id,series=(await api('/shelves/'+shelf+'/series','POST',{title:'Pending destination'})).series;
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}});
 let parallel=0,peak=0;Object.defineProperty(globalThis,'XMLHttpRequest',{configurable:true,value:class{upload={};headers={};controller=new AbortController();open(method,url){this.method=method;this.url=url;}setRequestHeader(k,v){this.headers[k]=v;}abort(){this.controller.abort();this.onabort?.();}async send(body){peak=Math.max(peak,++parallel);try{const r=await fetch(this.url,{method:this.method,headers:this.headers,body,signal:this.controller.signal});this.status=r.status;this.responseText=await r.text();this.onload();}catch{this.onerror();}finally{parallel--;}}}});
 const files=Array.from({length:8},(_,n)=>new File([makePdf(),Buffer.alloc(2048,32)],'book-'+n+'.pdf',{type:'application/pdf'})),jobs=planUploads(files),identity={endpoint,token:user.token,userId:user.user.id,unauthorized:()=>assert.fail('Unexpected auth failure')};
 const batch=createUploadBatch(jobs,{concurrency:3,start:(j,p)=>createResumableUpload(identity,shelf,j.files,j.title,p,{seriesId:series.id,protocolVersion:2,monitorProcessing:false})});const sent=await batch.transferred;await batch.promise;
 assert(sent.rows.every(r=>r.state==='processing'),JSON.stringify(sent.rows.map(r=>[r.state,r.error])));assert(peak>3&&peak<=12,'bounded parallel chunks, not serial request round trips');
 const pending=(await api('/shelves/'+shelf+'/items')).pendingUploads;assert.equal(pending.length,8);assert(pending.every(r=>r.series.id===series.id));assert.equal((await api('/uploads')).activeCount,8,'processing is durable but no longer consumes transfer admission');
 // Losing browser resume metadata does not allocate a duplicate session.
 const candidate=await api('/shelves/'+shelf+'/uploads','POST',{resume:true,title:jobs[0].title,seriesId:series.id,files:[{filename:files[0].name,mime:'application/pdf',size:files[0].size}]});assert.equal(candidate.id,sent.rows[0].uploadId);assert.equal(candidate.state,'processing');
 const statuses=await api('/uploads/status','POST',{ids:sent.rows.map(r=>r.uploadId)});assert.equal(statuses.uploads.length,8);assert(statuses.uploads.every(r=>r.files===undefined));
 const many=await api('/shelves/'+shelf+'/uploads','POST',{title:'1000 image metadata',files:Array.from({length:1000},(_,n)=>({filename:'画'.repeat(245)+n+'.png',mime:'image/png',size:1}))});assert.equal(many.files.length,1000,'valid UTF-8 metadata must fit the request body limit');await api('/uploads/'+many.id,'DELETE');
 release();for(let n=0;n<1000;n++){const rows=(await api('/uploads/status','POST',{ids:sent.rows.map(r=>r.uploadId)})).uploads;if(rows.every(r=>r.state==='complete'))break;assert(!rows.some(r=>r.state==='failed'),JSON.stringify(rows.map(r=>r.error)));await delay(25);}
 const catalog=await api('/library/catalog');assert.equal(catalog.items.length,8);assert(catalog.items.every(i=>i.series.id===series.id));assert.equal(entered,8);
});
