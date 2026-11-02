import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm,stat,readdir,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID,createHash } from 'node:crypto';
import sharp from 'sharp';
import { compileEpub } from '../server/epub.js';
import { createApp } from '../server/app.js';
import { EPUB_MIME,EPUB_BUNDLE_MIME,MAX_EPUB_BYTES } from '../server/ebook-types.js';
import { makeEpub,epubFiles,makeZip } from './epub-fixtures.js';
import { validateEpubBundle,epubScreen,epubFraction,renderEpubChapter } from '../web/src/epub-core.js';
import { validateManifest,importDownloadKey,decryptDownloadChunk } from '../web/src/download-core.js';
import { swipeStep } from '../web/src/book-gestures.js';

async function folderFor(t){const folder=await mkdtemp(join(tmpdir(),'mirea-epub-'));t.after(()=>rm(folder,{recursive:true,force:true}));return folder;}
test('EPUB3 preserves spine order, Japanese/ruby text, cover, titles and direction; EPUB2 also opens',async t=>{
  const dir=await folderFor(t),cover=await sharp({create:{width:200,height:300,channels:3,background:'#336699'}}).png().toBuffer();
  for(const version of ['3.0','2.0']){
    const source=join(dir,version+'.epub'),thumbnail=source+'.jpg',bundle=source+'.json';await writeFile(source,makeEpub({version,cover}));
    assert.equal((await compileEpub(source,thumbnail,bundle)).pageCount,2);
    const book=validateEpubBundle(JSON.parse(await readFile(bundle,'utf8')));
    assert.equal(book.title,'試験の本 & Test');assert.equal(book.author,'著者');assert.equal(book.direction,'rtl');assert.deepEqual(book.chapters.map(c=>c.title),['はじまり','つづき']);
    assert.match(JSON.stringify(book.chapters[0]),/かんじ/);assert.match(JSON.stringify(book.chapters[0]),/日本語/);assert.equal(book.resources.length,1);assert.equal((await sharp(thumbnail).metadata()).format,'jpeg');
    assert.equal(book.chapters[0].children.find(n=>n.tag==='a').chapter,1);
  }
});
test('EPUB input cannot inject script, active markup, CSS, external URLs or arbitrary DOM attributes',async t=>{
  const dir=await folderFor(t),source=join(dir,'safe.epub');
  await writeFile(source,makeEpub({body:'<html><body><script>alert(1)</script><style>body{background:url(https://evil.test)}</style><iframe src="https://evil.test"></iframe><p onclick="alert(1)" style="display:none">安全な本文</p><img src="https://evil.test/a.jpg"><a href="javascript:alert(1)">外部</a><a href="../../secret">秘密</a></body></html>'}));
  await compileEpub(source,source+'.jpg',source+'.json');
  const book=validateEpubBundle(JSON.parse(await readFile(source+'.json','utf8'))),json=JSON.stringify(book);
  for(const dangerous of ['alert(1)','evil.test','onclick','iframe','style','../../secret'])assert.ok(!json.includes(dangerous),dangerous);
  const doc={createElement:tag=>({tag,children:[],append(child){this.children.push(child);}}),createTextNode:text=>({text}),createDocumentFragment:()=>({children:[],append(child){this.children.push(child);}})};
  const rendered=renderEpubChapter(book.chapters[0],{doc,imageUrl:()=>{throw Error('No images');},onLink:()=>{}});assert.ok(rendered.fragment.children.length);
  assert.throws(()=>validateEpubBundle({...book,chapters:[{title:'x',children:[{tag:'script',children:[]}]}]}));
  assert.throws(()=>validateEpubBundle({...book,resources:[{mime:'image/svg+xml',data:'PHN2Zz4='}]}));
});
test('EPUB rejects traversal, symlinks, duplicate entries, ZIP encryption, bombs, DTD, DRM and fixed layout',async t=>{
  const dir=await folderFor(t),files=epubFiles();
  const bad=[
    [...files,{name:'../escape',data:'x'}],
    [...files,{name:'OEBPS/link',data:'target',attributes:0xa1ff0000}],
    [...files,files[0]],
    files.map((f,i)=>i===3?{...f,flags:1}:f),
    [...files,{name:'bomb',data:'x',deflate:true,expanded:49*1024*1024}],
    [...files.filter(f=>f.name!=='OEBPS/one.xhtml'),{name:'OEBPS/one.xhtml',data:'x'.repeat(3*1024*1024),deflate:true,expanded:1}],
    files.map(f=>f.name.endsWith('book.opf')?{...f,data:'<!DOCTYPE x [<!ENTITY y SYSTEM "file:///secret">]><package/>'}:f),
    epubFiles({encryption:'<encryption><EncryptedData><EncryptionMethod Algorithm="urn:drm"/><CipherData><CipherReference URI="OEBPS/one.xhtml"/></CipherData></EncryptedData></encryption>'}),
    epubFiles({opfExtra:'<meta property="rendition:layout">pre-paginated</meta>'}),
    files.map(f=>f.name==='mimetype'?{...f,data:'application/zip'}:f)
  ];
  for(const [index,input] of bad.entries()){const source=join(dir,index+'.epub');await writeFile(source,makeZip(input));await assert.rejects(compileEpub(source,source+'.jpg',source+'.json'),undefined,`bad EPUB ${index}`);}
});
test('standard font obfuscation is ignored, not mistaken for content DRM or decrypted',async t=>{
  const dir=await folderFor(t),source=join(dir,'font.epub');await writeFile(source,makeEpub({encryption:'<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><CipherData><CipherReference URI="OEBPS/font.otf"/></CipherData></EncryptedData></encryption>'}));
  assert.equal((await compileEpub(source,source+'.jpg',source+'.json')).pageCount,2);assert.ok(!(await readFile(source+'.json','utf8')).includes('ignored obfuscated font'));
});
test('EPUB detects CRC corruption and safely renders a cover for entity-heavy titles',async t=>{
  const dir=await folderFor(t),files=epubFiles();
  const corrupted=makeZip(files),marker=Buffer.from('application/epub+zip'),offset=corrupted.indexOf(marker);corrupted[offset]=0x62;
  const bad=join(dir,'crc.epub');await writeFile(bad,corrupted);await assert.rejects(compileEpub(bad,bad+'.jpg'),/integrity/);
  const titleFiles=files.map(file=>file.name.endsWith('book.opf')?{...file,data:file.data.replace('試験の本 &amp; Test','&amp;'.repeat(180))}:file);
  const source=join(dir,'entities.epub');await writeFile(source,makeZip(titleFiles));await compileEpub(source,source+'.jpg',source+'.json');assert.equal((await sharp(source+'.jpg').metadata()).format,'jpeg');
});

async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'mirea-epub-api-')),options={dataDir:dir,chunkSize:512,rateLimit:false};let app=await createApp(options);t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const request=(method,path,session,payload,extra={})=>app.inject({method,url:'/api/v1'+path,headers:{...(session?{authorization:`Bearer ${session.token}`}:{}) ,...extra},payload});
  const register=async name=>(await request('POST','/auth/register',null,{name,email:name+'@example.test',password:'correct-horse-battery-staple'})).json();
  const owner=await register('epubowner'),viewer=await register('epubviewer'),outsider=await register('epuboutsider');
  const shelf=(await request('POST','/shelves',owner,{name:'EPUB library'})).json().id;await request('POST',`/shelves/${shelf}/members`,owner,{email:viewer.user.email,role:'viewer'});
  const bytes=makeEpub();
  let multipartSequence=0;
  const multipart=async(buffer=bytes,mime=EPUB_MIME)=>{
    const boundary='mirea-epub-test',payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nEPUB fixture ${++multipartSequence}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="book.epub"\r\nContent-Type: ${mime}\r\n\r\n`),buffer,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return request('POST',`/shelves/${shelf}/items`,owner,payload,{'content-type':`multipart/form-data; boundary=${boundary}`});
  };
  return {dir,get app(){return app;},request,owner,viewer,outsider,shelf,bytes,multipart,async restart(){await app.close();app=await createApp(options);}};
}
test('EPUB multipart: reading/thumbnail/original Range, private progress/history, encrypted download and revoked access',async t=>{
  const c=await setup(t),uploaded=await c.multipart();assert.equal(uploaded.statusCode,201,uploaded.body);const item=uploaded.json().item,path=`/items/${item.id}`;assert.equal(item.kind,'epub');assert.equal(item.pageCount,2);
  assert.equal((await c.request('GET',path+'/epub')).statusCode,401);assert.equal((await c.request('GET',path+'/epub',c.outsider)).statusCode,404);
  const reading=await c.request('GET',path+'/epub',c.viewer);assert.equal(reading.statusCode,200,reading.body);assert.ok(reading.headers['content-type'].startsWith(EPUB_BUNDLE_MIME));assert.equal(reading.headers['cache-control'],'no-store');validateEpubBundle(reading.json());
  const range=await c.request('GET',path+'/content',c.viewer,undefined,{range:'bytes=0-15'});assert.equal(range.statusCode,206);assert.deepEqual(range.rawPayload,c.bytes.subarray(0,16));
  const thumb=await c.request('GET',path+'/thumbnail',c.viewer);assert.equal((await sharp(thumb.rawPayload).metadata()).format,'webp');
  const position={revision:0,updateId:randomUUID(),page:2,scrollX:.6,scrollY:0,zoom:'1.5'};const saved=await c.request('PUT',path+'/progress',c.viewer,position);assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().progress.scrollX,.6);assert.equal((await c.request('GET',path+'/progress',c.owner)).json().progress,null);
  const event=await c.request('POST','/analytics/events',c.viewer,{view:{id:randomUUID(),assetId:item.id,context:'viewer',platform:'web',clientVersion:'test'},events:[{id:randomUUID(),seq:1,type:'page_enter',at:Date.now(),elapsedMs:0,page:2,x:.5,y:0,width:.5,height:1,visible:true,focused:true}]});assert.equal(event.statusCode,200,event.body);assert.equal((await c.request('GET','/analytics/me/summary',c.viewer)).json().assets[0].kind,'epub');
  const download=await c.request('POST',path+'/download',c.viewer);assert.equal(download.statusCode,200,download.body);const manifest=validateManifest(download.json().manifest);assert.equal(manifest.kind,'epub');assert.equal(manifest.files[0].mime,EPUB_BUNDLE_MIME);assert.equal(download.json().key,undefined);
  await c.restart();assert.equal((await c.request('GET',path+'/progress',c.viewer)).json().progress.scrollX,.6);
  assert.deepEqual((await c.request('GET',path+'/epub',c.viewer)).rawPayload,reading.rawPayload);
  const opened=await c.request('POST',`/downloads/${manifest.id}/open`,c.viewer);const key=await importDownloadKey(opened.json().key),chunk=await c.request('GET',`/downloads/${manifest.id}/files/0/parts/0`,c.viewer);assert.ok(!chunk.rawPayload.includes(Buffer.from('日本語')));assert.deepEqual(Buffer.from(await decryptDownloadChunk(key,manifest,0,0,chunk.rawPayload)),reading.rawPayload);
  const another=(await c.multipart()).json().item,series=(await c.request('POST',`/shelves/${c.shelf}/series`,c.owner,{title:'EPUB series'})).json().series;
  const edited=await c.request('PUT',`/series/${series.id}`,c.owner,{revision:series.revision,title:series.title,description:'',items:[{assetId:item.id,label:'1'},{assetId:another.id,label:'2'}]});assert.equal(edited.statusCode,200,edited.body);
  const context=await c.request('GET',path+'/series',c.viewer);assert.equal(context.statusCode,200,context.body);assert.deepEqual(context.json().items.map(i=>i.kind),['epub','epub']);
  await unlink(join(c.dir,'thumbnails',item.id+'.jpg'));assert.equal((await c.request('GET',path+'/thumbnail',c.viewer)).statusCode,200);
  await c.request('DELETE',`/shelves/${c.shelf}/members/${c.viewer.user.id}`,c.owner);assert.equal((await c.request('GET',path+'/epub',c.viewer)).statusCode,404);assert.equal((await c.request('POST',`/downloads/${manifest.id}/open`,c.viewer)).statusCode,404);assert.equal((await c.request('GET',`/downloads/${manifest.id}/files/0/parts/0`,c.viewer)).statusCode,404);
  assert.equal((await c.request('DELETE',path,c.owner)).statusCode,204);await assert.rejects(stat(join(c.dir,'uploads','books',item.id)),{code:'ENOENT'});await assert.rejects(stat(join(c.dir,'uploads',item.id)),{code:'ENOENT'});
});
test('EPUB resumable chunks publish, enforce per-format limits and leave no failed staged files',async t=>{
  const c=await setup(t);
  const tooBig=await c.request('POST',`/shelves/${c.shelf}/uploads`,c.owner,{title:'Too big',files:[{filename:'a.epub',mime:EPUB_MIME,size:MAX_EPUB_BYTES+1}]});assert.equal(tooBig.statusCode,413);
  for(const invalid of [false,true]){
    const bytes=invalid?makeZip([{name:'mimetype',data:'not EPUB'}]):c.bytes;
    const begin=await c.request('POST',`/shelves/${c.shelf}/uploads`,c.owner,{title:'Chunk EPUB '+invalid,files:[{filename:'a.epub',mime:EPUB_MIME,size:bytes.length}]});assert.equal(begin.statusCode,201,begin.body);const upload=begin.json();
    for(let offset=0,part=0;offset<bytes.length;offset+=upload.chunkSize,part++){const chunk=bytes.subarray(offset,offset+upload.chunkSize),result=await c.request('PUT',`/uploads/${upload.id}/files/0/parts/${part}`,c.owner,chunk,{'content-type':'application/octet-stream','x-chunk-sha256':createHash('sha256').update(chunk).digest('hex')});assert.equal(result.statusCode,204,result.body);}
    await c.request('POST',`/uploads/${upload.id}/complete`,c.owner);let result;
    const deadline=Date.now()+30000;do{await new Promise(resolve=>setTimeout(resolve,20));result=(await c.request('GET',`/uploads/${upload.id}`,c.owner)).json();}while(result.state==='processing'&&Date.now()<deadline);
    assert.equal(result.state,invalid?'failed':'complete',JSON.stringify(result));
    if(!invalid){assert.equal(result.item.kind,'epub');assert.equal((await c.request('GET',`/items/${result.item.id}/epub`,c.owner)).statusCode,200);}
  }
  assert.equal((await readdir(join(c.dir,'uploads','staging'))).length,0);
});
test('horizontal swipe supports slow drags and both directions, excluding scroll/pinch/stationary long presses; EPUB position survives reflow',()=>{
  const gesture={dx:-100,dy:10,elapsed:250,width:800};assert.equal(swipeStep(gesture),1);assert.equal(swipeStep({...gesture,direction:'rtl'}),-1);assert.equal(swipeStep({...gesture,dx:100}),-1);
  assert.equal(swipeStep({...gesture,elapsed:3500}),1);
  for(const changed of [{dy:100},{dx:10},{dx:0,elapsed:3500},{canTurn:false}])assert.equal(swipeStep({...gesture,...changed}),0);
  assert.equal(epubScreen(epubFraction(3,7),13),6);assert.equal(epubScreen(1,1),0);assert.equal(epubFraction(0,1),0);
});
