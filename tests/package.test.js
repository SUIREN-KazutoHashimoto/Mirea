import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {packageServer} from '../scripts/package-server.mjs';

test('server release package records its exact commit and includes only the fixed safe allowlist',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'mirea-package-')),source=join(folder,'source'),output=join(folder,'output');
  t.after(()=>rm(folder,{recursive:true,force:true}));await mkdir(source);
  for(const path of ['server','dist','docs','data','node_modules','.local']){await mkdir(join(source,path));await writeFile(join(source,path,'test.txt'),path);}
  for(const path of ['pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc','.env.example','LICENSE','README.md','RELEASE.md','.env'])await writeFile(join(source,path),path);
  await writeFile(join(source,'package.json'),JSON.stringify({name:'mirea',version:'0.1.0-beta'}));
  const commit='a'.repeat(40),result=await packageServer({projectRoot:source,outputDirectory:output,commit});
  assert.equal(result.sha256,createHash('sha256').update(await readFile(result.archive)).digest('hex'));
  const listing=execFileSync(process.platform==='win32'?join(process.env.SystemRoot,'System32','tar.exe'):'tar',['-tzf',result.archive],{encoding:'utf8',windowsHide:true});
  assert.match(listing,/release-manifest.json/);assert.match(listing,/dist\/test.txt/);
  assert.doesNotMatch(listing,/\/(?:data|node_modules|\.local)\//);assert.doesNotMatch(listing,/\/\.env\r?\n/);
  await assert.rejects(packageServer({projectRoot:source,outputDirectory:output,commit}),/already exists/);
  await assert.rejects(packageServer({projectRoot:source,outputDirectory:output,commit:'main'}),/full release commit/);
});
