// Runs ONLY after all three named verification jobs have formally succeeded.
// Promotes their exact tested image. Never rebuilds or overwrites a release tag.
import {execFileSync,spawn} from 'node:child_process';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {createGzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {join,basename} from 'node:path';
import assert from 'node:assert/strict';
import pkg from '../package.json' with {type:'json'};

const {GITHUB_ACTIONS,GITHUB_EVENT_NAME,GITHUB_REF_TYPE,GITHUB_REF_NAME:tag,GITHUB_SHA:sha,GITHUB_REPOSITORY:repository,RUNNER_TEMP:folder,GH_TOKEN:token}=process.env;
const version=pkg.version.replace('-beta','beta'),image='ghcr.io/'+(repository??'').toLowerCase();
assert(GITHUB_ACTIONS==='true'&&GITHUB_EVENT_NAME==='push'&&GITHUB_REF_TYPE==='tag'&&tag==='v'+version&&/^\d+\.\d+\.\d+beta$/.test(version)&&/^[0-9a-f]{40}$/.test(sha)&&repository==='SUIREN-KazutoHashimoto/Mirea'&&folder&&token,'Unexpected release context');
async function api(path,method='GET',body){
 const r=await fetch('https://api.github.com'+path,{method,redirect:'error',headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 if(r.status===404)return null;if(!r.ok)throw Error('GitHub request failed ('+r.status+')');return r.json();
}
const compare=await api(`/repos/${repository}/compare/${sha}...develop`);assert(['ahead','identical'].includes(compare?.status),'Release commit must belong to develop');
const runs=await api(`/repos/${repository}/actions/workflows/verify.yml/runs?head_sha=${sha}&event=push&per_page=100`);
assert(runs.workflow_runs.some(r=>r.head_sha===sha&&r.head_branch==='develop'&&r.status==='completed'&&r.conclusion==='success'),'Formal successful develop CI is required before publishing');
function docker(args,options={}){try{return execFileSync('docker',args,{encoding:'utf8',maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe'],...options}).trim();}catch(error){throw Error('Docker '+args[0]+' failed ('+error.status+')');}}
docker(['load','-i',join(folder,'mirea-container-tested.tar.gz')]);
const [tested]=JSON.parse(docker(['image','inspect','mirea:ci']));assert.equal(tested.Config.User,'1000:1000');assert.equal(tested.Os,'linux');assert.equal(tested.Architecture,'amd64');assert.equal(tested.Config.Labels['org.opencontainers.image.revision'],sha);assert.equal(tested.Config.Labels['org.opencontainers.image.version'],pkg.version);
docker(['login','ghcr.io','--username',repository.split('/')[0],'--password-stdin'],{input:token});
const packageInfo=await api(`/users/${repository.split('/')[0]}/packages/container/mirea`);
for(const name of [version,'sha-'+sha]){
 const ref=image+':'+name;let existing=false;
 try{execFileSync('docker',['manifest','inspect',ref],{stdio:['ignore','pipe','pipe'],encoding:'utf8'});existing=true;}catch(error){const diagnostic=String(error.stderr??'');if(packageInfo!==null&&!/manifest unknown|no such manifest|not found/i.test(diagnostic))throw Error('Cannot safely check existing image tag');}
 if(existing){docker(['pull',ref]);const [old]=JSON.parse(docker(['image','inspect',ref]));assert.equal(old.Id,tested.Id,'Refusing to overwrite a different image under an existing tag');}
 else{docker(['tag','mirea:ci',ref]);docker(['push','--quiet',ref]);}
}
const [published]=JSON.parse(docker(['image','inspect',image+':'+version])),digestRef=published.RepoDigests.find(r=>r.startsWith(image+'@sha256:'));assert(digestRef,'Registry digest unavailable');assert.equal(published.Id,tested.Id);
const archive=join(folder,`mirea-${version}-container-linux-amd64.tar.gz`),child=spawn('docker',['save',image+':'+version,image+':sha-'+sha],{stdio:['ignore','pipe','pipe']});let diagnostic='';child.stderr.on('data',b=>{diagnostic+=b;if(diagnostic.length>4096)diagnostic=diagnostic.slice(-4096);});
const completed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('Container export failed')));});await Promise.all([pipeline(child.stdout,createGzip({mtime:0}),createWriteStream(archive,{flags:'wx'})),completed]);
async function hashFile(path){const h=createHash('sha256');for await(const bytes of createReadStream(path))h.update(bytes);return h.digest('hex');}
const sha256=await hashFile(archive);await writeFile(archive+'.sha256',sha256+'  '+basename(archive)+'\n');
const metadata=join(folder,`mirea-${version}-container.json`);await writeFile(metadata,JSON.stringify({schemaVersion:1,version:pkg.version,tag,commit:sha,image:image+':'+version,digestReference:digestRef,imageId:tested.Id,platform:'linux/amd64',testedImagePromoted:true,nonRoot:'1000:1000',readOnlyRoot:true,dataPath:'/data',containerRecreationAndEncryptionVerified:true,archive:basename(archive),archiveSha256:sha256,workflow:`https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`},null,2)+'\n');await writeFile(metadata+'.sha256',(await hashFile(metadata))+'  '+basename(metadata)+'\n');
let release=await api(`/repos/${repository}/releases/tags/${tag}`);if(!release)release=await api(`/repos/${repository}/releases`,'POST',{tag_name:tag,target_commitish:sha,name:version,draft:true,prerelease:true,body:'Release preparation in progress. The exact verified container image is attached; publication requires final verification.'});assert(release.draft,'Never change an already published release');
for(const file of [archive,archive+'.sha256',metadata,metadata+'.sha256']){
 const digest='sha256:'+(await hashFile(file)),old=release.assets.find(a=>a.name===basename(file));if(old){assert.equal(old.digest,digest,'Existing draft asset differs');continue;}
 const size=(await stat(file)).size,response=await fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(basename(file))}`,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/octet-stream','content-length':String(size)},body:Readable.toWeb(createReadStream(file)),duplex:'half',signal:AbortSignal.timeout(900000)});if(!response.ok)throw Error('Release asset upload failed ('+response.status+')');const asset=await response.json();assert.equal(asset.digest,digest);console.log(JSON.stringify({uploaded:asset.name,size:asset.size,sha256:digest}));
}
console.log(JSON.stringify({success:true,image:image+':'+version,digestReference:digestRef,commit:sha,draftRelease:true,registryVisibilityMustBeVerified:true,testedImageId:tested.Id}));
