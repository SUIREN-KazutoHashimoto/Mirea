import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { httpError } from './security.js';
import { IMAGE_TYPES, MAX_BOOK_PAGES, MAX_IMAGE_BYTES, removeItemDirectory } from './media.js';
import { publishStagedUpload } from './upload-publish.js';

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MIME_TYPES = ['application/pdf', 'video/mp4', 'video/webm', ...IMAGE_TYPES];
const integer = { type: 'integer', minimum: 0 };

export async function registerResumableUploads(app, context) {
  const { db, uploadDir, stagingDir, authenticate, membership, maxUploadBytes, chunkSize, publicItem } = context;
  const transferDir = join(uploadDir, 'transfers');
  await mkdir(transferDir, { recursive: true, mode: 0o700 });
  const locked = new Set(), jobs = new Map();
  let queue = Promise.resolve(), closing = false;
  const auth = { onRequest: async req => authenticate(req) };
  const get = id => db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(id);
  function owned(req) {
    const upload = get(req.params.id);
    if (!upload || upload.user_id !== req.user.id) throw httpError(404, 'アップロードが見つかりません。');
    membership(upload.shelf_id, req.user.id, ['owner', 'editor']);
    if (upload.expires_at <= Date.now()) throw httpError(410, 'アップロードの有効期限が切れました。ファイルを選択し直してください。');
    return upload;
  }
  function authorizeJob(upload) {
    if (get(upload.id)?.state !== 'processing') throw httpError(409, 'アップロードをキャンセルしました。');
    const session = db.prepare('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?').get(upload.session_id, upload.user_id, Date.now());
    if (!session) throw httpError(401, 'ログインの有効期限が切れました。');
    membership(upload.shelf_id, upload.user_id, ['owner', 'editor']);
  }
  function status(upload) {
    const parts = db.prepare('SELECT file_index,part_index,size,sha256 FROM upload_parts WHERE upload_id=? ORDER BY file_index,part_index').all(upload.id);
    const item = upload.state === 'complete' && db.prepare('SELECT * FROM items WHERE id=?').get(upload.id);
    return {
      id: upload.id, state: upload.state, chunkSize: upload.chunk_size, expiresAt: upload.expires_at,
      receivedBytes: parts.reduce((sum, part) => sum + part.size, 0),
      files: JSON.parse(upload.files_json).map((file, index) => {
        const received = parts.filter(part => part.file_index === index);
        return { ...file, receivedParts: received.map(part => part.part_index), receivedHashes: Object.fromEntries(received.map(part => [part.part_index, part.sha256])) };
      }),
      ...(upload.error ? { error: upload.error } : {}), ...(item ? { item: publicItem(item) } : {})
    };
  }
  async function exclusive(id, work) {
    if (locked.has(id)) throw httpError(409, '同じアップロードを処理中です。再試行してください。');
    locked.add(id);
    try { return await work(); } finally { locked.delete(id); }
  }
  async function discard(id) {
    await Promise.all([removeItemDirectory(transferDir, id), removeItemDirectory(stagingDir, id)]);
  }
  function schedule(id) {
    if (jobs.has(id) || closing) return;
    const job = queue.then(async () => {
      const upload = get(id);
      if (!upload || upload.state !== 'processing') { if (upload?.state === 'cancelled') await discard(id); return; }
      const existing = db.prepare('SELECT 1 FROM items WHERE id=?').get(id);
      if (existing) {
        db.prepare("UPDATE upload_sessions SET state='complete' WHERE id=?").run(id);
        await discard(id);
        return;
      }
      try {
        authorizeJob(upload);
        await removeItemDirectory(stagingDir, id);
        const stage = join(stagingDir, id);
        await mkdir(stage, { mode: 0o700 });
        const files = JSON.parse(upload.files_json);
        for (const [fileIndex, file] of files.entries()) {
          const count = Math.ceil(file.size / upload.chunk_size);
          // Async iteration and pipeline keep assembly bounded by stream buffers.
          const source = Readable.from((async function* () {
            for (let index = 0; index < count; index++) {
              authorizeJob(upload);
              const part = db.prepare('SELECT * FROM upload_parts WHERE upload_id=? AND file_index=? AND part_index=?').get(id, fileIndex, index);
              const hash = createHash('sha256');
              let size = 0;
              for await (const bytes of createReadStream(join(transferDir, id, `${fileIndex}-${index}`))) {
                size += bytes.length;
                hash.update(bytes);
                yield bytes;
              }
              if (!part || part.size !== size || part.sha256 !== hash.digest('hex')) throw httpError(422, '保存した分割データを検証できません。選択し直してアップロードしてください。');
            }
          })());
          await pipeline(source, createWriteStream(join(stage, `raw-${fileIndex + 1}`), { flags: 'wx', mode: 0o600 }));
        }
        await publishStagedUpload(context, upload, () => authorizeJob(upload));
      } catch (error) {
        db.prepare("UPDATE upload_sessions SET state='failed',error=? WHERE id=? AND state='processing'").run(
          error.statusCode ? error.message : 'メディアの保存に失敗しました。選択し直してください。', id);
        app.log.error({ err: error, uploadId: id }, 'Upload processing failed');
      } finally {
        await discard(id);
      }
    }).catch(error => { app.log.error({ err: error, uploadId: id }, 'Upload cleanup failed'); });
    queue = job;
    jobs.set(id, job);
    job.finally(() => jobs.delete(id));
  }
  async function sweep() {
    for (const row of db.prepare('SELECT id FROM upload_sessions WHERE expires_at<=?').all(Date.now())) {
      if (jobs.has(row.id) || locked.has(row.id)) continue;
      await exclusive(row.id, async () => {
        await discard(row.id);
        db.prepare('DELETE FROM upload_sessions WHERE id=?').run(row.id);
      });
    }
  }
  await sweep();
  // A single container owns the SQLite volume and queue. Durable processing jobs
  // are reassembled and retried after restart; no browser connection is required.
  for (const row of db.prepare("SELECT id FROM upload_sessions WHERE state='processing'").all()) schedule(row.id);
  let cleanup = Promise.resolve();
  const timer = setInterval(() => { cleanup = sweep().catch(error => app.log.error(error)); }, 30 * 60 * 1000);
  timer.unref();
  app.addHook('onClose', async () => { closing = true; clearInterval(timer); await queue; await cleanup; });

  app.post('/api/v1/shelves/:id/uploads', {
    ...auth, bodyLimit: 256 * 1024,
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['title', 'files'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        files: { type: 'array', minItems: 1, maxItems: MAX_BOOK_PAGES, items: {
          type: 'object', additionalProperties: false, required: ['filename', 'mime', 'size'],
          properties: { filename: { type: 'string', minLength: 1, maxLength: 255 }, mime: { enum: MIME_TYPES }, size: { type: 'integer', minimum: 1, maximum: maxUploadBytes } }
        } }
      }
    } }
  }, async (req, reply) => {
    membership(req.params.id, req.user.id, ['owner', 'editor']);
    const title = req.body.title.trim(), files = req.body.files;
    if (!title) throw httpError(400, 'タイトルを入力してください。');
    if (files.length > 1 && !files.every(file => IMAGE_TYPES.includes(file.mime))) throw httpError(400, '画像の本は画像だけを選択してください。PDF・動画は1ファイルずつ登録します。');
    if (files.some(file => IMAGE_TYPES.includes(file.mime) && file.size > MAX_IMAGE_BYTES) || files.reduce((sum, file) => sum + file.size, 0) > maxUploadBytes) {
      throw httpError(413, 'アップロードの合計、または画像1枚のサイズ上限を超えています。');
    }
    const active = db.prepare("SELECT COUNT(*) AS n FROM upload_sessions WHERE user_id=? AND state IN ('uploading','processing') AND expires_at>?").get(req.user.id, Date.now()).n;
    if (active >= 3) throw httpError(429, '同時アップロードは3件までです。不要なアップロードを取り消してください。');
    const id = randomUUID(), now = Date.now();
    try {
      // Count and reserve synchronously before filesystem I/O: concurrent
      // requests cannot all pass the per-user active-upload limit.
      db.prepare(`INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,'uploading',?,?)`).run(id, req.params.id, req.user.id, req.session.id, title,
        JSON.stringify(files.map(file => ({ ...file, filename: file.filename.replaceAll('\\', '/').split('/').pop() || 'file' }))), chunkSize, now, now + UPLOAD_TTL_MS);
      await mkdir(join(transferDir, id), { mode: 0o700 });
      authenticate(req);
      membership(req.params.id, req.user.id, ['owner', 'editor']);
    } catch (error) { db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id); await discard(id); throw error; }
    return reply.code(201).send(status(get(id)));
  });
  app.get('/api/v1/uploads/:id', auth, async req => status(owned(req)));

  await app.register(async routes => {
    routes.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    routes.put('/api/v1/uploads/:id/files/:fileIndex/parts/:partIndex', {
      ...auth, bodyLimit: chunkSize,
      schema: { params: { type: 'object', required: ['id','fileIndex','partIndex'], properties: { id: { type: 'string' }, fileIndex: integer, partIndex: integer } } }
    }, async (req, reply) => {
      await exclusive(req.params.id, async () => {
        const upload = owned(req);
        if (upload.state !== 'uploading') throw httpError(409, 'このアップロードは受信中ではありません。');
        const files = JSON.parse(upload.files_json), { fileIndex, partIndex } = req.params;
        const file = files[fileIndex];
        if (!file || partIndex >= Math.ceil(file.size / upload.chunk_size)) throw httpError(400, '分割番号が不正です。');
        const expectedSize = Math.min(upload.chunk_size, file.size - partIndex * upload.chunk_size);
        const expectedHash = req.headers['x-chunk-sha256'];
        if (!/^[a-f0-9]{64}$/.test(expectedHash ?? '')) throw httpError(400, '分割データのSHA-256が必要です。');
        if (req.headers['content-length'] && Number(req.headers['content-length']) !== expectedSize) throw httpError(400, '分割データの長さが不正です。');
        const temporary = join(transferDir, upload.id, `${fileIndex}-${partIndex}.${randomUUID()}.partial`);
        const hash = createHash('sha256');
        let size = 0;
        try {
          const inspect = new Transform({ transform(bytes, _encoding, done) {
            size += bytes.length;
            if (size > expectedSize) return done(httpError(413, '分割データのサイズ上限を超えています。'));
            hash.update(bytes);
            done(null, bytes);
          } });
          await pipeline(req.body, inspect, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
          if (size !== expectedSize || hash.digest('hex') !== expectedHash) throw httpError(422, '分割データの長さ、またはSHA-256が一致しません。');
          authenticate(req);
          owned(req);
          const previous = db.prepare('SELECT size,sha256 FROM upload_parts WHERE upload_id=? AND file_index=? AND part_index=?').get(upload.id, fileIndex, partIndex);
          if (previous) {
            if (previous.size !== size || previous.sha256 !== expectedHash) throw httpError(409, '受信済みの分割データと一致しません。');
          } else {
            const destination = join(transferDir, upload.id, `${fileIndex}-${partIndex}`);
            // A crash between rename and INSERT can leave an uncommitted part.
            await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
            await rename(temporary, destination);
            authenticate(req);
            owned(req);
            db.prepare('INSERT INTO upload_parts VALUES(?,?,?,?,?)').run(upload.id, fileIndex, partIndex, size, expectedHash);
          }
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      });
      return reply.code(204).send();
    });
  });
  app.post('/api/v1/uploads/:id/complete', auth, async (req, reply) => {
    const result = await exclusive(req.params.id, async () => {
      const upload = owned(req);
      if (upload.state === 'uploading') {
        const expected = JSON.parse(upload.files_json).reduce((sum, file) => sum + Math.ceil(file.size / upload.chunk_size), 0);
        const count = db.prepare('SELECT COUNT(*) AS n FROM upload_parts WHERE upload_id=?').get(upload.id).n;
        if (count !== expected) throw httpError(409, '未受信の分割データがあります。');
        db.prepare("UPDATE upload_sessions SET state='processing',session_id=? WHERE id=?").run(req.session.id, upload.id);
        schedule(upload.id);
      }
      const current = get(upload.id);
      if (current.state === 'failed' || current.state === 'cancelled') throw httpError(409, current.error || 'このアップロードは取り消されています。');
      return status(current);
    });
    return reply.code(result.state === 'complete' ? 200 : 202).send(result);
  });
  app.delete('/api/v1/uploads/:id', auth, async (req, reply) => {
    await exclusive(req.params.id, async () => {
      const upload = owned(req);
      if (upload.state === 'complete') throw httpError(409, '保存済みです。コンテンツ一覧から削除してください。');
      db.prepare("UPDATE upload_sessions SET state='cancelled' WHERE id=?").run(upload.id);
      if (!jobs.has(upload.id)) await discard(upload.id);
    });
    return reply.code(204).send();
  });
  return { async cleanupUploads(ids) {
    for (const id of ids) {
      try { await discard(id); }
      catch (error) { app.log.error({ err: error, uploadId: id }, 'Deleted account upload cleanup requires attention'); }
    }
  } };
}
