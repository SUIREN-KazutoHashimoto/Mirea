import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, access, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from './runtime.js';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openDatabase, transaction } from './database.js';
import { hashPassword, verifyPassword, hashToken, newToken, httpError, parseRange, matchesFileType } from './security.js';
import { IMAGE_BOOK_MIME, IMAGE_TYPES, MAX_BOOK_PAGES, MAX_IMAGE_BYTES, imageExtension, createMediaProcessor, createThumbnailStore, removeItemDirectory } from './media.js';
import { registerResumableUploads } from './resumable.js';
import { registerVideoPreviews } from './video-previews.js';
import { registerAnalytics } from './analytics.js';
import { registerProgress, publicProgress } from './progress.js';
import { registerDownloads } from './downloads.js';
import { registerSeries, shelfSeries, shelfSeriesMembership } from './series.js';
import { registerAccounts } from './accounts.js';
import { EPUB_MIME, EPUB_BUNDLE_MIME, MAX_EPUB_BYTES } from './ebook-types.js';
import packageInfo from '../package.json' with {type:'json'};
import { VIDEO_TYPES } from './video-types.js';
import { createVideoTranscoder } from './video-transcode.js';
import { registerVideoStreams, videoMetadata } from './video-stream.js';
import { AUDIO_TYPES, isAudio, isTimedMime } from './audio-types.js';
import { createAudioTranscoder } from './audio-transcode.js';
import { registerAppUpdates } from './app-updates.js';
import {createAdminAccess} from './admin-access.js';
import {registerAdmin} from './admin.js';
import {registerAdminJobs} from './admin-jobs.js';
import {createMaintenanceGate} from './maintenance-gate.js';
import {registerAdminBackups} from './admin-backups.js';
import {registerServerUpdates} from './server-updates.js';

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const TICKET_MS = 60 * 60 * 1000;
const text = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const email = { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' };
const password = text(128, 12);
const credentials = object({ email, password });
const memberRole = { type: 'string', enum: ['editor', 'viewer'] };
const publicUser = u => ({ id: u.id, email: u.email, name: u.name });
const publicItem = i => ({
  id: i.id, shelfId: i.shelf_id, title: i.title, filename: i.filename, mimeType: i.mime_type,
  kind: i.mime_type === IMAGE_BOOK_MIME ? 'image-book' : i.mime_type === EPUB_MIME ? 'epub' : i.mime_type === 'application/pdf' ? 'pdf' : isAudio(i.mime_type) ? 'audio' : 'video',
  pageCount: i.page_count, thumbnailUrl: `/api/v1/items/${i.id}/thumbnail`, size: i.size, createdAt: i.created_at
});

export async function createApp(options = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
  const uploadDir = join(dataDir, 'uploads');
  const stagingDir = join(uploadDir, 'staging');
  const booksDir = join(uploadDir, 'books');
  const thumbnailDir = join(dataDir, 'thumbnails');
  const videoDir=join(dataDir,'videos'),originalDir=join(dataDir,'originals'),previewDir=join(dataDir,'previews');
  await Promise.all([uploadDir, stagingDir, booksDir, thumbnailDir, videoDir, originalDir, previewDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const db = openDatabase(join(dataDir, 'mirea.sqlite'));
  const media = options.mediaProcessor ?? createMediaProcessor();
  const videoTranscoder=options.videoTranscoder??createVideoTranscoder();
  const audioTranscoder=options.audioTranscoder??createAudioTranscoder();
  const ensureThumbnail = createThumbnailStore(db, media, uploadDir, thumbnailDir);
  const maxUploadBytes = Number(options.maxUploadBytes ?? process.env.MAX_UPLOAD_BYTES ?? 2147483648);
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) throw new Error('Invalid MAX_UPLOAD_BYTES');
  const chunkSize = Number(options.chunkSize ?? process.env.UPLOAD_CHUNK_BYTES ?? 8 * 1024 * 1024);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < (options.chunkSize ? 1 : 64 * 1024) || chunkSize > 16 * 1024 * 1024) throw new Error('Invalid UPLOAD_CHUNK_BYTES (64 KiB–16 MiB)');
  const allowedOrigins = options.corsOrigins ?? (process.env.CORS_ORIGINS ?? 'https://localhost').split(',').map(x => x.trim()).filter(Boolean);
  const allowRegistration = options.allowRegistration ?? process.env.ALLOW_REGISTRATION !== 'false';
  const app = Fastify({ logger: options.logger ? {
    serializers: { req: req => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }) }
  } : false, ...(options.https?{https:options.https}:{}), bodyLimit: 16384, requestTimeout: 30 * 60 * 1000, trustProxy: false });
  const maintenance=createMaintenanceGate(app);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, Boolean(origin && allowedOrigins.includes(origin))),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Range', 'X-Chunk-SHA256'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'X-Next-Cursor','X-Chunk-SHA256'],
    maxAge: 600
  });
  await app.register(rateLimit, { global: false, max: 10, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { files: MAX_BOOK_PAGES, fields: 2, parts: MAX_BOOK_PAGES + 2, fileSize: maxUploadBytes, fieldSize: 800 } });
  const dummyHash = await hashPassword(newToken());
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('DELETE FROM playback_tickets WHERE expires_at <= ?').run(Date.now());
  const sweep = setInterval(() => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('DELETE FROM playback_tickets WHERE expires_at <= ?').run(Date.now());
  }, 30 * 60 * 1000);
  sweep.unref();
  app.addHook('onClose', async () => { clearInterval(sweep); db.close(); });
  app.addHook('onSend', async (req, reply, payload) => {
    if(req.url.split('?')[0]==='/download-sw.js')reply.header('Service-Worker-Allowed','/').header('Cache-Control','no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', req.url.startsWith('/api/v1/app-updates/') ? 'no-store, no-transform' : req.url.split('?')[0].endsWith('/content') || req.url.includes('/hls/') ? 'private, no-store, no-transform' : 'no-store');
    return payload;
  });
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, 'Request failed');
    const message = err.validation ? '入力内容を確認してください。' : status === 500 ? 'サーバーでエラーが発生しました。' : err.message;
    reply.code(status).send({ error: message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: '見つかりません。' }));

  function authenticate(req) {
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const session = token && db.prepare(`SELECT s.*, u.email, u.name FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE token_hash=? AND expires_at>?`).get(hashToken(token), Date.now());
    if (!session) throw httpError(401, 'ログインしてください。');
    if(!adminAccess.enabled(session.user_id))throw httpError(401,'アカウントは停止中です。');
    req.session = session;
    req.user = { id: session.user_id, email: session.email, name: session.name };
  }
  function membership(shelfId, userId, roles) {
    const member = db.prepare('SELECT role FROM memberships WHERE shelf_id=? AND user_id=?').get(shelfId, userId);
    if (!member) throw httpError(404, '本棚が見つかりません。');
    if (roles && !roles.includes(member.role)) throw httpError(403, 'この操作を行う権限がありません。');
    return member.role;
  }
  function findItem(id, userId, roles) {
    if(!adminAccess.enabled(userId))throw httpError(401,'アカウントは停止中です。');
    const item = db.prepare('SELECT * FROM items WHERE id=?').get(id);
    if (!item) throw httpError(404, 'コンテンツが見つかりません。');
    membership(item.shelf_id, userId, roles);
    return item;
  }
  function loginResult(user) {
    const token = newToken();
    const expiresAt = Date.now() + SESSION_MS;
    db.prepare('INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)').run(randomUUID(), hashToken(token), user.id, expiresAt);
    return { user: publicUser(user), token, expiresAt };
  }
  const auth = { preHandler: async req => authenticate(req) };
  const adminAccess=createAdminAccess(db,options,authenticate);
  const authLimits = { config: { rateLimit: options.rateLimit === false ? false : { max: 10, timeWindow: '1 minute' } } };
  app.get('/api/health', async () => ({ status: 'ok',version:packageInfo.version,maintenanceLocked:maintenance.locked }));
  const updatesPath = options.appUpdatesDir ?? process.env.APP_UPDATES_DIR;
  registerAppUpdates(app, { directory: updatesPath ? resolve(PROJECT_ROOT, updatesPath) : undefined });
  let analytics;
  app.get('/api/v1/config', async () => ({ allowRegistration, maxUploadBytes, maxBookPages: MAX_BOOK_PAGES, maxImageBytes: MAX_IMAGE_BYTES, maxEpubBytes: MAX_EPUB_BYTES, uploadChunkBytes: chunkSize, uploadSessionHours: 24, analytics,
    version: packageInfo.version, androidApkUrl: 'https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/download/v0.3.0beta/mirea-0.3.0beta-android.apk' }));
  app.post('/api/v1/auth/register', { ...authLimits, schema: { body: object({ email, password, name: text(80) }) } }, async (req, reply) => {
    if (!allowRegistration) throw httpError(403, '新規登録は現在停止しています。');
    const normalizedEmail = req.body.email.trim().toLowerCase();
    const name = req.body.name.trim();
    if (!name) throw httpError(400, '表示名を入力してください。');
    const passwordHash = await hashPassword(req.body.password);
    const user = { id: randomUUID(), email: normalizedEmail, name };
    try {
      db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(user.id, user.email, user.name, passwordHash, Date.now());
    } catch (err) {
      if (err.code === 'ERR_SQLITE_ERROR' && err.message.includes('UNIQUE')) throw httpError(409, 'このメールアドレスは登録済みです。');
      throw err;
    }
    return reply.code(201).send(loginResult(user));
  });
  app.post('/api/v1/auth/login', { ...authLimits, schema: { body: credentials } }, async req => {
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(req.body.email.trim().toLowerCase());
    const valid = await verifyPassword(req.body.password, user?.password_hash ?? dummyHash);
    if (!user || !valid || !adminAccess.enabled(user.id)) throw httpError(401, 'メールアドレスまたはパスワードが違います。');
    return loginResult(user);
  });
  app.get('/api/v1/auth/me', auth, async req => ({ user: req.user }));
  app.get('/api/v1/history',auth,async req=>({items:db.prepare(`SELECT i.*,MAX(v.last_received_at) AS lastSeenAt FROM analytics_views v JOIN items i ON i.id=v.asset_id JOIN memberships m ON m.shelf_id=i.shelf_id AND m.user_id=? WHERE v.user_id=? AND v.context='viewer' AND v.counted=1 GROUP BY i.id ORDER BY lastSeenAt DESC,i.id LIMIT 100`).all(req.user.id,req.user.id).map(item=>({...publicItem(item),lastSeenAt:item.lastSeenAt}))}));
  app.post('/api/v1/auth/logout', auth, async (req, reply) => {
    db.prepare('DELETE FROM sessions WHERE id=?').run(req.session.id);
    return reply.code(204).send();
  });
  app.get('/api/v1/shelves', auth, async req => ({ shelves: db.prepare(`
    SELECT s.*, m.role, (SELECT COUNT(*) FROM items i WHERE i.shelf_id=s.id) AS itemCount,
      (SELECT COUNT(*) FROM memberships n WHERE n.shelf_id=s.id) AS memberCount
    FROM shelves s JOIN memberships m ON m.shelf_id=s.id WHERE m.user_id=? ORDER BY s.created_at DESC, s.id
  `).all(req.user.id) }));
  app.post('/api/v1/shelves', { ...auth, schema: { body: object({ name: text(100), description: text(500, 0) }, ['name']) } }, async (req, reply) => {
    const name = req.body.name.trim();
    if (!name) throw httpError(400, '本棚の名前を入力してください。');
    const id = randomUUID();
    transaction(db, () => {
      db.prepare('INSERT INTO shelves VALUES (?, ?, ?, ?)').run(id, name, req.body.description?.trim() ?? '', Date.now());
      db.prepare('INSERT INTO memberships VALUES (?, ?, ?)').run(id, req.user.id, 'owner');
    });
    return reply.code(201).send({ id });
  });
  app.get('/api/v1/shelves/:id/members', auth, async req => {
    membership(req.params.id, req.user.id, ['owner']);
    return { members: db.prepare(`SELECT u.id, u.email, u.name, m.role FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.shelf_id=? ORDER BY m.role, u.name`).all(req.params.id) };
  });
  app.post('/api/v1/shelves/:id/members', { ...auth, schema: { body: object({ email, role: memberRole }) } }, async (req, reply) => {
    membership(req.params.id, req.user.id, ['owner']);
    const user = db.prepare('SELECT id FROM users WHERE email=?').get(req.body.email.trim().toLowerCase());
    if (!user) throw httpError(404, '登録済みのアカウントを指定してください。');
    if (db.prepare('SELECT 1 FROM memberships WHERE shelf_id=? AND user_id=?').get(req.params.id, user.id)) {
      throw httpError(409, 'このアカウントはすでに本棚に参加しています。');
    }
    db.prepare('INSERT INTO memberships VALUES (?, ?, ?)').run(req.params.id, user.id, req.body.role);
    return reply.code(201).send({ id: user.id });
  });
  app.patch('/api/v1/shelves/:id/members/:userId', { ...auth, schema: { body: object({ role: memberRole }) } }, async (req, reply) => {
    membership(req.params.id, req.user.id, ['owner']);
    const result = db.prepare("UPDATE memberships SET role=? WHERE shelf_id=? AND user_id=? AND role!='owner'").run(req.body.role, req.params.id, req.params.userId);
    if (!result.changes) throw httpError(400, '管理者の権限変更、または存在しないメンバーの更新はできません。');
    return reply.code(204).send();
  });
  app.delete('/api/v1/shelves/:id/members/:userId', auth, async (req, reply) => {
    membership(req.params.id, req.user.id, ['owner']);
    const result = db.prepare("DELETE FROM memberships WHERE shelf_id=? AND user_id=? AND role!='owner'").run(req.params.id, req.params.userId);
    if (!result.changes) throw httpError(400, '管理者の解除、または存在しないメンバーの解除はできません。');
    return reply.code(204).send();
  });
  app.get('/api/v1/shelves/:id/items', auth, async req => {
    const role = membership(req.params.id, req.user.id);
    const shelf = db.prepare('SELECT * FROM shelves WHERE id=?').get(req.params.id);
    const progress=new Map(db.prepare(`SELECT p.* FROM asset_progress p JOIN items i ON i.id=p.asset_id WHERE p.user_id=? AND i.shelf_id=?`).all(req.user.id,req.params.id).map(row=>[row.asset_id,publicProgress(row)]));
    const series=shelfSeriesMembership(db,req.params.id);
    return { shelf: { ...shelf, role }, series:shelfSeries(db,req.params.id), items: db.prepare('SELECT * FROM items WHERE shelf_id=? ORDER BY created_at DESC, id').all(req.params.id).map(item=>({...publicItem(item),series:series.get(item.id)??null,progress:progress.get(item.id)??null})) };
  });
  const uploads = await registerResumableUploads(app, {
    db, media, videoTranscoder, audioTranscoder, uploadDir, stagingDir, booksDir, thumbnailDir, videoDir, originalDir, previewDir, authenticate, membership, maxUploadBytes, chunkSize, publicItem,adminAccess,maintenance
  });
  registerVideoStreams(app,{db,videoDir,authenticate,findItem});
  registerAccounts(app, { db, authenticate, membership, loginResult, cleanupUploads: uploads.cleanupUploads, rateLimit: options.rateLimit,adminAccess });
  const videoPreviews = await registerVideoPreviews(app, { db, media, dataDir, uploadDir, authenticate, findItem });
  const adminJobs=await registerAdminJobs(app,{db,adminAccess,media,videoTranscoder,uploadDir,booksDir,thumbnailDir,previewDir,videoDir,originalDir,dataDir,uploads,maintenance,videoPreviews,ensureThumbnail});
  registerAdmin(app,{db,adminAccess,uploads,rateLimit:options.rateLimit});
  maintenance.setBusy(()=>uploads.busy||adminJobs.busy||videoPreviews.busy||media.busy);
  await registerAdminBackups(app,{db,dataDir,adminAccess,maintenance,options});
  await registerServerUpdates(app,{adminAccess,maintenance,options});
  // onClose runs in reverse order: stop encoders before waiting for either
  // upload or admin queues, so running jobs can persist a resumable state.
  app.addHook('onClose',async()=>{videoTranscoder.close();audioTranscoder.close();});
  analytics = await registerAnalytics(app, { db, authenticate, membership, findItem, options,adminAccess });
  registerProgress(app,{db,authenticate,findItem,options});
  registerSeries(app,{db,authenticate,membership,findItem,publicItem});
  try{await registerDownloads(app,{db,dataDir,uploadDir,booksDir,videoDir,authenticate,findItem,options});}catch(error){await app.close();throw error;}
  app.post('/api/v1/shelves/:id/items', auth, async (req, reply) => {
    membership(req.params.id, req.user.id, ['owner', 'editor']);
    const id = randomUUID();
    const stage = join(stagingDir, id);
    await mkdir(stage, { mode: 0o700 });
    const finalPath = join(uploadDir, id);
    const finalThumbnail = join(thumbnailDir, `${id}.jpg`);
    const pages = [];
    const files = [];
    let title = '', retainOriginal=false;
    let receivedBytes = 0, size = 0;
    let isImageBook = false;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if(part.fieldname==='retainOriginal'&&!part.valueTruncated){if(!['true','false'].includes(String(part.value)))throw httpError(400,'原本保持の指定が不正です。');retainOriginal=String(part.value)==='true';continue;}
          if (part.fieldname !== 'title' || part.valueTruncated) throw httpError(400, 'タイトルが不正です。');
          title = String(part.value).trim();
          continue;
        }
        const isImage = IMAGE_TYPES.includes(part.mimetype);
        if (part.fieldname !== 'file' || !['application/pdf', EPUB_MIME, ...VIDEO_TYPES, ...AUDIO_TYPES, ...IMAGE_TYPES].includes(part.mimetype)) {
          part.file.resume();
          throw httpError(415, 'PDF・EPUB・動画・音声、またはJPEG・PNG・WebP画像を選択してください。');
        }
        if (files.length && (!isImage || !isImageBook)) {
          part.file.resume();
          throw httpError(400, 'PDF・EPUB・動画・音声は1ファイルずつ、画像の本は画像だけを選択してください。');
        }
        isImageBook = isImage;
        const number = files.length + 1;
        const rawPath = join(stage, `raw-${number}`);
        const file = { filename: (part.filename ?? 'file').replaceAll('\\', '/').split('/').pop().slice(0, 255), mime: part.mimetype };
        let fileSize = 0, head = Buffer.alloc(0);
        const inspect = new Transform({ transform(chunk, _encoding, callback) {
          receivedBytes += chunk.length;
          fileSize += chunk.length;
          if (file.mime===EPUB_MIME && fileSize>MAX_EPUB_BYTES) return callback(httpError(413,'EPUBは64 MiB以下にしてください。'));
          if (receivedBytes > maxUploadBytes || (isImage && fileSize > MAX_IMAGE_BYTES)) {
            return callback(httpError(413, isImage && fileSize > MAX_IMAGE_BYTES ? '画像は1枚25 MiB以下にしてください。' : 'アップロードの合計サイズ上限を超えています。'));
          }
          if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
          callback(null, chunk);
        } });
        await pipeline(part.file, inspect, createWriteStream(rawPath, { flags: 'wx', mode: 0o600 }));
        if (part.file.truncated) throw httpError(413, 'ファイルのサイズ上限を超えています。');
        if (!fileSize) throw httpError(400, '空のファイルは登録できません。');
        if (!matchesFileType(file.mime, head)) throw httpError(415, 'ファイルの内容と形式が一致しません。');
        file.size=fileSize;
        files.push(file);
        if (isImage) {
          const result = await media.validateImage(rawPath);
          await rename(rawPath, join(stage, `${number}.${imageExtension(file.mime)}`));
          size += result.size;
          if (size > maxUploadBytes) throw httpError(413, '本の合計サイズが上限を超えています。');
          pages.push({ number, filename: file.filename, mime: file.mime, ...result });
        } else size = fileSize;
      }
      if (!files.length) throw httpError(400, 'ファイルを選択してください。');
      const uploaded = files[0];
      title = (title || uploaded.filename.replace(/\.[^.]+$/, '')).trim();
      if (!title || title.length > 200) throw httpError(400, 'タイトルは1〜200文字で入力してください。');
      if(isTimedMime(uploaded.mime)){
        authenticate(req);membership(req.params.id,req.user.id,['owner','editor']);
        const item=await uploads.publishMultipartMedia({id,shelfId:req.params.id,userId:req.user.id,sessionId:req.session.id,title,file:uploaded,retainOriginal});
        return reply.code(201).send({item});
      }
      const thumbnail = await media.thumbnail(join(stage, isImageBook ? `1.${imageExtension(uploaded.mime)}` : 'raw-1'), uploaded.mime, join(stage, 'thumbnail.jpg'), uploaded.mime===EPUB_MIME?join(stage,'book.json'):undefined);
      // Uploads can take a long time; recheck revoked sessions and membership before publishing.
      authenticate(req);
      membership(req.params.id, req.user.id, ['owner', 'editor']);
      await rename(join(stage, 'thumbnail.jpg'), finalThumbnail);
      if (isImageBook) await rename(stage, join(booksDir, id));
      else {
        await rename(join(stage, 'raw-1'), finalPath);
        if (uploaded.mime===EPUB_MIME) await rename(stage,join(booksDir,id));
        else await removeItemDirectory(stagingDir, id);
      }
      // Recheck after the last asynchronous operation, immediately before the database write.
      authenticate(req);
      membership(req.params.id, req.user.id, ['owner', 'editor']);
      transaction(db, () => {
        db.prepare(`INSERT INTO items (id, shelf_id, title, filename, mime_type, size, uploaded_by, created_at, page_count, thumbnail_ready)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(id, req.params.id, title, uploaded.filename, isImageBook ? IMAGE_BOOK_MIME : uploaded.mime, size, req.user.id, Date.now(), isImageBook ? pages.length : thumbnail.pageCount);
        const insertPage = db.prepare('INSERT INTO image_pages VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const page of pages) insertPage.run(id, page.number, page.filename, page.size, page.width, page.height, page.mime);
      });
      return reply.code(201).send({ item: publicItem(db.prepare('SELECT * FROM items WHERE id=?').get(id)) });
    } catch (error) {
      await Promise.allSettled([removeItemDirectory(stagingDir, id), removeItemDirectory(booksDir, id), unlink(finalPath), unlink(finalThumbnail)]);
      throw error;
    }
  });
  app.delete('/api/v1/items/:id', auth, async (req, reply) => {
    const item = findItem(req.params.id, req.user.id, ['owner', 'editor']);
    // Remove access first, then remove the underlying file. Open streams may finish.
    db.prepare('DELETE FROM items WHERE id=?').run(req.params.id);
    const results = await Promise.allSettled([
      item.mime_type === IMAGE_BOOK_MIME ? removeItemDirectory(booksDir, item.id) : unlink(join(uploadDir, item.id)),
      ...(item.mime_type===EPUB_MIME?[removeItemDirectory(booksDir,item.id)]:[]),
      unlink(join(thumbnailDir, `${item.id}.jpg`)),
      videoPreviews.remove(item.id)
      ,removeItemDirectory(videoDir,item.id),unlink(join(originalDir,item.id))
    ]);
    for (const result of results) if (result.status === 'rejected' && result.reason.code !== 'ENOENT') req.log.error({ err: result.reason }, 'Orphan file requires cleanup');
    return reply.code(204).send();
  });
  app.route({ method: ['GET', 'HEAD'], url: '/api/v1/items/:id/thumbnail', ...auth, handler: async (req, reply) => {
    const item = findItem(req.params.id, req.user.id);
    const path = await ensureThumbnail(item);
    authenticate(req);
    findItem(item.id, req.user.id);
    reply.type('image/jpeg');
    if (req.method === 'HEAD') return reply.send();
    return reply.send(createReadStream(path));
  } });
  app.get('/api/v1/items/:id/pages', auth, async req => {
    const item = findItem(req.params.id, req.user.id);
    if (item.mime_type !== IMAGE_BOOK_MIME) throw httpError(400, '画像の本ではありません。');
    return { item: publicItem(item), pages: db.prepare('SELECT * FROM image_pages WHERE item_id=? ORDER BY page_number').all(item.id).map(page => ({
      number: page.page_number, filename: page.filename, mimeType: page.mime_type, size: page.size, width: page.width, height: page.height,
      url: `/api/v1/items/${item.id}/pages/${page.page_number}/content`
    })) };
  });
  app.route({method:['GET','HEAD'],url:'/api/v1/items/:id/epub',...auth,handler:async(req,reply)=>{
    const item=findItem(req.params.id,req.user.id);
    if(item.mime_type!==EPUB_MIME)throw httpError(400,'EPUBではありません。');
    const path=join(booksDir,item.id,'book.json');
    const info=await stat(path).catch(()=>{throw httpError(404,'EPUBの閲覧データが見つかりません。');});
    authenticate(req);
    findItem(item.id,req.user.id);
    reply.type(EPUB_BUNDLE_MIME).header('Content-Length',info.size);
    return req.method==='HEAD'?reply.send():reply.send(createReadStream(path));
  }});
  app.route({ method: ['GET', 'HEAD'], url: '/api/v1/items/:id/pages/:number/content', ...auth, handler: async (req, reply) => {
    const item = findItem(req.params.id, req.user.id);
    if (item.mime_type !== IMAGE_BOOK_MIME || !/^[1-9]\d{0,3}$/.test(req.params.number)) throw httpError(404, 'ページが見つかりません。');
    const page = db.prepare('SELECT * FROM image_pages WHERE item_id=? AND page_number=?').get(item.id, Number(req.params.number));
    if (!page) throw httpError(404, 'ページが見つかりません。');
    reply.type(page.mime_type).header('Content-Length', page.size);
    if (req.method === 'HEAD') return reply.send();
    return reply.send(createReadStream(join(booksDir, item.id, `${page.page_number}.${imageExtension(page.mime_type)}`)));
  } });
  app.post('/api/v1/items/:id/playback-ticket', auth, async req => {
    const item = findItem(req.params.id, req.user.id);
    if (item.mime_type === IMAGE_BOOK_MIME) throw httpError(400, '画像の本はページビューアで開いてください。');
    const token = newToken();
    const expiresAt = Math.min(Date.now() + TICKET_MS, req.session.expires_at);
    db.prepare('INSERT INTO playback_tickets VALUES (?, ?, ?, ?)').run(hashToken(token), req.session.id, req.params.id, expiresAt);
    const metadata=videoMetadata(db,item.id);
    if(metadata)db.prepare('INSERT INTO playback_generations VALUES(?,?)').run(hashToken(token),metadata.generation??'base');
    return { url: `/api/v1/items/${req.params.id}/content?ticket=${token}`, expiresAt,
      ...(metadata?{hlsUrl:`/api/v1/items/${item.id}/hls/master.m3u8?ticket=${token}`,renditions:metadata.renditions.map(({quality,width,height,size})=>({quality,width,height,size}))}:{}) };
  });
  app.route({ method: ['GET', 'HEAD'], url: '/api/v1/items/:id/content', handler: async (req, reply) => {
    let userId;
    if (req.headers.authorization) {
      authenticate(req);
      userId = req.user.id;
    } else {
      const token = typeof req.query.ticket === 'string' && /^[A-Za-z0-9_-]{43}$/.test(req.query.ticket) ? req.query.ticket : '';
      const ticket = token && db.prepare(`SELECT s.user_id FROM playback_tickets t JOIN sessions s ON s.id=t.session_id
        WHERE t.token_hash=? AND t.item_id=? AND t.expires_at>? AND s.expires_at>?`).get(hashToken(token), req.params.id, Date.now(), Date.now());
      if (!ticket) throw httpError(401, '閲覧用URLの期限が切れています。もう一度開いてください。');
      userId = ticket.user_id;
    }
    const item = findItem(req.params.id, userId);
    if (item.mime_type === IMAGE_BOOK_MIME) throw httpError(400, '画像の本はページビューアで開いてください。');
    await access(join(uploadDir, item.id)).catch(() => { throw httpError(404, 'ファイルが見つかりません。'); });
    // Membership is checked again after I/O so revocations cannot race this response.
    findItem(req.params.id, userId);
    let range;
    try { range = parseRange(req.headers.range, item.size); }
    catch (error) { reply.header('Content-Range', `bytes */${item.size}`); throw error; }
    reply.header('Content-Type', item.mime_type);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Disposition', `inline; filename="media"; filename*=UTF-8''${encodeURIComponent(item.filename).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
    reply.header('Content-Length', range ? range.end - range.start + 1 : item.size);
    if (range) reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${item.size}`);
    if (req.method === 'HEAD') return reply.send();
    return reply.send(createReadStream(join(uploadDir, item.id), range ?? {}));
  } });
  const webRoot = options.webRoot ?? fileURLToPath(new URL('../dist/', import.meta.url));
  try {
    await access(join(webRoot, 'index.html'));
    await app.register(fastifyStatic, { root: webRoot, prefix: '/', dotfiles: 'deny' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return app;
}
