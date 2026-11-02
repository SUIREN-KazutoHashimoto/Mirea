import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import sharp from 'sharp';
import {createMediaProcessor,IMAGE_BOOK_MIME} from '../server/media.js';
import {registerImageDisplays,pageDisplayInfo} from '../server/page-display.js';
import {createMaintenanceGate} from '../server/maintenance-gate.js';
import {setTimeout as delay} from 'node:timers/promises';

test('large book display is bounded, oriented, reusable and never replaces original or bypasses access',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mirea-page-display-')),id=randomUUID(),root=join(directory,id),app=Fastify();let alive=true,calls=0;
 try{
  await mkdir(root);const original=await sharp({create:{width:5200,height:8000,channels:3,background:'#789abc'}}).withMetadata({orientation:6}).jpeg().toBuffer(),source=join(root,'1.jpg');await writeFile(source,original);
  const page={page_number:1,width:8000,height:5200,mime_type:'image/jpeg'},processor=createMediaProcessor();
  registerImageDisplays(app,{booksDir:directory,media:{pageDisplay:async(...args)=>{calls++;return processor.pageDisplay(...args);}},db:{prepare:()=>({get:()=>alive?page:null})},authenticate:req=>{if(req.headers.authorization!=='fixture')throw Object.assign(Error('Denied'),{statusCode:401});req.user={id:'fixture-user'};},requireShelfUnlock:()=>{},findItem:requested=>{if(requested!==id||!alive)throw Object.assign(Error('Denied'),{statusCode:404});return {id,mime_type:IMAGE_BOOK_MIME};}});
  const url=`/api/v1/items/${id}/pages/1/display`,headers={authorization:'fixture'};
  assert.equal((await app.inject(url)).statusCode,401);assert.equal(calls,0);
  const responses=await Promise.all([app.inject({url,headers}),app.inject({url,headers})]);for(const response of responses){assert.equal(response.statusCode,200,response.body);const meta=await sharp(response.rawPayload).metadata();assert.equal(meta.format,'webp');assert.equal(meta.width,2400);assert.equal(meta.height,1560);}
  assert.equal(calls,1);const again=await app.inject({method:'HEAD',url,headers});assert.equal(again.statusCode,200);assert.equal(again.body,'');assert.equal(calls,1);assert.deepEqual(await readFile(source),original);
  assert.deepEqual(pageDisplayInfo(id,page),{displayUrl:url,displayWidth:2400,displayHeight:1560});assert.equal((await stat(join(root,'1.display-v1.webp'))).size,responses[0].rawPayload.length);
  alive=false;assert.equal((await app.inject({url,headers})).statusCode,404);
 }finally{await app.close();if(!resolve(directory).startsWith(resolve(tmpdir())+sep+'mirea-page-display-'))throw Error('Unsafe test cleanup');await rm(directory,{recursive:true,force:true});}
});

test('maintenance waits for a page display through publication, including an aborted reader',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mirea-page-display-')),id=randomUUID(),root=join(directory,id),app=Fastify(),maintenance=createMaintenanceGate(app);
 const page={page_number:1,width:16,height:16,mime_type:'image/jpeg'};let started,finish,request;
 const generating=new Promise(resolve=>started=resolve),wait=new Promise(resolve=>finish=resolve);
 try{
  await mkdir(root);const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#789abc'}}).webp().toBuffer();
  registerImageDisplays(app,{booksDir:directory,db:{prepare:()=>({get:()=>page})},media:{pageDisplay:async(_source,target)=>{await writeFile(target,bytes);started();await wait;}},requireShelfUnlock:()=>{},
   authenticate:req=>{request=req;req.user={id:'fixture-user'};},findItem:()=>({id,mime_type:IMAGE_BOOK_MIME})});
  const response=app.inject({url:`/api/v1/items/${id}/pages/1/display`}).then(result=>result);await generating;
  request.raw.emit('aborted');let acquired=false;const waiting=maintenance.acquire().then(release=>{acquired=true;return release;});
  await delay(60);assert.equal(acquired,false,'decode completion or a disconnected reader does not release the publication reservation');
  assert.equal((await app.inject({method:'HEAD',url:`/api/v1/items/${id}/pages/1/display`})).statusCode,503);
  finish();assert.equal((await response).statusCode,200);const release=await waiting;
  try{assert.deepEqual(await readFile(join(root,'1.display-v1.webp')),bytes);assert.deepEqual(await readdir(root),['1.display-v1.webp']);}finally{release();}
 }finally{finish();await app.close();if(!resolve(directory).startsWith(resolve(tmpdir())+sep+'mirea-page-display-'))throw Error('Unsafe fixture cleanup');await rm(directory,{recursive:true,force:true});}
});

for(const change of ['private-shelf','move-to-private-shelf','session-revoked'])test(`display rechecks access after generation: ${change}`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mirea-page-display-')),id=randomUUID(),root=join(directory,id),app=Fastify();
 const page={page_number:1,width:16,height:16,mime_type:'image/jpeg'},locked=new Set();let shelfId='public',authorized=true,started,finish;
 const generating=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>finish=resolve);
 const requireShelfUnlock=(_req,shelf)=>{if(locked.has(shelf))throw Object.assign(Error('Unlock required'),{statusCode:423});};
 try{
  await mkdir(root);const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#789abc'}}).webp().toBuffer();
  // Mirror the initial private-shelf hook; it succeeds before the fixture change.
  app.addHook('preHandler',async req=>requireShelfUnlock(req,shelfId));
  registerImageDisplays(app,{booksDir:directory,db:{prepare:()=>({get:()=>page})},media:{pageDisplay:async(_source,target)=>{started();await gate;await writeFile(target,bytes);}},requireShelfUnlock,
   authenticate:req=>{if(!authorized)throw Object.assign(Error('Session revoked'),{statusCode:401});req.user={id:'fixture-user'};},findItem:()=>({id,mime_type:IMAGE_BOOK_MIME,shelf_id:shelfId})});
  const responsePromise=app.inject({url:`/api/v1/items/${id}/pages/1/display`});await generating;
  if(change==='move-to-private-shelf')shelfId='other-private';
  if(change==='session-revoked')authorized=false;else locked.add(shelfId);
  finish();const response=await responsePromise;assert.equal(response.statusCode,change==='session-revoked'?401:423,response.body);assert.notEqual(response.headers['content-type'],'image/webp');
 }finally{finish();await app.close();if(!resolve(directory).startsWith(resolve(tmpdir())+sep+'mirea-page-display-'))throw Error('Unsafe fixture cleanup');await rm(directory,{recursive:true,force:true});}
});
