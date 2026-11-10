// Offline model preparation only. Never opens or migrates the application DB.
import {mkdir,readFile,realpath,lstat,open,rename,unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {validateModelManifest} from '../server/ai-models.js';
const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
if(!arg('manifest')||!arg('source')||!arg('data-dir')||!process.argv.includes('--accept-model-terms'))throw Error('Required: --manifest=... --source=... --data-dir=... --accept-model-terms. Review the fixed model license first.');
const manifest=validateModelManifest(JSON.parse(await readFile(resolve(arg('manifest')),'utf8')));
const source=await realpath(resolve(arg('source'))),data=await realpath(resolve(arg('data-dir')));
async function directory(path){await mkdir(path,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Model storage is not a regular directory.');}
async function hash(path){const result=createHash('sha256');for await(const chunk of createReadStream(path))result.update(chunk);return result.digest('hex');}
const ai=join(data,'ai'),models=join(ai,'models'),destination=join(models,manifest.id);
for(const path of [ai,models,destination])await directory(path);
for(const file of manifest.files){
 const input=join(source,file.name),output=join(destination,file.name),info=await lstat(input);
 if(!info.isFile()||info.isSymbolicLink()||info.size!==file.size)throw Error('Source model type or size mismatch: '+file.name);
 const existing=await lstat(output).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
 if(existing){if(existing.isSymbolicLink()||!existing.isFile()||existing.size!==file.size||await hash(output)!==file.sha256)throw Error('Existing model differs; refusing to overwrite: '+file.name);continue;}
 const temporary=output+'.import-'+randomUUID(),handle=await open(temporary,'wx',0o600),checksum=createHash('sha256');let written=0;
 try{for await(const chunk of createReadStream(input)){written+=chunk.length;if(written>file.size)throw Error('Source model changed');checksum.update(chunk);await handle.writeFile(chunk);}await handle.sync();if(written!==file.size||checksum.digest('hex')!==file.sha256)throw Error('Source checksum mismatch: '+file.name);}
 catch(error){await handle.close();await unlink(temporary).catch(()=>{});throw error;}
 await handle.close();await rename(temporary,output);console.log('Verified and prepared '+file.name);
}
console.log('All files verified. In the AI model screen, register this manifest as a local model. No network request or application database change was performed.');
