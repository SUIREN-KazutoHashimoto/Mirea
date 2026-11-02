import {readFile} from 'node:fs/promises';
import {verifyUpdateEnvelope} from './update-manifest.js';
const base='https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/download/';
export function createReleaseUpdate(version,{fetcher=fetch,now=Date.now,publicKey}={}){
  const label=version.replace(/-beta$/,'beta');
  if(!/^\d+\.\d+\.\d+(?:beta)?$/.test(label))throw Error('Invalid release version');
  const prefix=base+'v'+label+'/',url=prefix+'mirea-android-update.json';let cached,pending,refreshAfter=0;
  const refresh=()=>pending??=(async()=>{
      const response=await fetcher(url,{signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'},redirect:'follow'});
      if(!response.ok||Number(response.headers.get('content-length'))>65536)throw Error('Release update unavailable');
      const chunks=[];let length=0;try{for await(const chunk of response.body){length+=chunk.length;if(length>65536)throw Error('Update metadata too large');chunks.push(chunk);}}finally{await response.body?.cancel().catch(()=>{});}
      const raw=Buffer.concat(chunks).toString('utf8'),key=publicKey??await readFile(new URL('./update-signing-public.pem',import.meta.url),'utf8');
      const metadata=verifyUpdateEnvelope(raw,key,now());
      if(metadata.versionName!==label||metadata.apkUrl!==prefix+'mirea-'+label+'-android.apk')throw Error('Release update identity mismatch');
      refreshAfter=now()+60000;return cached={raw,metadata,fetchedAt:now()};
    })().catch(error=>{
      // Reuse only an already verified envelope within its signed expiry. A host
      // outage must not hide a valid update; no signature or TTL is weakened.
      refreshAfter=now()+60000;if(cached&&cached.metadata.expiresAt>now())return cached;
      throw error;
    }).finally(()=>{pending=null;});
  return async()=>{
    if(cached&&cached.metadata.expiresAt>now()){
      // A slow release host must not make the application time out before it
      // receives an already authenticated update. Refresh once in background.
      if(now()>=refreshAfter)void refresh().catch(()=>{});
      return cached;
    }
    return refresh();
  };
}
