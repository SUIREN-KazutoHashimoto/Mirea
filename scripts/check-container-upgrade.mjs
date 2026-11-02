// GitHub CI only: immutable published image -> candidate -> restored old image.
// All state belongs to fresh synthetic projects; no existing volume is adopted.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,open,unlink,rm} from 'node:fs/promises';
import {dirname,join,resolve,sep,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import pkg from '../package.json' with {type:'json'};
import {upgradeBaseline,verifyUpgradeBaseline,upgradeProjects,ownedUpgradeVolume,restoredUpgradeConfig} from './container-upgrade-policy.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url))),plans=upgradeProjects(process.env);
assert(process.platform==='linux','Run the container rehearsal on the isolated Linux CI runner');
assert(process.env.RUNNER_TEMP,'RUNNER_TEMP is required');const temporary=resolve(process.env.RUNNER_TEMP),base=process.env.COMPOSE_PROJECT_NAME;
const tracker=join(temporary,base+'-upgrade-ownership.json'),candidate='mirea:ci';
const allowed=new Set(plans.flatMap(plan=>[plan.source,plan.restored]));
const json=bytes=>JSON.parse(Buffer.isBuffer(bytes)?bytes.toString('utf8'):bytes);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const filesFor=plan=>[join(root,'compose.yaml'),...(plan.layout==='separated'?[join(root,'compose.storage.yaml')]:[])];
const environment=(project,files,image,port,version)=>({...process.env,COMPOSE_PROJECT_NAME:project,COMPOSE_FILE:files.join(delimiter),MIREA_IMAGE:image,HOST:'127.0.0.1',PORT:String(port),MIREA_FIXTURE_PORT:String(port),MIREA_FIXTURE_VERSION:version});
function docker(args,{env=process.env,stdin='ignore',stdout='pipe'}={}){return execFileSync('docker',args,{cwd:root,env,stdio:[stdin,stdout,'pipe'],maxBuffer:16*1024*1024,timeout:10*60000,windowsHide:true});}
function compose(env,...args){return docker(['compose',...args],{env});}
async function inspectVolume(name){try{return json(docker(['volume','inspect',name]))[0];}catch(error){if(String(error.stderr).includes('no such volume'))return null;throw error;}}
const logicalVolumes=plan=>['mirea-data',...(plan.layout==='separated'?['mirea-media']:[])];
async function pristine(project,plan){
  assert(!docker(['ps','-aq','--filter','label=com.docker.compose.project='+project]).toString().trim(),'Refusing an existing container project');
  assert(!docker(['volume','ls','-q','--filter','label=com.docker.compose.project='+project]).toString().trim(),'Refusing existing project volumes');
  for(const logical of logicalVolumes(plan))assert.equal(await inspectVolume(project+'_'+logical),null,'Refusing an existing storage volume');
}
function stopped(env){
  compose(env,'stop','--timeout','120');
  assert(!docker(['ps','-q','--filter','label=com.docker.compose.project='+env.COMPOSE_PROJECT_NAME]).toString().trim(),'Source must be stopped before backup');
}
function fixture(mode,env){const result=execFileSync(process.execPath,[join(root,'scripts/check-container.mjs'),mode],{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:3*60000,maxBuffer:1024*1024});process.stdout.write(result);}
const helper=(volume,readOnly,entrypoint)=>['run','--rm','--interactive','--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',`type=volume,source=${volume},target=/data${readOnly?',readonly':''}`,'--entrypoint',entrypoint,upgradeBaseline.digestReference];
let ownership;
async function claim(project,plan){await pristine(project,plan);ownership.projects.push(project);await writeFile(tracker,JSON.stringify(ownership),{mode:0o600});}
async function cleanup(){
  let stored;try{stored=json(await readFile(tracker));}catch(error){if(error.code==='ENOENT')return;throw error;}
  assert(Array.isArray(stored.projects)&&stored.projects.every(project=>allowed.has(project)),'Unknown cleanup project');
  assert(resolve(stored.work).startsWith(temporary+sep+base+'-upgrade-'),'Unsafe fixture work directory');
  for(const project of stored.projects){
    const plan=plans.find(p=>p.source===project||p.restored===project),env=environment(project,filesFor(plan),candidate,plan.port,pkg.version);
    // down deliberately omits -v. Each explicitly owned volume is validated
    // below before removal; unrelated or external volumes are never touched.
    compose(env,'down');
    for(const logical of logicalVolumes(plan)){
      const info=await inspectVolume(project+'_'+logical);if(!info)continue;
      const name=ownedUpgradeVolume(info,project,logical);
      assert(!docker(['ps','-q','--filter','volume='+name]).toString().trim(),'Volume is still mounted by a running container');
      docker(['volume','rm',name]);
    }
    await unlink(join(temporary,project+'.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  await rm(stored.work,{recursive:true,force:true});await unlink(tracker);
}
if(process.argv.includes('--cleanup'))await cleanup();
else{
  const response=await fetch(upgradeBaseline.metadataUrl,{signal:AbortSignal.timeout(30000)});assert(response.ok,'Published baseline metadata is unavailable');
  const text=await response.text();assert(Buffer.byteLength(text)<65536,'Oversized baseline metadata');verifyUpgradeBaseline(json(text));
  docker(['pull','--platform','linux/amd64',upgradeBaseline.digestReference]);
  const old=json(docker(['image','inspect',upgradeBaseline.digestReference]))[0],current=json(docker(['image','inspect',candidate]))[0];
  for(const [image,version,commit]of [[old,upgradeBaseline.version,upgradeBaseline.commit],[current,pkg.version,process.env.GITHUB_SHA]]){
    assert.equal(image.Os,'linux');assert.equal(image.Architecture,'amd64');assert.equal(image.Config.User,'1000:1000');assert.equal(image.Config.Labels['org.opencontainers.image.version'],version);assert.equal(image.Config.Labels['org.opencontainers.image.revision'],commit);
  }
  const work=await mkdtemp(join(temporary,base+'-upgrade-'));ownership={work,projects:[]};
  await writeFile(tracker,JSON.stringify(ownership),{flag:'wx',mode:0o600});
  try{
    for(const plan of plans){
      const files=filesFor(plan),env=environment(plan.source,files,upgradeBaseline.digestReference,plan.port,upgradeBaseline.version);
      await claim(plan.source,plan);compose(env,'up','-d','--wait','--wait-timeout','180','--no-build','--pull','never');fixture('prepare',env);stopped(env);
      const backup=join(work,plan.layout);await mkdir(backup,{mode:0o700});
      const config=compose(env,'config','--format','json');await writeFile(join(backup,'compose-resolved.json'),config,{mode:0o600,flag:'wx'});
      for(const file of files)await writeFile(join(backup,file.endsWith('compose.storage.yaml')?'compose.storage.yaml':'compose.yaml'),await readFile(file),{mode:0o600,flag:'wx'});
      const fixtureState=await readFile(join(temporary,plan.source+'.json'));await writeFile(join(backup,'fixture.json'),fixtureState,{mode:0o600,flag:'wx'});
      const archives=[];
      for(const logical of logicalVolumes(plan)){
        const name=ownedUpgradeVolume(await inspectVolume(plan.source+'_'+logical),plan.source,logical),path=join(backup,logical+'.tar');
        assert(!docker(['ps','-q','--filter','volume='+name]).toString().trim(),'Backup requires stopped storage');
        const output=await open(path,'wx',0o600);try{docker([...helper(name,true,'/bin/tar'),'--format=pax','--numeric-owner','-cpf','-','-C','/data','.'],{stdout:output.fd});}finally{await output.close();}
        archives.push({logical,path,sha256:hash(await readFile(path))});
      }
      const next={...env,MIREA_IMAGE:candidate,MIREA_FIXTURE_VERSION:pkg.version};compose(next,'up','-d','--force-recreate','--wait','--wait-timeout','180','--no-build','--pull','never');fixture('verify',next);stopped(next);
      await claim(plan.restored,plan);
      for(const archive of archives){
        assert.equal(hash(await readFile(archive.path)),archive.sha256,'Stopped backup changed');
        const name=plan.restored+'_'+archive.logical;
        docker(['volume','create','--label','com.docker.compose.project='+plan.restored,'--label','com.docker.compose.volume='+archive.logical,name]);
        ownedUpgradeVolume(await inspectVolume(name),plan.restored,archive.logical);
        // Mount initialization copies the image's empty, uid 1000 /data root.
        // This helper needs neither root nor extra capabilities for extraction.
        docker([...helper(name,false,'/usr/local/bin/node'),'-e',"if(require('node:fs').readdirSync('/data').length)throw Error('Restore volume must be empty')"]);
        const input=await open(archive.path,'r');try{docker([...helper(name,false,'/bin/tar'),'--no-same-owner','-xpf','-','-C','/data'],{stdin:input.fd});}finally{await input.close();}
      }
      const savedConfig=await readFile(join(backup,'compose-resolved.json'));assert.equal(hash(savedConfig),hash(config),'Stopped configuration backup changed');
      const restoredFile=join(backup,'compose-restored.json');await writeFile(restoredFile,JSON.stringify(restoredUpgradeConfig(json(savedConfig),plan.restored,plan.restorePort)),{mode:0o600,flag:'wx'});
      const restored=environment(plan.restored,[restoredFile],upgradeBaseline.digestReference,plan.restorePort,upgradeBaseline.version);
      await writeFile(join(temporary,plan.restored+'.json'),fixtureState,{mode:0o600,flag:'wx'});
      compose(restored,'up','-d','--wait','--wait-timeout','180','--no-build','--pull','never');fixture('verify',restored);stopped(restored);
      console.log(JSON.stringify({success:true,layout:plan.layout,publishedBaseline:upgradeBaseline.tag,digestPinned:true,candidate:pkg.version,oldToCandidate:true,stoppedFullStorageAndConfigurationBackup:true,restoredIntoEmptyVolumes:true,rollbackToPublishedImage:true,existingDownloadKeyPreserved:true}));
    }
    assert.equal(json(docker(['image','inspect',candidate]))[0].Id,current.Id,'The tested candidate image changed');
  }finally{await cleanup();}
}
