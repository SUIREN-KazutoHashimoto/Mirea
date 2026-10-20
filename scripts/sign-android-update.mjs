import { readFile, open, mkdir, copyFile, rename, unlink } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ANDROID_PACKAGE, MAX_APK_BYTES, signUpdateEnvelope, verifyUpdateEnvelope } from '../server/update-manifest.js';

async function hashFile(path) { const h = createHash('sha256'); for await (const b of createReadStream(path)) h.update(b); return h.digest('hex'); }
const inside = (root, file) => { const rel = relative(root, file); return !rel.startsWith('..') && !isAbsolute(rel); };
export function parseApkMetadata(badging, certificates) {
  const signers = [...certificates.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})\r?$/gm)];
  if (signers.length !== 1 || /CN=Android Debug/i.test(certificates) || /^application-debuggable\b/m.test(badging)) throw new Error('A single dedicated release signer is required; debug APKs cannot be published');
  const info = badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m), minSdk = badging.match(/^(?:minSdkVersion|sdkVersion):'(\d+)'/m);
  if (!info || info[1] !== ANDROID_PACKAGE || !minSdk) throw new Error('Not a standalone Mirea APK');
  return { versionCode:Number(info[2]), versionName:info[3], minSdk:Number(minSdk[1]), signerSha256:signers[0][1].toLowerCase() };
}
async function bounded(path) {
  const file = await open(path, 'r');
  try { if ((await file.stat()).size > 65536) throw new Error('Manifest too large'); return await file.readFile('utf8'); }
  finally { await file.close(); }
}
export async function publishAndroidUpdate({ apk, apkUrl, privateKey, output, sdk, java = 'java', validityHours = 168 }) {
  if (![apk,apkUrl,privateKey,output,sdk].every(x => typeof x === 'string' && x.length)) throw new Error('Required: --apk --apk-url --private-key --output --sdk [--java] [--validity-hours]');
  if (!Number.isFinite(validityHours) || validityHours <= 0 || validityHours > 168) throw new Error('Validity must be 0–168 hours');
  const project = dirname(dirname(fileURLToPath(import.meta.url))), destination = resolve(output), keyPath = resolve(privateKey), apkPath = resolve(apk);
  if (inside(project,keyPath) || inside(destination,keyPath)) throw new Error('The private signing key must remain outside the repository and public output directory');
  const pem = await readFile(keyPath,'utf8'), pinned = await readFile(new URL('../server/update-signing-public.pem',import.meta.url),'utf8');
  if (!createPublicKey(pem).export({type:'spki',format:'der'}).equals(createPublicKey(pinned).export({type:'spki',format:'der'}))) throw new Error('The metadata key does not match the pinned public key');
  const tools = join(resolve(sdk),'build-tools','36.0.0');
  const result = execFileSync(java,['-Duser.language=en','-Duser.country=US','-jar',join(tools,'lib','apksigner.jar'),'verify','--verbose','--print-certs',apkPath],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
  const badging = execFileSync(join(tools,process.platform==='win32'?'aapt2.exe':'aapt2'),['dump','badging',apkPath],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
  const apkInfo = parseApkMetadata(badging,result);
  const file = await open(apkPath,'r'); let size;
  try { size=(await file.stat()).size; } finally { await file.close(); }
  if (size < 1 || size > MAX_APK_BYTES) throw new Error('APK size must be 1–512 MiB');
  const now = Date.now(), payload = { schemaVersion:1, packageName:ANDROID_PACKAGE, ...apkInfo,
    apkUrl, sha256:await hashFile(apkPath), size, issuedAt:now, expiresAt:now+Math.floor(validityHours*3600000) };
  const envelope = signUpdateEnvelope(payload,pem,now);
  let previous;
  try {
    const raw = await bounded(join(destination,'manifest.json'));
    const issuedAt = JSON.parse(Buffer.from(JSON.parse(raw).payload,'base64')).issuedAt;
    previous = verifyUpdateEnvelope(raw,pinned,issuedAt); // Permit renewal of an expired, but correctly signed, identical APK.
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && (payload.versionCode < previous.versionCode || payload.versionCode === previous.versionCode &&
      ['sha256','signerSha256','versionName','size','minSdk','packageName'].some(key => payload[key] !== previous[key]))) throw new Error('Refusing rollback or a different APK under an existing versionCode');
  await mkdir(destination,{recursive:true});
  const target = join(destination,`mirea-android-${payload.versionCode}.apk`);
  try { await copyFile(apkPath,target,constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST' || await hashFile(target) !== payload.sha256) throw error; }
  const temp = join(destination,`.manifest-${randomUUID()}.tmp`);
  try {
    const outputFile = await open(temp,'wx',0o600);
    try { await outputFile.writeFile(envelope+'\n'); await outputFile.sync(); } finally { await outputFile.close(); }
    await rename(temp,join(destination,'manifest.json'));
  } finally { await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
  return { versionCode:payload.versionCode, versionName:payload.versionName, sha256:payload.sha256, signerSha256:payload.signerSha256, expiresAt:new Date(payload.expiresAt).toISOString(), output:destination };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const flags={}; for(const value of process.argv.slice(2)){const match=value.match(/^--([a-z-]+)=(.+)$/);if(!match)throw new Error('Use --name=value arguments');flags[match[1]]=match[2];}
  console.log(JSON.stringify(await publishAndroidUpdate({apk:flags.apk,apkUrl:flags['apk-url'],privateKey:flags['private-key'],output:flags.output,sdk:flags.sdk,java:flags.java,validityHours:flags['validity-hours']===undefined?168:Number(flags['validity-hours'])}),null,2));
}
