// Executed through the image entrypoint in an isolated CI fixture, not docker exec.
import assert from 'node:assert/strict';
import {readFile,writeFile,truncate,copyFile,chmod,mkdir,rename,link,rm,open} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
const status=await readFile('/proc/self/status','utf8');
assert.match(status,/NoNewPrivs:\s+1/);
for(const name of ['CapInh','CapPrm','CapEff','CapAmb'])assert.match(status,new RegExp(name+':\\s+0+\\n'));
assert.equal(process.getuid(),9033);assert.equal(process.getgid(),3036);
assert.equal(process.env.SQLITE_TMPDIR,'/tmp');
const denied=error=>['EACCES','EPERM','EROFS'].includes(error.code);
for(const path of ['/var/tmp/mirea-sandbox-denied','/app/package.json','/usr/local/bin/node'])await assert.rejects(open(path,'a'),denied);
await assert.rejects(writeFile('/data/outside-link','forbidden'),denied);
await assert.rejects(truncate('/var/tmp/mirea-sandbox-owned',0),denied);
// Same filesystem: EXDEV from crossing bind mounts is not sandbox evidence.
await assert.rejects(rename('/var/tmp/mirea-sandbox-owned','/var/tmp/mirea-sandbox-renamed'),denied);
await assert.rejects(link('/var/tmp/mirea-sandbox-owned','/var/tmp/mirea-sandbox-hardlink'),denied);
assert.equal(await readFile('/var/tmp/mirea-sandbox-owned','utf8'),'must remain');
for(const path of ['/data','/media','/tmp']) {
  const folder=path+'/sandbox-fixture';await mkdir(folder);
  await writeFile(folder+'/file','allowed');await truncate(folder+'/file',3);
  await rename(folder+'/file',folder+'/renamed');assert.equal(await readFile(folder+'/renamed','utf8'),'all');
  await rm(folder,{recursive:true});
}
await copyFile('/bin/true','/tmp/mirea-untrusted-executable');await chmod('/tmp/mirea-untrusted-executable',0o700);
assert.equal(spawnSync('/tmp/mirea-untrusted-executable').error.code,'EACCES');
const code=`const fs=require('node:fs');const s=fs.readFileSync('/proc/self/status','utf8');if(!/NoNewPrivs:\\s+1/.test(s))throw Error('NNP not inherited');try{fs.writeFileSync('/var/tmp/mirea-sandbox-child','bad');throw Error('escaped')}catch(e){if(e.code!=='EACCES')throw e;}`;
const child=spawnSync(process.execPath,['-e',code],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
await new Promise((resolve,reject)=>{const worker=new Worker(code,{eval:true,execArgv:[]});worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(Error('worker escaped sandbox')));});
// Reproduce the old Unix VFS /var/tmp selection in a fresh, still-sandboxed
// child, then run the SAME cascade with the launcher's /tmp environment.
// Many image-page rows and a bounded small cache force the cascade's statement
// journal past its RAM buffer (freeing one BLOB alone need not dirty pages).
// These are throwaway DBs under the isolated /data fixture, never real assets.
const sqliteCascade=String.raw`
import assert from 'node:assert/strict';
import {openDatabase} from '/app/server/database.js';
import {randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
const legacy=process.argv[1]==='legacy',file='/data/sqlite-cascade-'+randomUUID()+'.sqlite';
let db,phase='seed',reproduced=false;
try{
 db=openDatabase(file);db.exec("INSERT INTO users VALUES('u','cascade@example.invalid','Synthetic','not-a-login-hash',1);INSERT INTO shelves(id,name,created_at) VALUES('s','Synthetic',1);INSERT INTO series(id,shelf_id,title,created_at,updated_at) VALUES('r','s','Synthetic',1,1);INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count) VALUES('synthetic','s','Synthetic','fixture.png','application/vnd.mirea.image-book',1,'u',1,1000);INSERT INTO series_items VALUES('r','synthetic',1,'');");
 db.exec('BEGIN IMMEDIATE');const insert=db.prepare('INSERT INTO image_pages(item_id,page_number,filename,size,width,height) VALUES(?,?,?,?,?,?)');for(let n=1;n<=1000;n++)insert.run('synthetic',n,('page-'+n+'-').padEnd(240,'x'),1,1,1);db.exec('COMMIT');
 db.exec('PRAGMA cache_size=8');
 db.exec('BEGIN IMMEDIATE');phase='delete';
 try{db.prepare('DELETE FROM items WHERE id=?').run('synthetic');}
 catch(error){assert(legacy);assert.equal(phase,'delete');assert.equal(error.errcode,14);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM image_pages').get().n,1000);assert.equal(db.prepare("SELECT revision FROM series WHERE id='r'").get().revision,1);reproduced=true;}
 if(!reproduced){assert(!legacy,'Old temporary directory must reproduce SQLITE_CANTOPEN');db.exec('COMMIT');assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM image_pages').get().n,0);}
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 console.log(JSON.stringify({legacy,reproduced,deleted:!legacy,rollbackPreserved:reproduced}));
}finally{db?.close();for(const suffix of ['','-wal','-shm'])rmSync(file+suffix,{force:true});}
`;
for(const legacy of [true,false]){
 const result=spawnSync(process.execPath,['--input-type=module','-e',sqliteCascade,legacy?'legacy':'fixed'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,env:{...process.env,SQLITE_TMPDIR:legacy?'/var/tmp':process.env.SQLITE_TMPDIR}});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const proof=JSON.parse(result.stdout.trim());assert.equal(proof.reproduced,legacy);assert.equal(proof.deleted,!legacy);
}
console.log(JSON.stringify({sandbox:true,nonRoot:true,noNewPrivileges:true,writeAndTruncateBlocked:true,renameAndHardlinkBlocked:true,workerAndChildInherited:true,writableRoots:true,untrustedNativeExecutionDenied:true,sqliteLegacyCantOpenReproduced:true,sqliteCascadeRollbackPreserved:true,sqliteCascadeWithAllowedTemp:true}));
