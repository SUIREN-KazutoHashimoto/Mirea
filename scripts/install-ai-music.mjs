// Operator/build step. Installs CPU inference code only, never model weights.
import {spawnSync} from 'node:child_process';
import {mkdir,lstat,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
if(!process.argv.includes('--accept-runtime-licenses'))throw Error('Review the AI runtime dependency licenses and pass --accept-runtime-licenses.');
const destination=resolve(arg('destination')??'ai/bin'),folder=join(destination,'music','venv');
const python=arg('python')??(process.platform==='win32'?'python':'python3'),executable=join(folder,process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
const project=fileURLToPath(new URL('../',import.meta.url)),provenance=join(destination,'music','mirea-runtime.json');
const command=(program,args)=>{const result=spawnSync(program,args,{stdio:'inherit',windowsHide:true,shell:false,env:{...process.env,PIP_CONFIG_FILE:process.platform==='win32'?'NUL':'/dev/null',PIP_DISABLE_PIP_VERSION_CHECK:'1',PYTHONDONTWRITEBYTECODE:'1'}});if(result.error||result.status!==0)throw Error('CPU music runtime installation failed');};
await mkdir(join(destination,'music'),{recursive:true});
if(await lstat(provenance).catch(()=>null)){const saved=JSON.parse(await readFile(provenance,'utf8'));if(saved.version!==1||saved.torch!=='2.11.0')throw Error('Review existing runtime before replacing it.');console.log('CPU music runtime is already installed.');process.exit(0);}
if(!await lstat(executable).catch(()=>null))command(python,['-m','venv',folder]);
command(executable,['-m','pip','install','--require-virtualenv','torch==2.11.0','torchaudio==2.11.0','--index-url','https://download.pytorch.org/whl/cpu']);
command(executable,['-m','pip','install','--require-virtualenv','--no-deps','--index-url','https://pypi.org/simple','-r',join(project,'ai/music-requirements.txt')]);
command(executable,[join(project,'ai/collect-notices.py'),join(destination,'notices')]);
await writeFile(provenance,JSON.stringify({version:1,engine:'allinone-cpu',torch:'2.11.0',weightsBundled:false},null,2));
console.log('CPU music inference code installed. Download model weights separately through the administrator model screen.');
