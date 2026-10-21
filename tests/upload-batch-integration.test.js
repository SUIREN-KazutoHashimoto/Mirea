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
 assert(result.rows.every(row=>row.state==='complete'),JSON.stringify(result.rows.map(r=>[r.job.title,r.state,r.error])));assert.equal(peak,3);assert.equal(saved.size,0);
 const library=(await app.inject({url:`/api/v1/shelves/${shelf}/items`,headers})).json();assert.equal(library.items.length,6);assert.deepEqual(library.items.map(i=>i.kind).sort(),['audio','image-book','pdf','pdf','pdf','video']);assert.equal(library.items.find(i=>i.kind==='image-book').pageCount,2);
 const sessions=(await app.inject({url:'/api/v1/uploads',headers})).json();assert.equal(sessions.activeCount,0);assert.equal(sessions.uploads.length,0);
});
