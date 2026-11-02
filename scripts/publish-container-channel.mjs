// A separate, serialized job: NEVER move a tracking tag while the release is a
// draft or its original build/publish workflow is still in progress.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {repository,registryImage,releaseVersion,newestPublishedRelease,validatePromotion,validateChannelAdvance} from './container-channel-policy.mjs';
import {imageAccept,platformImageDescriptor,verifyTestedImageIdentity} from './container-image-policy.mjs';

const {GITHUB_ACTIONS,GITHUB_EVENT_NAME,GITHUB_REPOSITORY,GITHUB_EVENT_PATH,GH_TOKEN}=process.env;
assert(GITHUB_ACTIONS==='true'&&GITHUB_REPOSITORY===repository&&GH_TOKEN&&['release','workflow_dispatch'].includes(GITHUB_EVENT_NAME),'Unexpected channel publication context');
const event=JSON.parse(await readFile(GITHUB_EVENT_PATH,'utf8'));
async function request(url,options={}){const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000),...options});if(!r.ok)throw Error('Release/channel request failed ('+r.status+')');return r;}
async function api(path){return (await request('https://api.github.com'+path,{headers:{authorization:'Bearer '+GH_TOKEN,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'}})).json();}
const requestedTag=GITHUB_EVENT_NAME==='release'?event.release?.tag_name:event.inputs?.tag;
assert(requestedTag,'Missing release tag');
const channel=releaseVersion(requestedTag).channel;
// Read all pages: GitHub orders by publication date, not semantic version or channel.
const releases=[];for(let page=1;;page++){assert(page<=100,'Release history exceeds safe pagination limit');const values=await api('/repos/'+repository+'/releases?per_page=100&page='+page);releases.push(...values);if(values.length<100)break;}
const latest=newestPublishedRelease(releases,channel);assert(latest,'No published '+channel+' release');
if(requestedTag!==latest.tag_name){console.log(JSON.stringify({skipped:true,reason:'A newer public release exists in this channel',channel,requestedTag,latestTag:latest.tag_name}));process.exit(0);}
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
const accept=imageAccept;
async function registry(part,{missing=false,blob=false}={}){
 let r=await fetch('https://ghcr.io/v2/'+path+part,{headers:{authorization:'Bearer '+registryToken,accept},redirect:'manual',signal:AbortSignal.timeout(30000)});
 if(blob&&[301,302,307,308].includes(r.status)){const target=new URL(r.headers.get('location'));assert(target.protocol==='https:'&&['pkg-containers.githubusercontent.com','ghcr.io'].includes(target.hostname));r=await request(target);}
 if(missing&&r.status===404)return null;assert.equal(r.status,200,'Registry read failed');const b=Buffer.from(await r.arrayBuffer());assert(b.length<1024*1024,'Registry metadata too large');return {bytes:b,type:r.headers.get('content-type')?.split(';')[0],digest:r.headers.get('docker-content-digest')};
}
const manifest=await registry('/manifests/'+plan.digestReference.split('@')[1]);
assert.equal(hash(manifest.bytes),plan.digestReference.split('@')[1]);
async function inspectImage(root,testedId){
 assert.equal(root.digest,hash(root.bytes),'Image digest header mismatch');let image=JSON.parse(root.bytes);const descriptor=platformImageDescriptor(image,root.type);
 if(descriptor){const child=await registry('/manifests/'+descriptor.digest);assert.equal(child.type,descriptor.mediaType);assert.equal(child.bytes.length,descriptor.size);assert.equal(hash(child.bytes),descriptor.digest);assert.equal(child.digest,descriptor.digest);image=JSON.parse(child.bytes);assert.equal(platformImageDescriptor(image,child.type),null,'A runnable image must not be an index');}
 const config=await registry('/blobs/'+image.config.digest,{blob:true});assert.equal(hash(config.bytes),image.config.digest);if(testedId)verifyTestedImageIdentity(testedId,hash(root.bytes),image.config.digest);return JSON.parse(config.bytes);
}
const c=await inspectImage(manifest,plan.imageId);
assert(c.os==='linux'&&c.architecture==='amd64'&&c.config.User==='1000:1000');assert.equal(c.config.Labels['org.opencontainers.image.revision'],commit);assert.equal(c.config.Labels['org.opencontainers.image.version'],plan.version);
const channelManifest='/manifests/'+plan.channel;
const old=await registry(channelManifest,{missing:true});
if(old){const previous=await inspectImage(old);validateChannelAdvance({version:previous.config.Labels['org.opencontainers.image.version'],digestReference:registryImage+'@'+hash(old.bytes)},plan);}
await request('https://ghcr.io/v2/'+path+channelManifest,{method:'PUT',headers:{authorization:'Bearer '+registryToken,'content-type':manifest.type},body:manifest.bytes});
const checked=await registry(channelManifest);assert.deepEqual(checked.bytes,manifest.bytes);assert.equal(checked.digest,hash(manifest.bytes));
console.log(JSON.stringify({success:true,...plan,publicRelease:release.html_url,exactTestedManifestPromoted:true,automaticNasRestart:false}));
