import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { signUpdateEnvelope, verifyUpdateEnvelope } from '../server/update-manifest.js';
import { registerAppUpdates } from '../server/app-updates.js';
import { createApp } from '../server/app.js';
import { readFile } from 'node:fs/promises';
import { parseApkMetadata } from '../scripts/sign-android-update.mjs';
import { beginUpdateActivity, isUpdateBusy, subscribeUpdateBusy } from '../web/src/update-busy.js';

const { privateKey, publicKey } = generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const pem = publicKey.export({type:'spki',format:'pem'}), privatePem = privateKey.export({type:'pkcs8',format:'pem'});
const bytes = Buffer.from('synthetic signed test APK contents'), now=Date.now();
const payload = () => ({schemaVersion:1,packageName:'com.suiren.mirea',versionCode:4,versionName:'0.2.4beta',apkUrl:'https://mirea.example/api/v1/app-updates/android/apk/4',sha256:createHash('sha256').update(bytes).digest('hex'),signerSha256:'a'.repeat(64),size:bytes.length,minSdk:29,issuedAt:now,expiresAt:now+86400000});
function unchecked(value,key=privateKey) {const b=Buffer.from(JSON.stringify(value));return JSON.stringify({payload:b.toString('base64'),signature:sign('sha256',b,key).toString('base64')});}
test('signed update metadata rejects forgery, expiry, invalid identity, types, URLs, sizes and unknown fields',()=>{
  const p=payload(), raw=signUpdateEnvelope(p,privatePem,now); assert.deepEqual(verifyUpdateEnvelope(raw,pem,now),p);
  const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});assert.throws(()=>verifyUpdateEnvelope(unchecked(p,other.privateKey),pem,now));
  const forged=JSON.parse(raw);forged.payload=Buffer.from(JSON.stringify({...p,sha256:'b'.repeat(64)})).toString('base64');assert.throws(()=>verifyUpdateEnvelope(JSON.stringify(forged),pem,now));
  for(const change of [{expiresAt:now},{issuedAt:now+300001},{expiresAt:now+8*86400000},{packageName:'other.app'}, {schemaVersion:2},{versionCode:0},{versionCode:2147483648},{versionCode:'4'},{versionCode:4.5},{versionName:'<script>'},{size:0},{size:512*1024*1024+1},{sha256:'B'.repeat(64)},{signerSha256:'a'},{minSdk:28},{minSdk:4294967325},{apkUrl:'http://mirea.example/app.apk'},{apkUrl:'https://name:pass@mirea.example/app.apk'},{apkUrl:'https://mirea.example/app.apk#x'},{extra:true}]) {
    assert.throws(()=>verifyUpdateEnvelope(unchecked({...p,...change}),pem,now),JSON.stringify(change));
  }
  assert.throws(()=>verifyUpdateEnvelope(' '.repeat(65537),pem,now));
  assert.throws(()=>verifyUpdateEnvelope(JSON.stringify({...JSON.parse(raw),extra:1}),pem,now));
  assert.throws(()=>verifyUpdateEnvelope(JSON.stringify({...JSON.parse(raw),signature:'A==='}),pem,now));
});
test('public Android update endpoints fail closed and support exact HEAD and resumed Range transfers',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mirea-update-')),app=Fastify();
  app.setErrorHandler((error,_req,reply)=>reply.code(error.statusCode||500).send({error:error.message}));
  registerAppUpdates(app,{directory:dir,publicKey:pem});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  assert.equal((await app.inject('/api/v1/app-updates/android/manifest')).statusCode,404);
  await writeFile(join(dir,'mirea-android-4.apk'),bytes);
  await writeFile(join(dir,'manifest.json'),signUpdateEnvelope(payload(),privatePem));
  let r=await app.inject('/api/v1/app-updates/android/manifest');assert.equal(r.statusCode,200);assert.equal(verifyUpdateEnvelope(r.body,pem).versionCode,4);assert.match(r.headers['cache-control'],/no-transform/);
  r=await app.inject({method:'HEAD',url:'/api/v1/app-updates/android/manifest'});assert.equal(r.body,'');assert.ok(Number(r.headers['content-length'])>0);
  r=await app.inject({url:'/api/v1/app-updates/android/apk/4',headers:{range:'bytes=5-9'}});assert.equal(r.statusCode,206);assert.deepEqual(r.rawPayload,bytes.subarray(5,10));assert.equal(r.headers['content-range'],`bytes 5-9/${bytes.length}`);
  r=await app.inject({method:'HEAD',url:'/api/v1/app-updates/android/apk/4'});assert.equal(Number(r.headers['content-length']),bytes.length);assert.equal(r.body,'');
  assert.equal((await app.inject('/api/v1/app-updates/android/apk/3')).statusCode,404);
  r=await app.inject({url:'/api/v1/app-updates/android/latest.apk',headers:{range:'bytes=5-9'}});assert.equal(r.statusCode,206);assert.deepEqual(r.rawPayload,bytes.subarray(5,10));
  assert.equal((await app.inject('/api/v1/app-updates/android/apk/..%5Csecret')).statusCode,404);
  assert.equal((await app.inject({url:'/api/v1/app-updates/android/apk/4',headers:{range:'bytes=99999-'}})).statusCode,416);
  await writeFile(join(dir,'mirea-android-4.apk'),Buffer.alloc(bytes.length,0));
  r=await app.inject('/api/v1/app-updates/android/manifest');assert.equal(r.statusCode,503);assert.ok(!r.body.includes(dir));
  assert.equal((await app.inject('/api/v1/app-updates/android/latest.apk')).statusCode,503);
  await writeFile(join(dir,'mirea-android-4.apk'),bytes);
  await writeFile(join(dir,'manifest.json'),unchecked({...payload(),expiresAt:now-1}));
  assert.equal((await app.inject('/api/v1/app-updates/android/manifest')).statusCode,503);
  await writeFile(join(dir,'manifest.json'),'a'.repeat(65537));assert.equal((await app.inject('/api/v1/app-updates/android/manifest')).statusCode,503);
});
test('unconfigured update hosting is explicitly unavailable without filesystem access',async()=>{
  const app=Fastify();registerAppUpdates(app);assert.equal((await app.inject('/api/v1/app-updates/android/manifest')).statusCode,404);await app.close();
});
test('the real API exposes no update endpoint data without a configured bundle, and both runtime pins agree',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mirea-update-api-')), app=await createApp({dataDir:dir,appUpdatesDir:'',rateLimit:false});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const response=await app.inject('/api/v1/app-updates/android/manifest');assert.equal(response.statusCode,404);assert.match(response.headers['cache-control'],/no-store, no-transform/);
  const config=(await app.inject('/api/v1/config')).json();
  const expectedApk='https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/download/v0.16.0beta/mirea-0.16.0beta-android.apk';
  assert.equal(config.androidApkUrl,expectedApk);
  const web=await readFile(new URL('../web/src/main.js',import.meta.url),'utf8');assert(web.includes(`const defaultApkUrl = '${expectedApk}';`));
  const serverKey=await readFile(new URL('../server/update-signing-public.pem',import.meta.url),'utf8'),androidKey=await readFile(new URL('../android/app/src/main/assets/update-signing-public.pem',import.meta.url),'utf8');
  assert.equal(serverKey.trim(),androidKey.trim());
});
test('viewers and concurrent transfers keep updates locked until the last idempotent lease is released',()=>{
  const seen=[],unsubscribe=subscribeUpdateBusy(value=>seen.push(value));
  const viewer=beginUpdateActivity(),upload=beginUpdateActivity(),download=beginUpdateActivity();assert.equal(isUpdateBusy(),true);
  upload();upload();viewer();assert.equal(isUpdateBusy(),true);download();assert.equal(isUpdateBusy(),false);
  assert.deepEqual(seen,[false,true,false]);unsubscribe();
});
test('publisher reads actual aapt2 minimum SDK formats and refuses debug, foreign or ambiguous APKs',()=>{
  const badge="package: name='com.suiren.mirea' versionCode='3' versionName='0.2.3beta'\r\nminSdkVersion:'29'\r\ntargetSdkVersion:'36'\r\n",cert=`Signer #1 certificate DN: CN=Mirea\r\nSigner #1 certificate SHA-256 digest: ${'a'.repeat(64)}\r\n`;
  assert.deepEqual(parseApkMetadata(badge,cert),{versionCode:3,versionName:'0.2.3beta',minSdk:29,signerSha256:'a'.repeat(64)});
  assert.equal(parseApkMetadata(badge.replace('minSdkVersion','sdkVersion'),cert).minSdk,29);
  assert.throws(()=>parseApkMetadata(badge,cert.replace('CN=Mirea','CN=Android Debug')));
  assert.throws(()=>parseApkMetadata(badge+'application-debuggable\r\n',cert));
  assert.throws(()=>parseApkMetadata(badge.replace('com.suiren.mirea','other.app'),cert));
  assert.throws(()=>parseApkMetadata(badge,cert+cert.replace('#1','#2')));
});
