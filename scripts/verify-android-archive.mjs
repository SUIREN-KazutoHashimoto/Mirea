import { open, mkdtemp, copyFile, unlink, rmdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { MAX_APK_BYTES } from '../server/update-manifest.js';

// A concurrent build must not replace the APK between signature verification,
// hashing and publication. Only this private snapshot is passed to those steps.
export async function withAndroidApkSnapshot(apk, work) {
  const source = await stat(apk);
  if (!source.isFile() || source.size < 1 || source.size > MAX_APK_BYTES) throw Error('APK size must be 1–512 MiB');
  const directory = await mkdtemp(join(tmpdir(), 'mirea-android-publish-')), snapshot = join(directory, 'candidate.apk');
  try {
    await copyFile(apk, snapshot, constants.COPYFILE_EXCL);
    return await work(snapshot);
  } finally {
    await unlink(snapshot).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
}

// Check the bytes being published, not only the build directory. This is an
// integrity/credential-leak check, not a malware scanner or Play Protect verdict.
export async function verifyAndroidArchive(path) {
  const file = await open(path, 'r');
  let zip;
  try {
    const size = (await file.stat()).size;
    if (size < 1 || size > MAX_APK_BYTES) throw Error('APK size must be 1–512 MiB');
    zip = await new Promise((resolve, reject) => yauzl.open(path, { lazyEntries: true, strictFileNames: true, autoClose: false }, (error, value) => error ? reject(error) : resolve(value)));
    const names = new Set(); let expandedBytes = 0;
    await new Promise((resolve, reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', entry => { void (async () => {
        const name = entry.fileName;
        if (names.has(name) || names.size >= 20000) throw Error('Duplicate or excessive APK archive members');
        names.add(name);
        if (entry.generalPurposeBitFlag & 1) throw Error('Encrypted APK archive member');
        if (/(?:\.jks|\.keystore|\.p12|\.pfx|(?:^|\/)\.env(?:\.[^/]*)?|signing\.properties|private[^/]*\.pem)$/i.test(name)) throw Error('Private credential file in APK');
        const header = Buffer.alloc(30);
        if ((await file.read(header, 0, 30, entry.relativeOffsetOfLocalHeader)).bytesRead !== 30 || header.readUInt32LE(0) !== 0x04034b50) throw Error('Invalid APK ZIP local header');
        const localName = Buffer.alloc(header.readUInt16LE(26));
        if ((await file.read(localName, 0, localName.length, entry.relativeOffsetOfLocalHeader + 30)).bytesRead !== localName.length || localName.toString('utf8') !== name) throw Error('APK ZIP local/central filenames disagree');
        if (header.readUInt16LE(6) !== entry.generalPurposeBitFlag || header.readUInt16LE(8) !== entry.compressionMethod) throw Error('APK ZIP local/central flags disagree');
        if (!(entry.generalPurposeBitFlag & 8) && (header.readUInt32LE(14) !== entry.crc32 || header.readUInt32LE(18) !== entry.compressedSize || header.readUInt32LE(22) !== entry.uncompressedSize)) throw Error('APK ZIP local/central CRC or sizes disagree');
        expandedBytes += entry.uncompressedSize;
        if (expandedBytes > MAX_APK_BYTES * 2) throw Error('Expanded APK exceeds 1 GiB');
        const stream = await new Promise((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value)));
        let checksum = 0, bytes = 0, tail = Buffer.alloc(0);
        for await (const chunk of stream) {
          checksum = crc32(chunk, checksum); bytes += chunk.length;
          const sample = Buffer.concat([tail, chunk]);
          if (/-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(sample.toString('latin1'))) throw Error('Private signing key in APK');
          tail = sample.subarray(Math.max(0, sample.length - 80));
        }
        if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) throw Error('APK ZIP contents failed CRC/size verification');
        zip.readEntry();
      })().catch(reject); });
      zip.readEntry();
    });
    if (!names.has('AndroidManifest.xml') || !names.has('classes.dex')) throw Error('Missing standalone APK members');
    return { entries: names.size, expandedBytes };
  } finally { zip?.close(); await file.close(); }
}
