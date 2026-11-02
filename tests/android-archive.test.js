import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { verifyAndroidArchive, withAndroidApkSnapshot } from '../scripts/verify-android-archive.mjs';

function zip(entries) {
  const files = [], records = []; let offset = 0;
  for (const {name, localName = name, data = 'fixture', badCrc = false, badLocalCrc = false, badLocalSize = false, descriptor = false} of entries) {
    const bytes = Buffer.from(data), n = Buffer.from(name), local = Buffer.from(localName), crc = (crc32(bytes) + Number(badCrc)) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20,4); h.writeUInt16LE(0x800,6); h.writeUInt32LE(crc,14); h.writeUInt32LE(bytes.length,18); h.writeUInt32LE(bytes.length,22); h.writeUInt16LE(local.length,26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt16LE(0x800,8); c.writeUInt32LE(crc,16); c.writeUInt32LE(bytes.length,20); c.writeUInt32LE(bytes.length,24); c.writeUInt16LE(n.length,28); c.writeUInt32LE(offset,42);
    let footer=Buffer.alloc(0);
    if(descriptor){h.writeUInt16LE(0x808,6);c.writeUInt16LE(0x808,8);h.fill(0,14,26);footer=Buffer.alloc(16);footer.writeUInt32LE(0x08074b50);footer.writeUInt32LE(crc,4);footer.writeUInt32LE(bytes.length,8);footer.writeUInt32LE(bytes.length,12);}
    if(badLocalCrc)h.writeUInt32LE((crc+1)>>>0,14);
    if(badLocalSize)h.writeUInt32LE(bytes.length+1,22);
    files.push(h,local,bytes,footer); records.push(c,n); offset += h.length + local.length + bytes.length + footer.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...files,directory,end]);
}
const base = [{name:'AndroidManifest.xml'}, {name:'classes.dex'}];
async function check(t, entries) { const dir=await mkdtemp(join(tmpdir(),'mirea-apk-check-')); t.after(()=>rm(dir,{recursive:true,force:true})); const path=join(dir,'synthetic.apk'); await writeFile(path,zip(entries)); return verifyAndroidArchive(path); }
test('APK archive allows normal bundled resources and public verification keys',async t=>{
  assert.equal((await check(t,[...base,{name:'assets/update-signing-public.pem',data:'-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----'},{name:'assets/public/test.js',data:'fixture JavaScript'}])).entries,4);
});
test('APK archive rejects duplicate entries and local/central parser disagreement',async t=>{
  await assert.rejects(check(t,[...base,base[1]]),/Duplicate/);
  await assert.rejects(check(t,[...base,{name:'assets/a.txt',localName:'assets/b.txt'}]),/filenames disagree/);
  await assert.rejects(check(t,[...base,{name:'assets/a.txt',badLocalCrc:true}]),/CRC or sizes disagree/);
  await assert.rejects(check(t,[...base,{name:'assets/a.txt',badLocalSize:true}]),/CRC or sizes disagree/);
});
test('APK archive accepts ZIP data descriptors with CRC/sizes in the central record',async t=>{assert.equal((await check(t,[...base,{name:'assets/a.txt',descriptor:true}])).entries,3);});
test('APK archive rejects damaged payloads and path traversal',async t=>{
  await assert.rejects(check(t,[...base,{name:'assets/a.txt',badCrc:true}]),/CRC/);
  await assert.rejects(check(t,[...base,{name:'../outside.txt'}]),/invalid relative path/);
});
test('APK archive rejects secrets without including secret contents in errors',async t=>{
  for(const entry of [{name:'assets/signing.properties'},{name:'assets/.env.production'},{name:'assets/signing.p12'},{name:'assets/resource.txt',data:'x'.repeat(65520)+'-----BEGIN PRIVATE KEY-----\nSENSITIVE-DATA'}]) {
    await assert.rejects(check(t,[...base,entry]),error=>/Private/.test(error.message)&&!error.message.includes('SENSITIVE-DATA'));
  }
});
test('APK archive requires standalone manifest and dex',async t=>{await assert.rejects(check(t,[{name:'assets/resource.txt'}]),/Missing standalone/);});
test('APK publication snapshot stays consistent during a concurrent rebuild and is cleaned after failure',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mirea-apk-source-')); t.after(()=>rm(dir,{recursive:true,force:true}));const source=join(dir,'release.apk');await writeFile(source,'first build');let snapshot;
  await assert.rejects(withAndroidApkSnapshot(source,async path=>{snapshot=path;await writeFile(source,'second build');assert.equal(await readFile(path,'utf8'),'first build');throw Error('deliberate verifier failure');}),/deliberate verifier failure/);
  await assert.rejects(access(snapshot),{code:'ENOENT'});assert.equal(await readFile(source,'utf8'),'second build');
});
