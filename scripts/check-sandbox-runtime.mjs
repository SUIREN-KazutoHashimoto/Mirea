// Executed through the image entrypoint in an isolated CI fixture, not docker exec.
import assert from 'node:assert/strict';
import {readFile,writeFile,truncate,copyFile,chmod,mkdir,rename,link,rm,open} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
const status=await readFile('/proc/self/status','utf8');
assert.match(status,/NoNewPrivs:\s+1/);
for(const name of ['CapInh','CapPrm','CapEff','CapAmb'])assert.match(status,new RegExp(name+':\\s+0+\\n'));
assert.equal(process.getuid(),9033);assert.equal(process.getgid(),3036);
const denied=error=>['EACCES','EPERM','EROFS'].includes(error.code);
for(const path of ['/var/tmp/mirea-sandbox-denied','/app/package.json','/usr/local/bin/node'])await assert.rejects(open(path,'a'),denied);
await assert.rejects(writeFile('/data/outside-link','forbidden'),denied);
await assert.rejects(truncate('/var/tmp/mirea-sandbox-owned',0),denied);
await assert.rejects(rename('/var/tmp/mirea-sandbox-owned','/data/stolen'),denied);
await assert.rejects(link('/var/tmp/mirea-sandbox-owned','/data/hardlink'),denied);
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
console.log(JSON.stringify({sandbox:true,nonRoot:true,noNewPrivileges:true,writeAndTruncateBlocked:true,renameAndHardlinkBlocked:true,workerAndChildInherited:true,writableRoots:true,untrustedNativeExecutionDenied:true}));
