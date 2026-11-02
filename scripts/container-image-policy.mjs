import assert from 'node:assert/strict';

export const imageManifestTypes=['application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.v2+json'];
export const imageIndexTypes=['application/vnd.oci.image.index.v1+json','application/vnd.docker.distribution.manifest.list.v2+json'];
export const imageAccept=[...imageManifestTypes,...imageIndexTypes].join(', ');
const digest=value=>assert(typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value),'Invalid image descriptor digest');
function descriptor(value){digest(value?.digest);assert(Number.isSafeInteger(value.size)&&value.size>0&&value.size<1024*1024,'Invalid image descriptor size');assert(imageManifestTypes.includes(value.mediaType),'Nested/unsupported image descriptor');}

// Docker's containerd image store identifies the tested image by its index.
// Keep that exact index (including its provenance) when moving a channel.
export function platformImageDescriptor(image,type){
 assert(image?.schemaVersion===2,'Unsupported image schema');
 if(imageManifestTypes.includes(type)){assert((image.mediaType??type)===type&&!image.manifests,'Invalid image manifest');digest(image.config?.digest);return null;}
 assert(imageIndexTypes.includes(type)&&image.mediaType===type,'Unsupported image index');assert(Array.isArray(image.manifests)&&image.manifests.length>0&&image.manifests.length<=8,'Invalid image index size');
 const primary=image.manifests.filter(value=>value.platform?.os==='linux'&&value.platform?.architecture==='amd64');assert.equal(primary.length,1,'Exactly one tested linux/amd64 image is required');descriptor(primary[0]);
 for(const value of image.manifests){descriptor(value);if(value===primary[0])continue;assert(value.platform?.os==='unknown'&&value.platform?.architecture==='unknown'&&value.annotations?.['vnd.docker.reference.type']==='attestation-manifest'&&value.annotations?.['vnd.docker.reference.digest']===primary[0].digest,'Only provenance bound to the tested image may accompany it');}
 return primary[0];
}
export function verifyTestedImageIdentity(testedId,rootDigest,configDigest){
 for(const value of [testedId,rootDigest,configDigest])digest(value);
 assert(testedId===configDigest||testedId===rootDigest,'The registry image differs from the image tested by CI');
}
