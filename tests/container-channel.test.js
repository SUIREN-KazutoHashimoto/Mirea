import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {releaseVersion,packageRelease,compareReleases,newestPublishedRelease,betaVersion,compareBeta,newestPublishedBeta,validatePromotion,validateChannelAdvance,registryImage} from '../scripts/container-channel-policy.mjs';
import {imageManifestTypes,imageIndexTypes,platformImageDescriptor,verifyTestedImageIdentity} from '../scripts/container-image-policy.mjs';
const sha='a'.repeat(40),digest='sha256:'+'b'.repeat(64);
test('legacy single manifests and containerd indexes bind the exact tested image without discarding provenance',()=>{
 const primary={mediaType:imageManifestTypes[0],digest:'sha256:'+'a'.repeat(64),size:2000,platform:{os:'linux',architecture:'amd64'}},attestation={mediaType:imageManifestTypes[0],digest:'sha256:'+'c'.repeat(64),size:500,platform:{os:'unknown',architecture:'unknown'},annotations:{'vnd.docker.reference.type':'attestation-manifest','vnd.docker.reference.digest':primary.digest}},configDigest='sha256:'+'d'.repeat(64);
 for(const type of imageIndexTypes){const index={schemaVersion:2,mediaType:type,manifests:[primary,attestation]},before=structuredClone(index);assert.equal(platformImageDescriptor(index,type),primary);assert.deepEqual(index,before,'Do not flatten/rebuild the tested index');verifyTestedImageIdentity(digest,digest,configDigest);verifyTestedImageIdentity(configDigest,digest,configDigest);
  for(const change of [v=>v.manifests.push({...primary}),v=>v.manifests.push({...primary,platform:{os:'linux',architecture:'arm64'}}),v=>v.manifests[1].annotations['vnd.docker.reference.digest']=configDigest,v=>delete v.manifests[1].annotations,v=>v.manifests[0].mediaType=imageIndexTypes[0],v=>v.manifests[0].size=0,v=>v.manifests[0].digest='bad',v=>v.mediaType='unrelated',v=>v.schemaVersion=1]){const bad=structuredClone(index);change(bad);assert.throws(()=>platformImageDescriptor(bad,type));}
 }
 for(const type of imageManifestTypes)assert.equal(platformImageDescriptor({schemaVersion:2,mediaType:type,config:{digest:configDigest}},type),null);
 assert.throws(()=>verifyTestedImageIdentity(primary.digest,digest,configDigest));assert.throws(()=>verifyTestedImageIdentity('bad',digest,configDigest));assert.throws(()=>platformImageDescriptor({schemaVersion:2,mediaType:imageManifestTypes[1],config:{digest:configDigest}},imageManifestTypes[0]));
});
function fixture(){const release={id:15,tag_name:'v0.15.0beta',draft:false,prerelease:true,published_at:'2026-10-24T00:00:00Z',target_commitish:sha};return {release,latestRelease:release,commit:sha,metadata:{schemaVersion:1,tag:release.tag_name,version:'0.15.0-beta',commit:sha,image:registryImage+':0.15.0beta',digestReference:registryImage+'@'+digest,imageId:'sha256:'+'c'.repeat(64),platform:'linux/amd64',testedImagePromoted:true,readOnlyRoot:true,separateStorageVerified:true,containerRecreationAndEncryptionVerified:true,nonRoot:'1000:1000',dataPath:'/data',optionalMediaPath:'/media'},developRun:{event:'push',head_branch:'develop',head_sha:sha,status:'completed',conclusion:'success'},tagRun:{event:'push',head_branch:release.tag_name,head_sha:sha,status:'completed',conclusion:'success'},tagJobs:['web-and-api','web-ui','container','android','publish-container'].map(name=>({name,status:'completed',conclusion:'success'}))};}
test('beta channel versions are strict and sort numerically, not lexically or by republishing time',()=>{
 assert.deepEqual(betaVersion('v0.15.0beta').parts,[0,15,0]);assert(compareBeta('v0.15.0beta','v0.9.9beta')>0);
 for(const bad of ['v01.1.1beta','v1.0.0','beta','v1.0.0beta/path','v1.0.0beta\n','v999999999999999999999.0.0beta'])assert.throws(()=>betaVersion(bad));
 const good=fixture().release;assert.equal(newestPublishedBeta([{...good,id:1,tag_name:'v0.9.0beta'},{...good,id:2,draft:true,tag_name:'v9.0.0beta'},good]).id,15);assert.equal(newestPublishedBeta([]),null);
});
test('only already public releases with exact image metadata and formally successful develop/tag CI can enter beta',()=>{
 assert.equal(validatePromotion(fixture()).digestReference,registryImage+'@'+digest);
 for(const change of [f=>f.release.draft=true,f=>f.release.prerelease=false,f=>f.release.published_at=null,f=>f.latestRelease={id:99},f=>f.release.target_commitish='develop',f=>f.metadata.commit='d'.repeat(40),f=>f.metadata.image='evil.test/mirea:0.15.0beta',f=>f.metadata.digestReference=registryImage+'@sha256:bad',f=>f.metadata.testedImagePromoted=false,f=>f.metadata.separateStorageVerified=false,f=>f.metadata.nonRoot='0:0',f=>f.developRun.status='in_progress',f=>f.tagRun.conclusion='failure',f=>f.tagRun.head_sha='d'.repeat(40),f=>f.tagJobs.pop(),f=>f.tagJobs[0].conclusion='skipped']){const f=fixture();change(f);assert.throws(()=>validatePromotion(f));}
});
test('channel never moves backwards or changes bytes under an existing numbered release',()=>{
 const plan=validatePromotion(fixture());assert.doesNotThrow(()=>validateChannelAdvance(null,plan));assert.doesNotThrow(()=>validateChannelAdvance({version:'0.14.0-beta',digestReference:'old'},plan));assert.doesNotThrow(()=>validateChannelAdvance({version:plan.version,digestReference:plan.digestReference},plan));
 assert.throws(()=>validateChannelAdvance({version:'0.16.0-beta',digestReference:'newer'},plan));assert.throws(()=>validateChannelAdvance({version:plan.version,digestReference:'different'},plan));
});
test('channel workflow is serialized, release-gated, uses a temporary token and cannot rebuild images or access a NAS',async()=>{
 const ci=await readFile(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8');for(const text of ['types: [published]','group: mirea-beta-channel','cancel-in-progress: false','packages: write','actions: read','scripts/publish-container-channel.mjs'])assert(ci.includes(text));
 const source=await readFile(new URL('../scripts/publish-container-channel.mjs',import.meta.url),'utf8');for(const bad of ['rejectUnauthorized:false','NODE_TLS_REJECT_UNAUTHORIZED','docker.sock','child_process','docker build'])assert(!source.includes(bad));assert(source.includes('validatePromotion(')&&source.includes('validateChannelAdvance('));
});

function stableFixture(){const f=fixture();f.release={...f.release,tag_name:'v1.0.0',prerelease:false};f.latestRelease=f.release;f.tagRun={...f.tagRun,head_branch:f.release.tag_name};f.metadata={...f.metadata,version:'1.0.0',tag:f.release.tag_name,image:registryImage+':1.0.0'};return f;}

test('strict version parsing classifies stable and beta without accepting alpha, RC or ambiguous spellings',()=>{
 assert.deepEqual(releaseVersion('v1.2.3'),{parts:[1,2,3],imageTag:'1.2.3',packageVersion:'1.2.3',channel:'stable',prerelease:false});
 assert.equal(releaseVersion('v1.2.3beta').channel,'beta');assert.equal(packageRelease('1.2.3-beta').imageTag,'1.2.3beta');assert.equal(packageRelease('1.2.3').channel,'stable');
 for(const bad of [undefined,null,1,'stable','beta','latest','v1.2','v01.2.3','v1.02.3','v1.2.03','v1.2.3-rc.1','v1.2.3-beta','v1.2.3+build','v1.2.3\n','v1.2.3beta\r\n','v9007199254740992.0.0'])assert.throws(()=>releaseVersion(bad),String(bad));
 for(const bad of ['v1.2.3','1.2.3beta','1.2.3-beta.1','1.2.3-rc.1','1.2.3\n',null])assert.throws(()=>packageRelease(bad));
 assert(compareReleases('v1.10.0','v1.9.9')>0);assert.throws(()=>compareReleases('v1.2.3','v1.2.3beta'));
});

test('each channel selects its newest public release independently of publication time and newer prereleases',()=>{
 const stable=stableFixture().release,beta=fixture().release;
 const releases=[stable,beta,{...stable,id:99,tag_name:'v0.9.9',published_at:'2099-01-01T00:00:00Z'},{...beta,id:98,tag_name:'v99.0.0beta'},
  {...stable,id:97,tag_name:'v100.0.0',draft:true},{...stable,id:96,tag_name:'v101.0.0',prerelease:true},
  {...beta,id:95,tag_name:'v102.0.0beta',prerelease:false},{...stable,id:94,tag_name:'v103.0.0',published_at:null},
  {...stable,id:93,tag_name:'v104.0.0',published_at:'invalid'},{...stable,id:92,tag_name:'v105.0.0',draft:undefined}];
 assert.equal(newestPublishedRelease(releases,'stable').tag_name,'v1.0.0');assert.equal(newestPublishedRelease(releases,'beta').tag_name,'v99.0.0beta');
 assert.equal(newestPublishedRelease([beta],'stable'),null);assert.equal(newestPublishedRelease([stable],'beta'),null);assert.throws(()=>newestPublishedRelease(releases,'latest'));
});

test('stable promotion requires a real public non-prerelease and all original CI/image proofs',()=>{
 const f=stableFixture(),p=validatePromotion(f);assert.equal(p.image,registryImage+':stable');assert.equal(p.channel,'stable');assert.equal(p.digestReference,registryImage+'@'+digest);
 assert.equal(validatePromotion(fixture()).image,registryImage+':beta');
 for(const change of [f=>f.release.draft=true,f=>f.release.prerelease=true,f=>f.release.prerelease=undefined,f=>f.release.published_at=null,f=>f.release.published_at='invalid',f=>f.latestRelease={...f.release,id:99},f=>f.release.target_commitish='develop',f=>f.metadata.version='1.0.0-beta',f=>f.metadata.tag='v1.0.0beta',f=>f.metadata.image=registryImage+':stable',f=>f.metadata.commit='d'.repeat(40),f=>f.metadata.digestReference=registryImage+'@sha256:bad',f=>f.metadata.imageId='sha256:bad',f=>f.metadata.platform='linux/arm64',f=>f.metadata.testedImagePromoted=false,f=>f.metadata.readOnlyRoot=false,f=>f.metadata.separateStorageVerified=false,f=>f.metadata.containerRecreationAndEncryptionVerified=false,f=>f.metadata.nonRoot='0:0',f=>f.metadata.dataPath='/other',f=>f.metadata.optionalMediaPath='/other',f=>f.developRun.status='in_progress',f=>f.developRun.head_sha='d'.repeat(40),f=>f.tagRun.conclusion='failure',f=>f.tagJobs.pop(),f=>f.tagJobs[0].conclusion='skipped']){const bad=stableFixture();change(bad);assert.throws(()=>validatePromotion(bad));}
});

test('stable and beta cannot cross-contaminate, downgrade or mutate a numbered image',()=>{
 const stable=validatePromotion(stableFixture()),beta=validatePromotion(fixture());
 assert.doesNotThrow(()=>validateChannelAdvance(null,stable));assert.doesNotThrow(()=>validateChannelAdvance({version:'0.9.0',digestReference:'old'},stable));assert.doesNotThrow(()=>validateChannelAdvance({version:stable.version,digestReference:stable.digestReference},stable));
 assert.throws(()=>validateChannelAdvance({version:'1.1.0',digestReference:'newer'},stable));assert.throws(()=>validateChannelAdvance({version:stable.version,digestReference:'different'},stable));
 assert.throws(()=>validateChannelAdvance({version:'0.9.0-beta',digestReference:'old'},stable));assert.throws(()=>validateChannelAdvance({version:'0.14.0',digestReference:'old'},beta));assert.throws(()=>validateChannelAdvance(null,{...stable,channel:'beta'}));
});

test('both channels share the legacy serialization lock, release validation and exact-manifest-only writes',async()=>{
 const ci=await readFile(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8'),publisher=await readFile(new URL('../scripts/publish-container.mjs',import.meta.url),'utf8'),channel=await readFile(new URL('../scripts/publish-container-channel.mjs',import.meta.url),'utf8');
 for(const text of ['promote-release-channel:','group: mirea-beta-channel','cancel-in-progress: false','stable or beta release'])assert(ci.includes(text));
 assert(publisher.includes('packageRelease(pkg.version)')&&publisher.includes('prerelease:releaseType.prerelease'));assert(publisher.includes('Refusing to overwrite a different image under an existing tag'));assert(publisher.includes('assert.equal(published.Id,tested.Id)'));
 assert(channel.includes('newestPublishedRelease(releases,channel)')&&channel.includes("const channelManifest='/manifests/'+plan.channel"));assert(channel.includes('page<=100')&&channel.includes('&page='));assert(channel.includes('body:manifest.bytes'));assert(!channel.includes("'/manifests/stable'"));assert(!channel.includes("'/manifests/beta'"));
});
