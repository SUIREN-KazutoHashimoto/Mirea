// Operator-run maintenance. No weights are downloaded by this installer.
import {mkdir,writeFile,readFile,rename,lstat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {pipeline} from 'node:stream/promises';
import yauzl from 'yauzl';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const arg=name=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3);
if(!process.argv.includes('--accept-runtime-licenses'))
  throw Error('Review the llama.cpp and whisper.cpp MIT licenses, then pass --accept-runtime-licenses.');
if(process.platform!=='win32'||process.arch!=='x64'||process.argv.includes('--source')){
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./build-ai-engines.mjs',import.meta.url)),...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});if(result.error||result.status!==0)throw Error('Runtime source build failed');process.exit(0);
}
const backend=arg('backend')??'cpu';
if(!['cpu','vulkan','both'].includes(backend))throw Error('Unsupported backend');
const destination=resolve(arg('destination')??'ai/bin');
const packages=[
  ...(backend==='both'?['cpu','vulkan']:[backend]).map(value=>({repo:'ggml-org/llama.cpp',tag:'b12211',name:'llama-b12211-bin-win-'+value+'-x64.zip',folder:'llama-'+value})),
  {repo:'ggml-org/whisper.cpp',tag:'b5454',name:'whisper-bin-x64.zip',folder:'whisper'}
];
async function extract(archive,output) {
  await mkdir(output,{recursive:true});
  const zip=await new Promise((yes,no)=>yauzl.open(archive,{lazyEntries:true},(e,z)=>e?no(e):yes(z)));
  await new Promise((yes,no)=>{
    zip.on('error',no);zip.on('end',yes);
    zip.on('entry',entry=>{
      const name=entry.fileName.replaceAll('\\','/');
      if(isAbsolute(name)||name.includes(':')||name.split('/').some(part=>part==='..'||/[. ]$/.test(part))||
        ((entry.externalFileAttributes>>>16)&0o170000)===0o120000||
        entry.uncompressedSize>256*1024*1024) {zip.close();no(Error('Unsafe runtime archive'));return;}
      const target=join(output,name);
      if(name.endsWith('/')){mkdir(target,{recursive:true}).then(()=>zip.readEntry(),no);return;}
      mkdir(dirname(target),{recursive:true}).then(()=>new Promise((done,fail)=>{
        zip.openReadStream(entry,(error,stream)=>{
          if(error){fail(error);return;}
          pipeline(stream,createWriteStream(target,{flags:'wx'})).then(done,fail);
        });
      })).then(()=>zip.readEntry(),no);
    });
    zip.readEntry();
  });
}
await mkdir(destination,{recursive:true});
for(const item of packages) {
  const target=join(destination,item.folder);
  if(await lstat(target).catch(()=>null)){const saved=JSON.parse(await readFile(join(target,'mirea-runtime.json'),'utf8'));if(saved.repo!==item.repo||saved.tag!==item.tag||saved.name!==item.name||saved.version!==1)throw Error('Installed runtime provenance differs; inspect before replacing.');await readFile(join(target,'LICENSE.runtime'));console.log('Verified installed runtime: '+item.folder);continue;}
  const metadata=await fetch('https://api.github.com/repos/'+item.repo+'/releases/tags/'+item.tag);
  if(!metadata.ok)throw Error('Runtime release metadata unavailable');
  const release=await metadata.json(),asset=release.assets.find(a=>a.name===item.name);
  if(!asset||!/^sha256:[0-9a-f]{64}$/.test(asset.digest??''))throw Error('Runtime integrity metadata missing');
  const response=await fetch(asset.browser_download_url,{signal:AbortSignal.timeout(300000)});
  if(!response.ok)throw Error('Runtime download failed');
  const bytes=Buffer.from(await response.arrayBuffer());
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==asset.size||'sha256:'+sha256!==asset.digest)throw Error('Runtime checksum mismatch');
  const archive=join(destination,item.name),stage=join(destination,item.folder+'-staging');
  await writeFile(archive,bytes,{flag:'wx'});await extract(archive,stage);
  await writeFile(join(stage,'mirea-runtime.json'),JSON.stringify({...item,sha256,version:1},null,2));
  const license=await fetch('https://raw.githubusercontent.com/'+item.repo+'/'+item.tag+'/LICENSE');
  if(!license.ok)throw Error('Runtime license unavailable');
  await writeFile(join(stage,'LICENSE.runtime'),await license.text());
  await rename(stage,target);
  console.log('Installed '+item.repo+' '+item.tag+' '+backend+' (SHA-256 verified)');
}
