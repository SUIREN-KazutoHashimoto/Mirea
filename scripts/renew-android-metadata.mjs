import {createPublicKey} from 'node:crypto';
import {verifyUpdateEnvelope,signUpdateEnvelope} from '../server/update-manifest.js';
// Renew only the expiry envelope. Never rebuild or re-sign the APK itself.
export function renewAndroidMetadata(raw,privateKey,publicKey,{now=Date.now(),validityHours=168}={}){
  if(!Number.isSafeInteger(now)||!Number.isFinite(validityHours)||validityHours<=0||validityHours>168)throw Error('Invalid renewal time');
  if(Buffer.byteLength(raw)>65536)throw Error('Metadata too large');
  const envelope=JSON.parse(raw),issuedAt=JSON.parse(Buffer.from(envelope.payload,'base64')).issuedAt;
  if(!Number.isSafeInteger(issuedAt)||issuedAt>now+300000)throw Error('Invalid original issue time');
  const old=verifyUpdateEnvelope(raw,publicKey,issuedAt);
  const der=key=>createPublicKey(key).export({type:'spki',format:'der'});
  if(!der(privateKey).equals(der(publicKey)))throw Error('Signing key does not match the pin');
  const payload={...old,issuedAt:now,expiresAt:now+Math.floor(validityHours*3600000)};
  const signed=signUpdateEnvelope(payload,privateKey,now),verified=verifyUpdateEnvelope(signed,publicKey,now);
  for(const key of Object.keys(old))if(!['issuedAt','expiresAt'].includes(key)&&verified[key]!==old[key])throw Error('APK identity changed');
  return {raw:signed+'\n',metadata:verified};
}
