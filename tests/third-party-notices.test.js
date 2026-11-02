import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,cp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectNpmNotices,writeNotices,renderNotices,thirdPartyNoticesDevPlugin} from '../scripts/third-party-notices.mjs';
import {createServer} from 'vite';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'mirea-notices-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function pkg(root,name,metadata,files){const dir=join(root,'node_modules',name);await mkdir(dir,{recursive:true});await writeFile(join(dir,'package.json'),JSON.stringify({name,version:'1.0.0',license:'MIT',...metadata}));for(const [file,content]of Object.entries(files)){await mkdir(join(dir,file,'..'),{recursive:true});await writeFile(join(dir,file),content);}return dir;}
test('notices follow only the installed runtime graph and preserve upstream nested notices and binary provenance',async t=>{
 const root=await fixture(t);await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{used:'1'},devDependencies:{secret:'1'}}));
 const original='Copyright <Example>\nPermission is hereby granted\n<script>alert(1)</script>';
 await pkg(root,'used',{dependencies:{child:'1'},optionalDependencies:{absent:'1'}},{LICENSE:original,'META-INF/NOTICE.txt':'Upstream NOTICE','ffmpeg.exe.README':'Source Code: https://example.com/source','sbom.cdx.json':'{"components":[]}','private-secret.txt':'DO_NOT_COPY'});
 await pkg(root,'child',{}, {'README.md':'# Example\nPermission is hereby granted, free of charge ...'});
 await pkg(root,'secret',{}, {LICENSE:'DO_NOT_COPY_DEV_DEPENDENCY'});
 const result=await collectNpmNotices({projectRoot:root});assert.deepEqual(result.packages.map(p=>p.name),['child','used']);
 assert.equal(result.packages[1].documents.find(d=>d.path==='LICENSE').text,original);assert(result.packages[1].documents.some(d=>d.path==='META-INF/NOTICE.txt'));assert(result.packages[1].documents.some(d=>d.path==='ffmpeg.exe.README'));assert(result.packages[1].documents.some(d=>d.path==='sbom.cdx.json'));assert(!JSON.stringify(result).includes('DO_NOT_COPY'));
 const out=join(root,'out');await writeNotices({projectRoot:root,outputDirectory:out});const html=await readFile(join(out,'third-party-notices.html'),'utf8');assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(!html.includes(root));assert((await readFile(join(out,'third-party-notices.txt'),'utf8')).includes(original));
});
test('a missing runtime package or original license stops generation instead of silently publishing an incomplete list',async t=>{
 const root=await fixture(t);await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{missing:'1'}}));await assert.rejects(collectNpmNotices({projectRoot:root}),/not installed/);
 await pkg(root,'missing',{}, {'README.md':'License: MIT (a declaration is not the full text).'});await assert.rejects(collectNpmNotices({projectRoot:root}),/No license\/notice/);
});
async function linuxLibvipsFixture(t){
 const root=await fixture(t),name='@img/sharp-libvips-linux-x64',source='third-party/sharp-libvips-linux-x64-1.3.4',metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{[name]:'1.3.4'}}));
 const directory=await pkg(root,name,metadata,{'README.md':await readFile(join(source,'README.md')),'versions.json':await readFile(join(source,'versions.json')),'lib/libvips-cpp.so.8.18.7':Buffer.from([0,1,2])});
 const supplement=join(root,source);await cp(source,supplement,{recursive:true});
 return {root,directory,supplement};
}
test('the actual Linux libvips npm layout preserves its licensing table and component versions alongside full LGPL/GPL terms',async t=>{
 const {root,directory}=await linuxLibvipsFixture(t);await assert.rejects(access(join(directory,'LICENSE')),error=>error.code==='ENOENT');
 const catalog=await collectNpmNotices({projectRoot:root});assert.equal(catalog.packages.length,1);const item=catalog.packages[0];
 assert.equal(item.license,'LGPL-3.0-or-later');assert(item.licenseSource.includes('supplementary'));assert(item.licenseSource.includes('SPDX'));
 assert.deepEqual(item.documents.map(d=>d.path),['README.md','versions.json','supplementary/LICENSE.LGPL-3.0-or-later.txt']);
 assert.equal(item.documents[0].text,await readFile(join(directory,'README.md'),'utf8'));assert(item.documents[0].text.includes('fontconfig License'));
 assert.equal(JSON.parse(item.documents[1].text).vips,'8.18.7');assert(item.documents[2].text.includes('GNU LESSER GENERAL PUBLIC LICENSE'));assert(item.documents[2].text.includes('GNU GENERAL PUBLIC LICENSE'));assert(!item.documents[2].text.includes('Apache License'));
 const html=renderNotices(catalog)['third-party-notices.html'].body;assert(html.includes('LGPL-3.0-or-later'));assert(!html.includes(root));
});
test('libvips supplements reject altered original notices, missing or changed terms and unreviewed package versions',async t=>{
 const {root,directory,supplement}=await linuxLibvipsFixture(t),readme=join(directory,'README.md'),original=await readFile(readme),license=join(supplement,'LICENSE.LGPL-3.0-or-later.txt'),terms=await readFile(license);
 await writeFile(readme,'License: LGPL-3.0-or-later');await assert.rejects(collectNpmNotices({projectRoot:root}),/Reviewed sharp-libvips notice differs/);await writeFile(readme,original);
 await writeFile(license,'Omitted terms');await assert.rejects(collectNpmNotices({projectRoot:root}),/Reviewed sharp-libvips notice differs/);await rm(license);await assert.rejects(collectNpmNotices({projectRoot:root}),error=>error.code==='ENOENT');await writeFile(license,terms);
 const path=join(directory,'package.json'),metadata=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...metadata,version:'1.3.5'}));await assert.rejects(collectNpmNotices({projectRoot:root}),/No license\/notice/);
});
test('libvips supplemental terms never replace a different upstream declaration with the reviewed license',async t=>{
 const {root,directory}=await linuxLibvipsFixture(t),path=join(directory,'package.json'),metadata=JSON.parse(await readFile(path,'utf8'));
 for(const changed of [{license:'Apache-2.0'},{repository:{url:'git+https://example.com/unrelated.git',directory:'npm/linux-x64'}}]){
  await writeFile(path,JSON.stringify({...metadata,...changed}));await assert.rejects(collectNpmNotices({projectRoot:root}),/Unreviewed sharp-libvips license declaration/);
 }
});
test('the real installed runtime inventory contains hls, native image and FFmpeg notices without private paths',async()=>{
 const catalog=await collectNpmNotices();
 for(const name of ['hls.js','@capacitor/core','pdfjs-dist','sharp','ffmpeg-static','saxes'])assert(catalog.packages.some(p=>p.name===name&&p.documents.length));
 assert.equal(catalog.packages.find(p=>p.name==='hls.js').documents.find(d=>d.path==='LICENSE').text,await readFile('node_modules/hls.js/LICENSE','utf8'));
 assert(catalog.packages.find(p=>p.name==='saxes').licenseSource);assert(!JSON.stringify(catalog).includes(process.cwd()));
});
test('Vite development serves the three exact generated resources without an existing dist or HTML fallback',async t=>{
 const root=await fixture(t);await mkdir(join(root,'web'));await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{fixture:'1'}}));await pkg(root,'fixture',{}, {LICENSE:'Copyright Example\nPermission is hereby granted ...'});
 const expected=renderNotices(await collectNpmNotices({projectRoot:root}));
 const server=await createServer({configFile:false,root:join(root,'web'),cacheDir:join(root,'.vite'),logLevel:'silent',plugins:[thirdPartyNoticesDevPlugin({projectRoot:root})],server:{host:'127.0.0.1',port:0,watch:null,hmr:false}});
 try{
  await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
  for(const [name,file]of Object.entries(expected)){const response=await fetch(origin+'/'+name+'?check=1');assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),file.type+'; charset=utf-8');assert.equal(await response.text(),file.body);}
  const head=await fetch(origin+'/third-party-notices.json',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.equal((await fetch(origin+'/third-party-notices.private')).status,404);assert.equal((await fetch(origin+'/third-party-notices.json',{method:'POST'})).status,404);
  await assert.rejects(access(join(root,'dist')),error=>error.code==='ENOENT');
 }finally{await server.close();}
});
