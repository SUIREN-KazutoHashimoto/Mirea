import {cp,mkdir,mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
export async function packageServer({projectRoot=root,outputDirectory=join(root,'releases'),commit}={}){
  if(!/^[0-9a-f]{40}$/.test(commit??''))throw new Error('A full release commit SHA is required (--commit=<sha>)');
  const pkg=JSON.parse(await readFile(join(projectRoot,'package.json'),'utf8'));
  const label=pkg.version.replace('-beta','beta');
  if(!/^[0-9a-z.-]+$/i.test(label))throw new Error('Invalid version');
  const output=resolve(outputDirectory);await mkdir(output,{recursive:true});
  const archive=join(output,`mirea-${label}-server.tar.gz`);
  // No accidental overwrite of an already published/reviewed package.
  await access(archive).then(()=>{throw new Error(`Package already exists: ${archive}`);},error=>{if(error.code!=='ENOENT')throw error;});
  const staging=await mkdtemp(join(output,'.stage-')),name=`mirea-${label}-server`,destination=join(staging,name);
  try{
    await mkdir(destination);
    // Fixed allowlist: never include data, credentials, local deployment files or node_modules.
    for(const path of ['server','dist','docs','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc','.env.example','LICENSE','README.md','RELEASE.md']){
      await cp(join(projectRoot,path),join(destination,path),{recursive:true,errorOnExist:true,force:false});
    }
    await writeFile(join(destination,'release-manifest.json'),JSON.stringify({name:'Mirea',release:label,version:pkg.version,commit},null,2)+'\n');
    execFileSync(process.platform==='win32'?join(process.env.SystemRoot??'C:/Windows','System32','tar.exe'):'tar',['-czf',archive,'-C',staging,name],{windowsHide:true});
    const sha256=createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(`${archive}.sha256`,`${sha256}  ${archive.split(/[\\/]/).at(-1)}\n`);
    return {archive,sha256,commit,version:pkg.version};
  }finally{
    if(!resolve(staging).startsWith(output+sep+'.stage-'))throw new Error('Unsafe staging cleanup target');
    await rm(staging,{recursive:true,force:true});
  }
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  console.log(JSON.stringify(await packageServer({commit:process.argv.find(arg=>arg.startsWith('--commit='))?.slice(9)})));
}
