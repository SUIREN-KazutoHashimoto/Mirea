// A separate, serialized job: NEVER move a tracking tag while the release is a
// draft or its original build/publish workflow is still in progress.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {repository,registryImage,newestPublishedBeta,validatePromotion,validateChannelAdvance} from './container-channel-policy.mjs';

const {GITHUB_ACTIONS,GITHUB_EVENT_NAME,GITHUB_REPOSITORY,GITHUB_EVENT_PATH,GH_TOKEN}=process.env;
assert(GITHUB_ACTIONS==='true'&&GITHUB_REPOSITORY===repository&&GH_TOKEN&&['release','workflow_dispatch'].includes(GITHUB_EVENT_NAME),'Unexpected channel publication context');
const event=JSON.parse(await readFile(GITHUB_EVENT_PATH,'utf8'));
async function request(url,options={}){const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000),...options});if(!r.ok)throw Error('Release/channel request failed ('+r.status+')');return r;}
async function api(path){return (await request('https://api.github.com'+path,{headers:{authorization:'Bearer '+GH_TOKEN,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'}})).json();}
const releases=await api('/repos/'+repository+'/releases?per_page=100'),latest=newestPublishedBeta(releases);
assert(latest,'No published beta release');
const requestedTag=GITHUB_EVENT_NAME==='release'?event.release?.tag_name:event.inputs?.tag;
assert(requestedTag,'Missing release tag');
if(requestedTag!==latest.tag_name){console.log(JSON.stringify({skipped:true,reason:'A newer public beta exists',requestedTag,latestTag:latest.tag_name}));process.exit(0);}
const release=await api('/repos/'+repository+'/releases/'+latest.id);
let ref=await api('/repos/'+repository+'/git/ref/tags/'+encodeURIComponent(release.tag_name));
if(ref.object.type==='tag')ref={object:(await api('/repos/'+repository+'/git/tags/'+ref.object.sha)).object};
assert(ref.object.type==='commit','Tag must resolve to one commit');const commit=ref.object.sha;
const asset=release.assets.find(a=>a.name==='mirea-'+release.tag_name.slice(1)+'-container.json');assert(asset?.state==='uploaded'&&asset.size<65536,'Missing bounded image metadata');
let response=await fetch('https://api.github.com/repos/'+repository+'/releases/assets/'+asset.id,{headers:{authorization:'Bearer '+GH_TOKEN,accept:'application/octet-stream'},redirect:'manual',signal:AbortSignal.timeout(30000)});
if(response.status===302){const target=new URL(response.headers.get('location'));assert(target.protocol==='https:'&&['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(target.hostname));response=await request(target);}
assert(response.ok);const bytes=Buffer.from(await response.arrayBuffer());assert(bytes.length<65536);const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');assert.equal(hash(bytes),asset.digest);
const metadata=JSON.parse(bytes),runs=(await api('/repos/'+repository+'/actions/workflows/verify.yml/runs?head_sha='+commit+'&event=push&per_page=100')).workflow_runs;
const lastRun=branch=>runs.filter(r=>r.head_branch===branch).sort((a,b)=>b.id-a.id)[0];
const tagRun=lastRun(release.tag_name);assert(tagRun?.id,'Tag CI missing');
const tagJobs=(await api('/repos/'+repository+'/actions/runs/'+tagRun.id+'/jobs?filter=latest&per_page=100')).jobs;
const plan=validatePromotion({release,latestRelease:latest,commit,metadata,developRun:lastRun('develop'),tagRun,tagJobs});
const path=repository.toLowerCase();
// The short-lived Actions token is sent only to GitHub and GHCR over verified
// HTTPS; it is never stored, passed as a CLI argument, or printed.
const access=await request('https://ghcr.io/token?service=ghcr.io&scope=repository:'+path+':pull,push',{headers:{authorization:'Basic '+Buffer.from(repository.split('/')[0]+':'+GH_TOKEN).toString('base64')}});
const registryToken=(await access.json()).token;assert(registryToken,'Registry authorization failed');
const accept='application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
async function registry(part,{missing=false,blob=false}={}){
 let r=await fetch('https://ghcr.io/v2/'+path+part,{headers:{authorization:'Bearer '+registryToken,accept},redirect:'manual',signal:AbortSignal.timeout(30000)});
 if(blob&&[301,302,307,308].includes(r.status)){const target=new URL(r.headers.get('location'));assert(target.protocol==='https:'&&['pkg-containers.githubusercontent.com','ghcr.io'].includes(target.hostname));r=await request(target);}
 if(missing&&r.status===404)return null;assert.equal(r.status,200,'Registry read failed');const b=Buffer.from(await r.arrayBuffer());assert(b.length<1024*1024,'Registry metadata too large');return {bytes:b,type:r.headers.get('content-type')?.split(';')[0],digest:r.headers.get('docker-content-digest')};
}
const manifest=await registry('/manifests/'+plan.digestReference.split('@')[1]);
assert.equal(hash(manifest.bytes),plan.digestReference.split('@')[1]);assert.equal(manifest.digest,hash(manifest.bytes));assert(accept.split(', ').includes(manifest.type),'Only the exact single-platform tested manifest may be promoted');
const image=JSON.parse(manifest.bytes);assert.equal(image.config.digest,plan.imageId);
const config=await registry('/blobs/'+image.config.digest,{blob:true});assert.equal(hash(config.bytes),plan.imageId);const c=JSON.parse(config.bytes);
assert(c.os==='linux'&&c.architecture==='amd64'&&c.config.User==='1000:1000');assert.equal(c.config.Labels['org.opencontainers.image.revision'],commit);assert.equal(c.config.Labels['org.opencontainers.image.version'],plan.version);
const old=await registry('/manifests/beta',{missing:true});
if(old){const oldManifest=JSON.parse(old.bytes),oldConfig=await registry('/blobs/'+oldManifest.config.digest,{blob:true});assert.equal(hash(oldConfig.bytes),oldManifest.config.digest);const previous=JSON.parse(oldConfig.bytes);validateChannelAdvance({version:previous.config.Labels['org.opencontainers.image.version'],digestReference:registryImage+'@'+hash(old.bytes)},plan);}
await request('https://ghcr.io/v2/'+path+'/manifests/beta',{method:'PUT',headers:{authorization:'Bearer '+registryToken,'content-type':manifest.type},body:manifest.bytes});
const checked=await registry('/manifests/beta');assert.deepEqual(checked.bytes,manifest.bytes);assert.equal(checked.digest,hash(manifest.bytes));
console.log(JSON.stringify({success:true,...plan,publicRelease:release.html_url,exactTestedManifestPromoted:true,automaticNasRestart:false}));
