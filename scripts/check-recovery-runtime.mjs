// Run from the package root (also supported through node --input-type=module).
// This fixture uses a private temporary tree, never an existing library.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';
const moduleAt=name=>import(pathToFileURL(resolve('server',name)).href);
const {openDatabase}=await moduleAt('database.js'),{storagePaths,initializeStorage}=await moduleAt('storage.js'),{openRecoveryStore}=await moduleAt('recovery-store.js');
const fixture=await mkdtemp(join(tmpdir(),'mirea-recovery-runtime-'));
try{
 for(const separated of [false,true]){
  const dataDir=join(fixture,separated?'separated-data':'combined'),mediaDir=separated?join(fixture,'separated-media'):dataDir;if(separated)await mkdir(mediaDir);
  const storage=storagePaths(dataDir,mediaDir);await initializeStorage(storage);const db=openDatabase(join(dataDir,'mirea.sqlite'));
  try{
   const user=randomUUID(),shelf=randomUUID(),asset=randomUUID(),bytes=Buffer.from('synthetic recovery fixture');
   db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user,'recovery@example.invalid','Synthetic','synthetic-hash',Date.now());db.prepare('INSERT INTO shelves(id,name,created_at) VALUES(?,?,?)').run(shelf,'Synthetic',Date.now());db.prepare('INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(asset,shelf,'Synthetic','fixture.pdf','application/pdf',bytes.length,user,Date.now());
   await writeFile(join(storage.uploadDir,asset),bytes);await mkdir(join(dataDir,'keys'));await writeFile(join(dataDir,'keys','download-master.key'),randomBytes(32),{mode:0o600});
   const layout=JSON.parse(await readFile(join(dataDir,'storage-layout.json'),'utf8')),store=await openRecoveryStore({dataDir,mediaDir,storageId:layout.id});
   const point=await store.capture({db,scope:'full',reason:'manual',version:'2.1.0-beta',reserveMiB:0}),entry=point.files.find(f=>f.name.endsWith('/'+asset));assert(entry);
   assert.notEqual((await lstat(store.objectPath(entry.sha256))).ino,(await lstat(join(storage.uploadDir,asset))).ino,'Backup must not alias the writable source');
   await writeFile(join(storage.uploadDir,asset),'changed synthetic source');assert.deepEqual(await readFile(store.objectPath(entry.sha256)),bytes);
   const verified=await store.verify(point.id);assert.equal(verified.database.assets,1);assert.equal(verified.database.users,1);
   console.log(JSON.stringify({success:true,separated,scope:point.scope,databaseAndChecksumsVerified:true,sourceIndependent:true,workerVerified:true}));
  }finally{db.close();}
 }
}finally{assert(resolve(fixture).startsWith(resolve(tmpdir())+sep+'mirea-recovery-runtime-'));await rm(fixture,{recursive:true,force:true});}
