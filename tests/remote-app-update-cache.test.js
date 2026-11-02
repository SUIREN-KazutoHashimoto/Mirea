import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createReleaseUpdate} from '../server/remote-app-update.js';
import {signUpdateEnvelope} from '../server/update-manifest.js';

test('release lookup retains only an authenticated unexpired cache through host outages',async()=>{
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=pair.publicKey.export({type:'spki',format:'pem'}),privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'});
 let now=Date.now(),mode='valid',calls=0,release;
 const payload={schemaVersion:1,packageName:'com.suiren.mirea',versionCode:1,versionName:'0.25.0beta',apkUrl:'https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/download/v0.25.0beta/mirea-0.25.0beta-android.apk',sha256:'a'.repeat(64),signerSha256:'b'.repeat(64),size:1,minSdk:29,issuedAt:now,expiresAt:now+86400000};
 const raw=signUpdateEnvelope(payload,privateKey,now);
 const fetcher=async()=>{calls++;if(mode==='slow')await new Promise(resolve=>{release=resolve;});if(mode==='offline')throw Error('synthetic unavailable');return new Response(mode==='valid'||mode==='slow'?raw:'not a signed envelope');};
 const lookup=createReleaseUpdate('0.25.0-beta',{fetcher,now:()=>now,publicKey});let first=await lookup();assert.equal(calls,1);
 now+=61000;mode='slow';assert.equal(await lookup(),first,'slow revalidation never blocks a still-valid cached response');assert.equal(calls,2);assert.equal(await lookup(),first);assert.equal(calls,2,'parallel calls reuse the pending refresh');release();await new Promise(resolve=>setImmediate(resolve));const refreshed=await lookup();assert.equal(refreshed.raw,first.raw);first=refreshed;
 now+=61000;mode='offline';assert.equal(await lookup(),first);assert.equal(calls,3);await new Promise(resolve=>setImmediate(resolve));assert.equal(await lookup(),first);assert.equal(calls,3,'a host outage backs off rather than restarting one request per client');
 now+=61000;mode='invalid';assert.equal(await lookup(),first,'invalid replacements never displace a verified cache');await new Promise(resolve=>setImmediate(resolve));
 now=payload.expiresAt;await assert.rejects(lookup,'expired cached envelopes cannot be extended');
 mode='offline';await assert.rejects(createReleaseUpdate('0.25.0-beta',{fetcher,now:()=>now,publicKey}),'no unauthenticated fallback');
});
