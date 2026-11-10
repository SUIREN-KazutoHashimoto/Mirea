// Explicit operator/build step. Compiles code only; never downloads weights.
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,cp,readdir,readFile,writeFile,lstat,rm} from 'node:fs/promises';
import {tmpdir,availableParallelism} from 'node:os';
import {resolve,join,sep,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../',import.meta.url)),versions=JSON.parse(await readFile(join(project,'ai/runtime-versions.json'),'utf8'));
const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
if(!process.argv.includes('--accept-runtime-licenses'))throw Error('Review the MIT licenses of llama.cpp and whisper.cpp and pass --accept-runtime-licenses.');
const backend=arg('backend')??'cpu',destination=resolve(arg('destination')??'ai/bin');
if(!['cpu','vulkan','both'].includes(backend))throw Error('Select CPU, Vulkan, or both.');
const jobs=Math.min(16,availableParallelism()),work=await mkdtemp(join(tmpdir(),'mirea-ai-build-'));
const command=(program,args,cwd)=>{const result=spawnSync(program,args,{cwd,stdio:'inherit',windowsHide:true,shell:false});if(result.error||result.status!==0)throw Error('AI runtime build command failed: '+program);};
try{
 await mkdir(destination,{recursive:true});
 if(process.platform==='linux')command('cc',['-std=c11','-O2','-Wall','-Wextra','-Werror','-D_FORTIFY_SOURCE=2','-fstack-protector-strong','-fPIE','-pie','-Wl,-z,relro,-z,now','-o',join(destination,'mirea-ai-exec'),join(project,'ai/executor.c')],work);
 for(const [engine,version]of Object.entries(versions)){
  const source=join(work,engine);await mkdir(source);command('git',['init','--quiet'],source);command('git',['remote','add','origin','https://github.com/'+version.repo+'.git'],source);
  command('git',['config','core.sparseCheckout','true'],source);await mkdir(join(source,'.git','info'),{recursive:true});await writeFile(join(source,'.git','info','sparse-checkout'),'/*\n!/models/\n!/tests/\n');
   command('git',['-c','advice.detachedHead=false','fetch','--filter=blob:none','--depth=1','origin',version.commit],source);
  command('git',['-c','advice.detachedHead=false','checkout','--detach','FETCH_HEAD'],source);
  const actual=spawnSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8',windowsHide:true});if(actual.status!==0||actual.stdout.trim()!==version.commit)throw Error('Runtime commit mismatch');
  for(const variant of backend==='both'?['cpu','vulkan']:[backend]){
   const folder=engine==='llama'?'llama-'+variant:variant==='cpu'?'whisper':'whisper-vulkan',target=join(destination,folder);
   if(await lstat(target).catch(()=>null)){const info=JSON.parse(await readFile(join(target,'mirea-runtime.json'),'utf8'));if(info.commit===version.commit&&info.backend===variant){console.log('Verified installed runtime '+folder);continue;}throw Error('Existing runtime differs; install into a new destination and review before switching.');}
   const build=join(work,folder),flags=['-S',source,'-B',build,'-DCMAKE_BUILD_TYPE=Release','-DGGML_NATIVE=OFF','-DGGML_VULKAN='+(variant==='vulkan'?'ON':'OFF'),'-DGGML_OPENMP=ON','-DBUILD_SHARED_LIBS=ON','-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON','-DCMAKE_INSTALL_RPATH=$ORIGIN','-DGGML_CPU_ALL_VARIANTS=ON','-DGGML_BACKEND_DL=ON'];
   if(engine==='llama')flags.push('-DLLAMA_BUILD_TESTS=OFF','-DLLAMA_BUILD_EXAMPLES=ON','-DLLAMA_BUILD_TOOLS=ON','-DLLAMA_BUILD_SERVER=ON','-DLLAMA_BUILD_APP=OFF','-DLLAMA_BUILD_UI=OFF','-DLLAMA_USE_PREBUILT_UI=OFF','-DLLAMA_CONNECT=OFF','-DLLAMA_OPENSSL=OFF','-DLLAMA_SUBPROCESS=OFF');
   else flags.push('-DWHISPER_BUILD_TESTS=OFF','-DWHISPER_BUILD_EXAMPLES=ON','-DWHISPER_BUILD_SERVER=OFF','-DWHISPER_CURL=OFF');
   command('cmake',flags,work);command('cmake',['--build',build,'--config','Release','--target',engine==='llama'?'llama-server':'whisper-cli','--parallel',String(jobs)],work);
   const stage=join(destination,folder+'-staging');if(await lstat(stage).catch(()=>null))throw Error('Incomplete staging directory exists; inspect before retrying.');await mkdir(stage);
   const bin=join(build,'bin',process.platform==='win32'?'Release':'');
   for(const file of await readdir(bin,{withFileTypes:true}))if(file.isFile()||file.isSymbolicLink())await cp(join(bin,file.name),join(stage,file.name),{dereference:true});
   async function libraries(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const file=join(directory,entry.name);if(entry.isDirectory()&&!['CMakeFiles','.git'].includes(entry.name))await libraries(file);else if((entry.isFile()||entry.isSymbolicLink())&&/^(?:lib)?(?:llama|whisper|ggml.*|mtmd).*\.(?:so(?:\.\d+)*|dylib|dll)$/i.test(entry.name))await cp(file,join(stage,entry.name),{dereference:true});}}
    await libraries(build);
    const noticeRoot=join(stage,'notices');await mkdir(noticeRoot);let notice=0;
    async function notices(directory){for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.name==='.git')continue;const file=join(directory,entry.name);if(entry.isDirectory())await notices(file);else if(entry.isFile()&&/^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-].*)?$/i.test(entry.name))await cp(file,join(noticeRoot,String(++notice)+'-'+basename(file)));}}
    await notices(source);
    // Windows binary installers use a Release folder for whisper.
   if(engine==='whisper'&&process.platform==='win32'){await mkdir(join(stage,'Release'));for(const file of await readdir(stage))if(file!=='Release')await cp(join(stage,file),join(stage,'Release',file),{dereference:true});}
   await cp(join(source,'LICENSE'),join(stage,'LICENSE.runtime'));await writeFile(join(stage,'mirea-runtime.json'),JSON.stringify({...version,backend:variant,version:1},null,2));
   const {rename}=await import('node:fs/promises');await rename(stage,target);console.log('Built verified '+version.repo+' '+variant);
  }
 }
}finally{if(!resolve(work).startsWith(resolve(tmpdir())+sep+'mirea-ai-build-'))throw Error('Unsafe build cleanup target');await rm(work,{recursive:true,force:true});}
