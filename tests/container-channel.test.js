import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {betaVersion,compareBeta,newestPublishedBeta,validatePromotion,validateChannelAdvance,registryImage} from '../scripts/container-channel-policy.mjs';
const sha='a'.repeat(40),digest='sha256:'+'b'.repeat(64);
function fixture(){const release={id:15,tag_name:'v0.15.0beta',draft:false,prerelease:true,published_at:'2026-10-24T00:00:00Z',target_commitish:sha};return {release,latestRelease:release,commit:sha,metadata:{schemaVersion:1,tag:release.tag_name,version:'0.15.0-beta',commit:sha,image:registryImage+':0.15.0beta',digestReference:registryImage+'@'+digest,imageId:'sha256:'+'c'.repeat(64),platform:'linux/amd64',testedImagePromoted:true,readOnlyRoot:true,separateStorageVerified:true,containerRecreationAndEncryptionVerified:true,nonRoot:'1000:1000',dataPath:'/data',optionalMediaPath:'/media'},developRun:{event:'push',head_branch:'develop',head_sha:sha,status:'completed',conclusion:'success'},tagRun:{event:'push',head_branch:release.tag_name,head_sha:sha,status:'completed',conclusion:'success'},tagJobs:['web-and-api','container','android','publish-container'].map(name=>({name,status:'completed',conclusion:'success'}))};}
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
