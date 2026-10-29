import assert from 'node:assert/strict';

export const repository='SUIREN-KazutoHashimoto/Mirea';
export const registryImage='ghcr.io/'+repository.toLowerCase();
export function releaseVersion(tag){
 assert(typeof tag==='string'&&tag.length<=64,'A numbered release tag is required');
 const match=/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(beta)?$/.exec(tag);
 assert(match&&match[0]===tag,'Only vX.Y.Z or vX.Y.Zbeta releases are supported');
 const parts=match.slice(1,4).map(Number);assert(parts.every(Number.isSafeInteger),'Invalid version');
 const prerelease=match[4]==='beta';
 return {parts,imageTag:tag.slice(1),packageVersion:parts.join('.')+(prerelease?'-beta':''),channel:prerelease?'beta':'stable',prerelease};
}
export function packageRelease(value){
 assert(typeof value==='string','Invalid package version');
 const result=releaseVersion('v'+value.replace(/-beta$/,'beta'));
 assert.equal(result.packageVersion,value,'Noncanonical package version');return result;
}
export function compareReleases(a,b){
 const first=releaseVersion(a),second=releaseVersion(b);assert.equal(first.channel,second.channel,'Cannot compare different channels');
 const left=first.parts,right=second.parts;
 for(let i=0;i<3;i++){if(left[i]!==right[i])return left[i]<right[i]?-1:1;}return 0;
}
export function newestPublishedRelease(releases,channel){
 assert(['stable','beta'].includes(channel),'Unknown release channel');
 return releases.filter(r=>{try{const v=releaseVersion(r.tag_name);return v.channel===channel&&r.draft===false&&r.prerelease===v.prerelease&&typeof r.published_at==='string'&&Number.isFinite(Date.parse(r.published_at));}catch{return false;}})
  .sort((a,b)=>compareReleases(b.tag_name,a.tag_name))[0]??null;
}
// Retain the beta-only helpers for existing tooling; they must never accept a stable version.
export function betaVersion(tag){const v=releaseVersion(tag);assert.equal(v.channel,'beta');return {parts:v.parts,imageTag:v.imageTag,packageVersion:v.packageVersion};}
export function compareBeta(a,b){betaVersion(a);betaVersion(b);return compareReleases(a,b);}
export const newestPublishedBeta=releases=>newestPublishedRelease(releases,'beta');
export function validatePromotion({release,latestRelease,commit,metadata,developRun,tagRun,tagJobs}){
 const version=releaseVersion(release.tag_name);
 assert(release.draft===false&&release.prerelease===version.prerelease&&typeof release.published_at==='string'&&Number.isFinite(Date.parse(release.published_at)),'Release must already be public with matching stable/beta classification');
 assert(latestRelease?.id===release.id&&latestRelease.tag_name===release.tag_name,'Do not move a channel back to an older release');
 assert(/^[a-f0-9]{40}$/.test(commit),'Invalid commit');
 assert(release.target_commitish===commit,'Release target must identify the exact commit');
 for(const [run,branch] of [[developRun,'develop'],[tagRun,release.tag_name]]){
  assert(run?.event==='push'&&run.head_sha===commit&&run.head_branch===branch&&run.status==='completed'&&run.conclusion==='success','Formal develop and tag CI success required');
 }
 for(const name of ['web-and-api','web-ui','container','android','publish-container'])assert(tagJobs.some(j=>j.name===name&&j.status==='completed'&&j.conclusion==='success'),'All named tag jobs must succeed: '+name);
 assert(metadata.schemaVersion===1&&metadata.version===version.packageVersion&&metadata.tag===release.tag_name&&metadata.commit===commit,'Release metadata identity mismatch');
 assert(metadata.image===registryImage+':'+version.imageTag&&metadata.platform==='linux/amd64','Unexpected image');
 assert(metadata.digestReference?.startsWith(registryImage+'@sha256:')&&/^sha256:[a-f0-9]{64}$/.test(metadata.digestReference.slice(registryImage.length+1)),'Invalid image digest');
 assert(/^sha256:[a-f0-9]{64}$/.test(metadata.imageId),'Invalid tested Docker image identity');
 for(const flag of ['testedImagePromoted','readOnlyRoot','separateStorageVerified','containerRecreationAndEncryptionVerified'])assert(metadata[flag]===true,'Image verification missing: '+flag);
 assert(metadata.nonRoot==='1000:1000'&&metadata.dataPath==='/data'&&metadata.optionalMediaPath==='/media','Storage/runtime identity mismatch');
 return {tag:release.tag_name,version:version.packageVersion,channel:version.channel,commit,image:registryImage+':'+version.channel,digestReference:metadata.digestReference,imageId:metadata.imageId};
}
export function validateChannelAdvance(previous,next){
 const target=packageRelease(next.version);assert.equal(target.channel,next.channel);assert.equal('v'+target.imageTag,next.tag);
 if(!previous)return;
 const current=packageRelease(previous.version);assert.equal(current.channel,target.channel,'Refusing to mix stable and beta channels');
 assert(compareReleases('v'+current.imageTag,next.tag)<=0,'Refusing to downgrade a release channel');
 if(previous.version===next.version)assert(previous.digestReference===next.digestReference,'A numbered release must never change its image');
}
