import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,rename,access,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {storagePaths,initializeStorage,LAYOUT_FILE,MEDIA_MARKER,readLayout} from '../server/storage.js';
import {moveStorage,copyStorageTree} from '../server/storage-move.js';
import {prepareMediaStorage} from '../scripts/prepare-media-storage.mjs';
import {verifySeparateStorage} from '../scripts/check-storage-runtime.mjs';
import {createApp} from '../server/app.js';
import {runtimeConfig} from '../server/runtime.js';
import {makeEpub} from './epub-fixtures.js';
import {makePdf} from './fixtures.js';

async function temp(t){const p=await mkdtemp(join(tmpdir(),'mirea-storage-test-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
test('storage defaults preserve legacy paths; explicit roots are separate and relative runtime paths use installation root',async t=>{
 const root=await temp(t),data=join(root,'state'),media=join(root,'media');assert.equal(storagePaths(data).uploadDir,join(data,'uploads'));assert.equal(storagePaths(data,media).thumbnailDir,join(data,'thumbnails'));assert.equal(runtimeConfig({DATA_DIR:'state',MEDIA_DIR:'media'},root).mediaDir,media);
 for(const [a,b]of [[data,join(data,'nested')],[join(media,'nested'),media],[data,'']])assert.throws(()=>storagePaths(a,b));assert.throws(()=>runtimeConfig({MEDIA_DIR:' '}));
 await assert.rejects(()=>initializeStorage(storagePaths(data,media)),{code:'ENOENT'});await mkdir(media);await initializeStorage(storagePaths(data,media));const state=await readLayout(join(data,LAYOUT_FILE));assert.equal(state.id,(await readLayout(join(media,MEDIA_MARKER))).id);await assert.rejects(()=>initializeStorage(storagePaths(data)),/mode changed/);
 const displaced=join(root,'displaced');await rename(media,displaced);await mkdir(media);await assert.rejects(()=>initializeStorage(storagePaths(data,media)),/identity/);await assert.rejects(access(join(media,'uploads')),{code:'ENOENT'});
});
test('cross-device publication verifies a full file/tree before replacing the destination and preserves originals on failure',async t=>{
 const root=await temp(t),source=join(root,'source'),target=join(root,'target'),exdev=()=>{throw Object.assign(Error('fixture cross-device'),{code:'EXDEV'});};await writeFile(source,'new media');await writeFile(target,'old media');await moveStorage(source,target,{renameFile:exdev});assert.equal(await readFile(target,'utf8'),'new media');await assert.rejects(access(source),{code:'ENOENT'});
 const folder=join(root,'folder'),dest=join(root,'published');await mkdir(folder);await writeFile(join(folder,'part'),'verified');await moveStorage(folder,dest,{renameFile:exdev});assert.equal(await readFile(join(dest,'part'),'utf8'),'verified');
 await writeFile(source,'source must survive');let n=0;await assert.rejects(()=>moveStorage(source,target,{renameFile:exdev,authorize(){if(++n>=3)throw Error('revoked');}}),/revoked/);assert.equal(await readFile(source,'utf8'),'source must survive');assert.equal(await readFile(target,'utf8'),'new media');assert(!(await readdir(root)).some(n=>n.startsWith('.mirea-publish-')));
 const denied=()=>{throw Object.assign(Error('denied'),{code:'EACCES'});};await assert.rejects(()=>moveStorage(source,target,{renameFile:denied}),{code:'EACCES'});await assert.rejects(()=>moveStorage(dest,join(dest,'child')),/Invalid storage move/);
});
test('offline copy-only migration requires acknowledgements, refuses nonempty/aliased destinations, preserves DB/key/media and binds both roots',async t=>{
 const root=await temp(t),data=join(root,'state'),media=join(root,'media');await mkdir(media);const app=await createApp({dataDir:data,rateLimit:false});
 const session=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Migration fixture',email:randomUUID()+'@example.invalid',password:'fixture-migration-password'}})).json(),headers={authorization:'Bearer '+session.token};
 const shelf=(await app.inject({method:'POST',url:'/api/v1/shelves',headers,payload:{name:'Migrated shelf'}})).json().id,bytes=makePdf(),boundary='mirea-'+randomUUID();
 const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 const upload=await app.inject({method:'POST',url:'/api/v1/shelves/'+shelf+'/items',headers:{...headers,'content-type':'multipart/form-data; boundary='+boundary},payload:body});assert.equal(upload.statusCode,201,upload.body);const asset=upload.json().item;assert(asset?.id);
 await app.close();await writeFile(join(data,'uploads',randomUUID()),'fixture media');const db=await readFile(join(data,'mirea.sqlite')),key=await readFile(join(data,'keys','download-master.key'));
 await assert.rejects(()=>prepareMediaStorage({dataDir:data,mediaDir:media}),/acknowledgements/);const opts={dataDir:data,mediaDir:media,acknowledgeStopped:true,acknowledgeBackup:true};const result=await prepareMediaStorage(opts);assert(result.success&&!result.originalMediaDeleted);assert.deepEqual(await readFile(join(data,'mirea.sqlite')),db);assert.deepEqual(await readFile(join(data,'keys','download-master.key')),key);assert.deepEqual(await readdir(join(media,'uploads')),await readdir(join(data,'uploads')));await assert.rejects(access(join(media,'keys')),{code:'ENOENT'});
 const migrated=await createApp({dataDir:data,mediaDir:media,rateLimit:false});assert.equal((await migrated.inject({url:'/api/v1/auth/me',headers})).json().user.id,session.user.id);assert.deepEqual((await migrated.inject({url:'/api/v1/items/'+asset.id+'/content',headers})).rawPayload,bytes);await migrated.close();await assert.rejects(()=>prepareMediaStorage(opts),/EMPTY|already separated/);await assert.rejects(()=>createApp({dataDir:data}),/mode changed/);
});
test('storage copy never follows symlinks or replaces existing target files',async t=>{
 const root=await temp(t),file=join(root,'file'),out=join(root,'out');await writeFile(file,'private fixture');await writeFile(out,'existing');await assert.rejects(()=>copyStorageTree(file,out),{code:'EEXIST'});assert.equal(await readFile(out,'utf8'),'existing');
 const link=join(root,'link');try{await symlink(file,link);}catch(error){if(process.platform==='win32'&&error.code==='EPERM')return;throw error;}await assert.rejects(()=>copyStorageTree(link,join(root,'must-not-copy')),/links/);
});
test('real API upload/regeneration/backup/cleanup/download/restart/deletion work with separated state and media',async()=>{const result=await verifySeparateStorage();assert(result.success&&result.deleteBothRoots&&result.encryptedDownloadAfterRestart);if(process.platform==='linux')assert(result.realCrossDevice);});
test('EPUB multipart publication keeps the compiled book on media and its thumbnail on state storage',async t=>{
 const root=await temp(t),mediaDir=join(root,'media');await mkdir(mediaDir);const dataDir=join(root,'state'),app=await createApp({dataDir,mediaDir,rateLimit:false});try{
 const session=(await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'EPUB fixture',email:randomUUID()+'@example.invalid',password:'fixture-epub-password'}})).json(),headers={authorization:'Bearer '+session.token};const shelf=(await app.inject({method:'POST',url:'/api/v1/shelves',headers,payload:{name:'EPUB'}})).json().id,boundary='epub-'+randomUUID(),bytes=makeEpub();
 const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.epub"\r\nContent-Type: application/epub+zip\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]),r=await app.inject({method:'POST',url:'/api/v1/shelves/'+shelf+'/items',headers:{...headers,'content-type':'multipart/form-data; boundary='+boundary},payload:body});assert.equal(r.statusCode,201,r.body);const id=r.json().item.id;await access(join(dataDir,'thumbnails',id+'.jpg'));await access(join(mediaDir,'uploads','books',id,'book.json'));assert.deepEqual(await readFile(join(mediaDir,'uploads',id)),bytes);
 }finally{await app.close();}
});
