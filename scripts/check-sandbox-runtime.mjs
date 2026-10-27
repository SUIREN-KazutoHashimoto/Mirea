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
// A storyboard-sized BLOB makes the statement journal exceed its RAM buffer.
// These are throwaway DBs under the isolated /data fixture, never real assets.
const sqliteCascade=String.raw`
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
const legacy=process.argv[1]==='legacy',file='/data/sqlite-cascade-'+randomUUID()+'.sqlite';
let db,phase='seed',reproduced=false;
try{
 db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE items(id TEXT PRIMARY KEY); CREATE TABLE video_navigation(item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,storyboard BLOB);');
 db.prepare('INSERT INTO items VALUES(?)').run('synthetic');
 db.prepare('INSERT INTO video_navigation VALUES(?,?)').run('synthetic',Buffer.alloc(8*1024*1024,7));
 db.exec('BEGIN IMMEDIATE');phase='delete';
 try{db.prepare('DELETE FROM items WHERE id=?').run('synthetic');}
 catch(error){assert(legacy);assert.equal(phase,'delete');assert.equal(error.sqliteCode,14);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n,1);assert.equal(db.prepare('SELECT length(storyboard) n FROM video_navigation').get().n,8*1024*1024);reproduced=true;}
 if(!reproduced){assert(!legacy,'Old temporary directory must reproduce SQLITE_CANTOPEN');db.exec('COMMIT');assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM video_navigation').get().n,0);}
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
