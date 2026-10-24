import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mediaWorkerEntrypoint} from '../server/media.js';
import {PROJECT_ROOT} from '../server/runtime.js';

test('stdin launchers use a fixed ESM worker bootstrap without replacing inherited runtime/permission flags',()=>{
  assert.equal(mediaWorkerEntrypoint([],'').protocol,'file:');
  for(const env of ['--input-type=module','"--input-type=module"','--input-type module'])assert.equal(mediaWorkerEntrypoint([],env).protocol,'data:');
  for(const args of [['--input-type=module'],['--trace-warnings','--input-type','module'],['--input-type=commonjs']]){const entry=mediaWorkerEntrypoint(args);assert.equal(entry.protocol,'data:');assert.match(decodeURIComponent(entry.href),/import "file:.*\/server\/media-worker.js";/);}
});
test('real PDF/image/EPUB workers run under node --input-type=module eval and stdin launchers',async()=>{
  const code=`import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import sharp from 'sharp';import {createMediaProcessor} from './server/media.js';import {makePdf} from './tests/fixtures.js';import {makeEpub} from './tests/epub-fixtures.js';
    const root=await mkdtemp(join(tmpdir(),'mirea-launcher-')),media=createMediaProcessor();try{
      await writeFile(join(root,'book.pdf'),makePdf());assert.equal((await media.thumbnail(join(root,'book.pdf'),'application/pdf',join(root,'pdf.jpg'))).pageCount,1);
      await sharp({create:{width:32,height:48,channels:3,background:'#4466aa'}}).png().toFile(join(root,'page.png'));assert.equal((await media.validateImage(join(root,'page.png'))).width,32);await media.thumbnail(join(root,'page.png'),'image/png',join(root,'image.jpg'));
      await writeFile(join(root,'book.epub'),makeEpub());await media.thumbnail(join(root,'book.epub'),'application/epub+zip',join(root,'epub.jpg'),join(root,'book.json'));
      assert.equal(media.busy,false);console.log('launcher media workers passed');
    }finally{await rm(root,{recursive:true,force:true});}`;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','--eval',code],{cwd:PROJECT_ROOT,windowsHide:true,timeout:30000});assert.match(stdout,/launcher media workers passed/);
  const stdin=await new Promise((resolve,reject)=>{const child=execFile(process.execPath,['--input-type','module'],{cwd:PROJECT_ROOT,windowsHide:true,timeout:30000},(error,stdout)=>error?reject(error):resolve(stdout));child.stdin.end(code);});assert.match(stdin,/launcher media workers passed/);
  const environment=await promisify(execFile)(process.execPath,['--eval',code],{cwd:PROJECT_ROOT,windowsHide:true,timeout:30000,env:{...process.env,NODE_OPTIONS:(process.env.NODE_OPTIONS??'')+' --input-type=module'}});assert.match(environment.stdout,/launcher media workers passed/);
});
