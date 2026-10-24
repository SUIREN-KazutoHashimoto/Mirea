// Linux CI only. No production paths, ports or Docker socket are mounted.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
if(process.env.GITHUB_ACTIONS!=='true'||!/^mirea-ci-\d+-\d+$/.test(process.env.COMPOSE_PROJECT_NAME??''))throw Error('Isolated Linux CI required');
const image=process.env.MIREA_IMAGE;
assert.equal(image,'mirea:ci');
const fixture=await mkdtemp(join(tmpdir(),process.env.COMPOSE_PROJECT_NAME+'-sandbox-'));
assert(fixture.startsWith(resolve(tmpdir())+sep+'mirea-ci-'));
function docker(args,{input,success=true}={}) {
  const result=spawnSync('docker',args,{input,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
  if(result.error)throw result.error;
  if(success)assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  return result;
}
try {
  for(const dir of ['data','media'])await mkdir(join(fixture,dir));
  await writeFile(join(fixture,'owned'),'must remain');
  await symlink('/var/tmp/mirea-sandbox-owned',join(fixture,'data/outside-link'));
  // Test setup is root only inside this throwaway container and exact temp mount.
  docker(['run','--rm','--user','0:0','--entrypoint','/usr/local/bin/node','-v',fixture+':/fixtures',image,'-e',`const fs=require('node:fs');for(const p of ['/fixtures/data','/fixtures/media','/fixtures/owned'])fs.chownSync(p,9033,3036);`]);
  const base=['run','--rm','--user','9033:3036','-e','DATA_DIR=/data','-e','MEDIA_DIR=/media','-v',fixture+'/data:/data','-v',fixture+'/media:/media','-v',fixture+'/owned:/var/tmp/mirea-sandbox-owned'];
  // Deliberately use GUI defaults: writable container root, default bounding caps,
  // no Docker no-new-privileges flag. The unprivileged entrypoint must enforce it.
  const audit=await readFile(new URL('./check-sandbox-runtime.mjs',import.meta.url),'utf8');
  const result=docker([...base,'-i',image,'/usr/local/bin/node','--input-type=module'],{input:audit});
  assert.match(result.stdout,/"sandbox":true/);
  for(const args of [['--user','0:0'],['-e','DATA_DIR=/elsewhere'],['--security-opt','seccomp=unconfined']]) {
    const rejected=docker([...base,...args,image],{success:false});assert.equal(rejected.status,78,rejected.stderr);assert.match(rejected.stderr,/Refusing startup/);
  }
  // Simulate kernels where Landlock is unavailable; initialization MUST NOT run.
  const profile=join(fixture,'deny-landlock.json');
  await writeFile(profile,JSON.stringify({defaultAction:'SCMP_ACT_ALLOW',syscalls:[{names:['landlock_create_ruleset'],action:'SCMP_ACT_ERRNO',errnoRet:38}]}));
  const unsupported=docker([...base,'--security-opt','seccomp='+profile,image],{success:false});assert.equal(unsupported.status,78);assert.match(unsupported.stderr,/Landlock ABI >= 3/);
  assert.equal(await readFile(join(fixture,'owned'),'utf8'),'must remain');
  const descriptors=docker([...base,'--entrypoint','/bin/sh',image,'-c',`exec 9>/tmp/mirea-inherited; exec /usr/local/bin/mirea-launch /usr/local/bin/node -e 'const fs=require("node:fs");for(const n of fs.readdirSync("/proc/self/fd")){let p;try{p=fs.readlinkSync("/proc/self/fd/"+n)}catch(e){if(e.code!=="ENOENT")throw e;}if(p==="/tmp/mirea-inherited")throw Error("inherited descriptor");}'`]);assert.equal(descriptors.status,0);
  console.log(result.stdout.trim());console.log(JSON.stringify({guiDefaultSecurityVerified:true,rootRejected:true,unconfinedRejected:true,unsupportedKernelRejected:true,inheritedDescriptorsClosed:true}));
}finally {
  // Restore only the fixture's ownership so the runner can remove its temp tree.
  docker(['run','--rm','--user','0:0','--entrypoint','/usr/local/bin/node','-v',fixture+':/fixtures',image,'-e',`const fs=require('node:fs');for(const p of ['/fixtures/data','/fixtures/media','/fixtures/owned'])fs.chownSync(p,${process.getuid()},${process.getgid()});`]);
  await rm(fixture,{recursive:true,force:true});
}
