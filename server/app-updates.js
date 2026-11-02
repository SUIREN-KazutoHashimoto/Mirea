import {createReleaseUpdate} from './remote-app-update.js';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseRange, httpError } from './security.js';
import { verifyUpdateEnvelope } from './update-manifest.js';

// This directory contains PUBLIC distribution files, never signing keys or credentials.
export function registerAppUpdates(app, { directory, publicKey, releaseVersion, fetcher } = {}) {
  const root = directory ? resolve(directory) : null;
  const release=!root&&releaseVersion?createReleaseUpdate(releaseVersion,{fetcher,publicKey}):null;
  let trustedKey, verifiedFingerprint, verification;
  async function bundle() {
    if(!root&&release){try{return {...await release(),file:{close:async()=>{}},remote:true};}catch{throw httpError(503,'署名付きのAPK更新情報を取得できません。GitHubへの接続と更新情報の期限を確認してください。');}}
    if (!root) throw httpError(404, 'アプリの更新はまだ公開されていません。');
    let file;
    try {
      trustedKey ??= publicKey ?? await readFile(new URL('./update-signing-public.pem', import.meta.url), 'utf8');
      const manifestFile = await open(join(root, 'manifest.json'), 'r');
      let raw;
      try {
        const info = await manifestFile.stat();
        if (!info.isFile() || info.size > 65536) throw new Error('Invalid manifest size');
        const bytes = Buffer.alloc(65537), { bytesRead } = await manifestFile.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 65536) throw new Error('Invalid manifest size');
        raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
      } finally { await manifestFile.close(); }
      const metadata = verifyUpdateEnvelope(raw, trustedKey);
      file = await open(join(root, `mirea-android-${metadata.versionCode}.apk`), 'r');
      const info = await file.stat();
      if (!info.isFile() || info.size !== metadata.size) throw new Error('Invalid APK size');
      const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${metadata.sha256}`;
      if (verifiedFingerprint !== fingerprint) {
        if (verification?.fingerprint !== fingerprint) {
          // Use an independent descriptor; callers keep their own descriptor for Range streaming.
          const checking = await open(join(root, `mirea-android-${metadata.versionCode}.apk`), 'r');
          const promise = (async () => {
            try {
              const hash = createHash('sha256');
              for await (const chunk of checking.createReadStream({ autoClose: false })) hash.update(chunk);
              const after = await checking.stat();
              if (hash.digest('hex') !== metadata.sha256 || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) throw new Error('Invalid APK hash');
              verifiedFingerprint = fingerprint;
            } finally { await checking.close(); }
          })();
          verification = { fingerprint, promise };
        }
        await verification.promise;
      }
      return { metadata, raw, file };
    } catch (error) {
      await file?.close();
      if (error.code === 'ENOENT') throw httpError(404, 'アプリの更新はまだ公開されていません。');
      if (error.statusCode) throw error;
      // Do not expose filesystem locations, parsing errors or private deployment configuration.
      throw httpError(503, '署名付きアプリ更新を検証できません。管理者に確認してください。');
    }
  }
  app.route({ method: ['GET','HEAD'], url: '/api/v1/app-updates/android/manifest', handler: async (req, reply) => {
    const { raw, file } = await bundle();
    await file.close();
    reply.type('application/json').header('Cache-Control', 'no-store, no-transform').header('Content-Length', Buffer.byteLength(raw));
    return req.method === 'HEAD' ? reply.send() : reply.send(raw);
  }});
  const apkHandler=async (req, reply) => {
    if (req.params.code!==undefined&&!/^[1-9]\d{0,9}$/.test(req.params.code)) throw httpError(404, '更新ファイルが見つかりません。');
    const { metadata, file, remote } = await bundle();
    let handedOff = false;
    try {
      if (req.params.code!==undefined&&String(metadata.versionCode) !== req.params.code) throw httpError(404, '更新ファイルが見つかりません。');
      if(remote)return reply.code(302).header('Location',metadata.apkUrl).send();
      let range;
      try { range = parseRange(req.headers.range, metadata.size); }
      catch (error) { reply.header('Content-Range', `bytes */${metadata.size}`); throw error; }
      reply.type('application/vnd.android.package-archive').header('Cache-Control', 'no-store, no-transform')
        .header('Accept-Ranges', 'bytes').header('Content-Disposition', `attachment; filename="mirea-android-${metadata.versionCode}.apk"`)
        .header('Content-Length', range ? range.end - range.start + 1 : metadata.size);
      if (range) reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`);
      if (req.method === 'HEAD') return reply.send();
      const stream = file.createReadStream(range ?? {}); handedOff = true;
      return reply.send(stream);
    } finally { if (!handedOff) await file.close(); }
  };
  app.route({method:['GET','HEAD'],url:'/api/v1/app-updates/android/apk/:code',handler:apkHandler});
  app.route({method:['GET','HEAD'],url:'/api/v1/app-updates/android/latest.apk',handler:apkHandler});
}
