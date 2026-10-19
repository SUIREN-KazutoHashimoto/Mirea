import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes,createCipheriv } from 'node:crypto';
import { validateManifest,downloadRange,encryptedRangeResponse,importDownloadKey } from '../web/src/download-core.js';

test('encrypted range reader is lazy, stops on lock/session expiry, and never substitutes online/plaintext data',async()=>{
  const bytes=Buffer.alloc(1048576+10,23),rawKey=randomBytes(32),manifest={id:randomUUID(),assetId:randomUUID(),version:1,algorithm:'AES-256-GCM',chunkSize:1048576,kind:'video',pageCount:1,files:[{index:0,number:1,size:bytes.length,chunks:2,mime:'video/mp4'}]};
  const key=await importDownloadKey(rawKey.toString('base64')),parts=[];
  for(let part=0;part<2;part++){const plain=bytes.subarray(part*1048576,(part+1)*1048576),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',rawKey,iv);cipher.setAAD(Buffer.from(`mirea-download-v1|${manifest.id}|0|${part}|${plain.length}`));parts.push({bytes:Buffer.concat([iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()])});}
  let reads=0,locked=false;const grant={manifest,key,expiresAt:1000},options={now:()=>100,revoked:()=>locked};
  const response=encryptedRangeResponse(new Request('https://local/video'),grant,0,async(_id,_file,part)=>{reads++;return parts[part];},options);
  assert.equal(reads,0,'must not eagerly decrypt full video');const reader=response.body.getReader();assert.equal((await reader.read()).value.length,1048576);assert.equal(reads,1);
  locked=true;await assert.rejects(()=>reader.read());assert.equal(reads,1);
  assert.equal(encryptedRangeResponse(new Request('https://local/video'),grant,0,()=>assert.fail(),options).status,403);
  locked=false;assert.equal(encryptedRangeResponse(new Request('https://local/video'),{...grant,expiresAt:99},0,()=>assert.fail(),options).status,403);
  const missing=encryptedRangeResponse(new Request('https://local/video'),grant,0,async()=>null,options);await assert.rejects(()=>missing.arrayBuffer());
});
test('download manifest/ranges reject invalid dimensions, excessive sizes and malformed requests',()=>{
  assert.deepEqual(downloadRange('bytes=-4',10),{start:6,end:9,partial:true});assert.deepEqual(downloadRange('bytes=4-',10),{start:4,end:9,partial:true});
  for(const header of ['bytes=1-2,4-5','bytes=','bytes=99-','bytes=-0','bytes=8-2','bytes=99999999999999999999-'])assert.throws(()=>downloadRange(header,10));
  assert.throws(()=>validateManifest({version:1,algorithm:'plaintext'}));
  const m={id:randomUUID(),assetId:randomUUID(),version:1,algorithm:'AES-256-GCM',chunkSize:1048576,kind:'pdf',pageCount:1,files:[{index:0,number:1,size:10,chunks:1,mime:'application/pdf'}]};assert.equal(validateManifest(m),m);
  for(const changed of [{chunkSize:8},{files:[{...m.files[0],mime:'text/html'}]},{files:[{...m.files[0],size:2147483649}]},{files:[{...m.files[0],chunks:2}]}])assert.throws(()=>validateManifest({...m,...changed}));
});
