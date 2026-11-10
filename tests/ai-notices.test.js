import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {aiNotices} from '../server/ai-notices.js';
test('runtime notices list only code license folders and never model files or symbolic links',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mirea-ai-notices-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'llama-cpu','notices'),{recursive:true});await mkdir(join(dir,'notices','dependency'),{recursive:true});await mkdir(join(dir,'models'));
 await writeFile(join(dir,'llama-cpu','LICENSE.runtime'),'Synthetic MIT license');
 await writeFile(join(dir,'llama-cpu','notices','NOTICE'),'Synthetic dependency notice');
 await writeFile(join(dir,'notices','dependency','LICENSE'),'Synthetic dependency terms');
 await writeFile(join(dir,'models','private-model.gguf'),'SYNTHETIC WEIGHTS');
 await writeFile(join(dir,'outside.txt'),'SYNTHETIC PRIVATE FILE');
 await writeFile(join(dir,'notices','server-key.pem'),'SYNTHETIC PRIVATE KEY');
 if(process.platform!=='win32')await symlink(join(dir,'outside.txt'),join(dir,'llama-cpu','notices','linked'));
 const files=await aiNotices(dir);assert.equal(files.length,3);assert(files.every(file=>/^[0-9a-f]{64}$/.test(file.id)));assert(!files.some(file=>/model|outside|linked/.test(file.name)));
});
