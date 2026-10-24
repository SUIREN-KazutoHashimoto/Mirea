import assert from 'node:assert/strict';

export const repository='SUIREN-KazutoHashimoto/Mirea';
export const registryImage='ghcr.io/'+repository.toLowerCase();
export function betaVersion(tag){
 const match=/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)beta$/.exec(tag??'');
 assert(match,'Only numbered beta releases can enter the beta channel');
 const parts=match.slice(1).map(Number);assert(parts.every(Number.isSafeInteger),'Invalid version');
 return {parts,imageTag:tag.slice(1),packageVersion:parts.join('.')+'-beta'};
}
export function compareBeta(a,b){
 const left=betaVersion(a).parts,right=betaVersion(b).parts;
 for(let i=0;i<3;i++){if(left[i]!==right[i])return left[i]<right[i]?-1:1;}return 0;
}
export function newestPublishedBeta(releases){
 return releases.filter(r=>{try{betaVersion(r.tag_name);return !r.draft&&r.prerelease&&!!r.published_at;}catch{return false;}})
  .sort((a,b)=>compareBeta(b.tag_name,a.tag_name))[0]??null;
}
export function validatePromotion({release,latestRelease,commit,metadata,developRun,tagRun,tagJobs}){
 const version=betaVersion(release.tag_name);
 assert(!release.draft&&release.prerelease&&release.published_at,'Release must already be public');
 assert(latestRelease?.id===release.id,'Do not move beta back to an older release');
 assert(/^[a-f0-9]{40}$/.test(commit),'Invalid commit');
 assert(release.target_commitish===commit,'Release target must identify the exact commit');
 for(const [run,branch] of [[developRun,'develop'],[tagRun,release.tag_name]]){
  assert(run?.event==='push'&&run.head_sha===commit&&run.head_branch===branch&&run.status==='completed'&&run.conclusion==='success','Formal develop and tag CI success required');
 }
 for(const name of ['web-and-api','container','android','publish-container'])assert(tagJobs.some(j=>j.name===name&&j.status==='completed'&&j.conclusion==='success'),'All named tag jobs must succeed: '+name);
 assert(metadata.schemaVersion===1&&metadata.version===version.packageVersion&&metadata.tag===release.tag_name&&metadata.commit===commit,'Release metadata identity mismatch');
 assert(metadata.image===registryImage+':'+version.imageTag&&metadata.platform==='linux/amd64','Unexpected image');
 assert(metadata.digestReference?.startsWith(registryImage+'@sha256:')&&/^sha256:[a-f0-9]{64}$/.test(metadata.digestReference.slice(registryImage.length+1)),'Invalid image digest');
 assert(/^sha256:[a-f0-9]{64}$/.test(metadata.imageId),'Invalid config digest');
 for(const flag of ['testedImagePromoted','readOnlyRoot','separateStorageVerified','containerRecreationAndEncryptionVerified'])assert(metadata[flag]===true,'Image verification missing: '+flag);
 assert(metadata.nonRoot==='1000:1000'&&metadata.dataPath==='/data'&&metadata.optionalMediaPath==='/media','Storage/runtime identity mismatch');
 return {tag:release.tag_name,version:version.packageVersion,commit,image:registryImage+':beta',digestReference:metadata.digestReference,imageId:metadata.imageId};
}
export function validateChannelAdvance(previous,next){
 if(!previous)return;
 assert(compareBeta('v'+previous.version.replace('-beta','beta'),next.tag)<=0,'Refusing to downgrade the beta channel');
 if(previous.version===next.version)assert(previous.digestReference===next.digestReference,'A numbered release must never change its image');
}
