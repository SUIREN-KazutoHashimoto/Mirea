import {jobTiming} from './job-timing.js';
import {registerManualUploads,requireUploadSlot,manualUploadSlot} from './manual-uploads.js';
import {transferDestination} from './transfer-destination.js';
import {transaction} from './database.js';
import {registerTransferQueue,linkQueuedUpload} from './transfer-queue.js';
import {assertUploadName} from './name-integrity.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rename, unlink, open, writeFile,stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform, Readable,Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { httpError } from './security.js';
import { IMAGE_TYPES, MAX_BOOK_PAGES, MAX_IMAGE_BYTES, removeItemDirectory } from './media.js';
import { EPUB_MIME, MAX_EPUB_BYTES } from './ebook-types.js';
import { publishStagedUpload } from './upload-publish.js';
import { VIDEO_TYPES } from './video-types.js';
import { AUDIO_TYPES, isTimedMime } from './audio-types.js';
import {uploadErrorMessage} from './upload-errors.js';
import {createErrorDiagnostic} from './error-diagnostics.js';
import {normalizeDiagnostic} from './error-diagnostic-schema.js';
import packageInfo from '../package.json' with {type:'json'};

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MIME_TYPES = ['application/pdf', EPUB_MIME, ...VIDEO_TYPES, ...AUDIO_TYPES, ...IMAGE_TYPES];
const integer = { type: 'integer', minimum: 0 };

export async function registerResumableUploads(app, context) {
  const { db, uploadDir, stagingDir, authenticate, membership, maxUploadBytes, chunkSize, publicItem } = context;
  const transferDir = join(uploadDir, 'transfers');
  await mkdir(transferDir, { recursive: true, mode: 0o700 });
  const locked = new Set(), jobs = new Map(), partTransfers=new Map();
  const hasParts=id=>[...partTransfers.keys()].some(key=>key.startsWith(id+':'));
  async function stopParts(id){const rows=[...partTransfers].filter(([key])=>key.startsWith(id+':')).map(([,row])=>row);for(const row of rows)row.controller.abort();await Promise.allSettled(rows.map(row=>row.done));}
  let closing = false, sweeping=false;
  const auth = { onRequest: async req => authenticate(req) };
  const get = id => db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(id);
  registerTransferQueue(app,context);
  registerManualUploads(app,context);
  // Failed sources remain retryable, but are not running work. Use the same
  // admission rule for new transfers, multipart and both retry entry points.
  const activeCount=userId=>db.prepare("SELECT COUNT(*) AS n FROM upload_sessions WHERE user_id=? AND (state='processing' OR (state='uploading' AND expires_at>?))").get(userId,Date.now()).n;
  const requireSlot=(userId,queueId)=>requireUploadSlot(db,userId,context.processingSettings?.value.maxConcurrentUploads??3,queueId);
  function owned(req) {
    const upload = get(req.params.id);
    if (!upload || upload.user_id !== req.user.id) throw httpError(404, 'アップロードが見つかりません。');
    membership(upload.shelf_id, req.user.id, ['owner', 'editor']);
    if (upload.expires_at <= Date.now() && upload.state === 'uploading') throw httpError(410, 'アップロードの有効期限が切れました。ファイルを選択し直してください。');
    return upload;
  }
  function authorizeJob(upload) {
    if (get(upload.id)?.state !== 'processing') throw httpError(409, 'アップロードをキャンセルしました。');
    const delegated=db.prepare('SELECT * FROM admin_upload_retries WHERE upload_id=?').get(upload.id);
    if(delegated && !context.adminAccess.isAdmin(delegated.admin_id))throw httpError(403,'再試行を要求した管理者の権限が解除されました。');
    if(!context.adminAccess.enabled(upload.user_id))throw httpError(403,'アップロード者のアカウントは停止中です。');
    const session = db.prepare('SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>?').get(delegated?.session_id??upload.session_id, delegated?.admin_id??upload.user_id, Date.now());
    if (!session) throw httpError(401, 'ログインの有効期限が切れました。');
    membership(upload.shelf_id, upload.user_id, ['owner', 'editor']);
  }
  function status(upload,detail=true) {
    const parts = detail?db.prepare('SELECT file_index,part_index,size,sha256 FROM upload_parts WHERE upload_id=? ORDER BY file_index,part_index').all(upload.id):[];
    const item = db.prepare('SELECT * FROM items WHERE id=?').get(upload.id);
    const processing=JSON.parse(upload.processing_json),diagnostic=upload.state==='failed'?normalizeDiagnostic(processing.diagnostic):null;
    const page=diagnostic?.image?.page,file=page?JSON.parse(upload.files_json)[page-1]:null;
    return {
      id: upload.id,...jobTiming(db,upload.id,'upload'), shelfId:upload.shelf_id, maxParallelParts:4, protocolVersion:2, state: upload.state, chunkSize: upload.chunk_size, expiresAt: upload.expires_at,
      seriesId:upload.target_series_id,seriesWarning:upload.series_warning,
      title: upload.title, retainOriginal: Boolean(upload.retain_original), processing,
      ...(diagnostic?{diagnostic}:{}),...(file?{failedFile:{page,filename:file.filename}}:{}),
      sourceRetained: upload.state === 'failed' && isTimedMime(JSON.parse(upload.files_json)[0].mime),
      receivedBytes: detail?parts.reduce((sum,part)=>sum+part.size,0):db.prepare('SELECT COALESCE(SUM(size),0) n FROM upload_parts WHERE upload_id=?').get(upload.id).n,
      files: detail?JSON.parse(upload.files_json).map((file, index) => {
        const received = parts.filter(part => part.file_index === index);
        return { ...file, receivedParts: received.map(part => part.part_index), receivedHashes: Object.fromEntries(received.map(part => [part.part_index, part.sha256])) };
      }):undefined,
      ...(upload.error ? { error: upload.error } : {}), ...(item ? { item: publicItem(item) } : {})
    };
  }
  async function exclusive(id, work, {allowParts=false}={}) {
    if (locked.has(id)||!allowParts&&hasParts(id)) throw httpError(409, '同じアップロードを処理中です。再試行してください。');
    locked.add(id);
    try { return await work(); } finally { locked.delete(id); }
  }
  async function transferPart(id,key,work){
    key=id+':'+key;if(partTransfers.size>=128||[...partTransfers.keys()].filter(k=>k.startsWith(id+':')).length>=4)throw httpError(429,'分割転送の同時数上限です。自動的に再試行します。');if(locked.has(id)||partTransfers.has(key))throw httpError(409,'同じ分割データを処理中です。再試行してください。');
    let finish;const row={controller:new AbortController(),done:new Promise(resolve=>{finish=resolve;})};partTransfers.set(key,row);
    const timeout=setTimeout(()=>row.controller.abort(),90000);timeout.unref?.();
    try{return await work(row.controller.signal);}finally{clearTimeout(timeout);partTransfers.delete(key);finish();}
  }
  async function discard(id) {
    await Promise.all([removeItemDirectory(transferDir, id), removeItemDirectory(stagingDir, id)]);
  }
  function schedule(id) {
    if (jobs.has(id) || closing) return jobs.get(id);
    const job = context.jobPool.run(async () => {
      const upload = get(id);
      if (!upload || upload.state !== 'processing') { if (upload?.state === 'cancelled') await discard(id); return; }
      const existing = db.prepare('SELECT 1 FROM items WHERE id=?').get(id);
      if (existing) {
        if(context.mediaPipeline?.has(id)){context.mediaPipeline.pump();await removeItemDirectory(transferDir,id);return;}
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
        if(context.mediaPipeline&&isTimedMime(files[0].mime)){
          await context.mediaPipeline.accept(upload,()=>authorizeJob(upload));
          await removeItemDirectory(transferDir,id);
        }else await publishStagedUpload(context, upload, () => authorizeJob(upload));
      } catch (error) {
        const current=get(id);
        if(error.code==='SERVER_CLOSING'||!current||current.state==='cancelled')return; // durable processing state is recovered on startup
        const status=Number.isInteger(error.statusCode)&&error.statusCode>=400&&error.statusCode<=599?error.statusCode:500;
        const diagnostic=createErrorDiagnostic(error,{method:'POST',routeOptions:{url:'/api/v1/shelves/:id/uploads'}},{status,serverVersion:packageInfo.version});
        const processing={...JSON.parse(current.processing_json),stage:'failed',diagnostic};
        db.prepare("UPDATE upload_sessions SET state='failed',error=?,processing_json=? WHERE id=? AND state='processing'").run(
          uploadErrorMessage(error), JSON.stringify(processing), id);
        app.log.error({ err: error, uploadId: id, errorId:diagnostic.errorId }, 'Upload processing failed');
      } finally {
        // A failed timed-media job remains retryable indefinitely. Never sweep its source
        // just because the 24-hour *transfer* deadline elapsed.
        const state=get(id)?.state;
        if (!state || state==='complete' || state==='cancelled' || state==='failed'&&!isTimedMime(JSON.parse(upload.files_json)[0].mime)) await discard(id);
      }
    },id).catch(error => { app.log.error({ err: error, uploadId: id }, 'Upload cleanup failed'); });
    jobs.set(id, job);
    job.finally(() => jobs.delete(id));
    return job;
  }
  async function sweep() {
    if(context.maintenance.locked||sweeping)return;
    sweeping=true;
    try{
    for (const row of db.prepare("SELECT id,state,files_json FROM upload_sessions WHERE expires_at<=? AND state != 'processing'").all(Date.now())) {
      if(row.state==='failed'&&isTimedMime(JSON.parse(row.files_json)[0].mime))continue;
      if (jobs.has(row.id) || locked.has(row.id)||hasParts(row.id)) continue;
      await exclusive(row.id, async () => {
        await discard(row.id);
        db.prepare('DELETE FROM upload_sessions WHERE id=?').run(row.id);
      });
    }
    }finally{sweeping=false;}
  }
  await sweep();
  for (const row of db.prepare("SELECT id FROM upload_sessions WHERE state IN ('complete','cancelled')").all()) await discard(row.id);
  // A single container owns the SQLite volume and queue. Durable processing jobs
  // are reassembled and retried after restart; no browser connection is required.
  for (const row of db.prepare("SELECT id FROM upload_sessions WHERE state='processing'").all()) schedule(row.id);
  let cleanup = Promise.resolve();
  const timer = setInterval(() => { cleanup = sweep().catch(error => app.log.error(error)); }, 30 * 60 * 1000);
  timer.unref();
  app.addHook('onClose', async () => { closing = true; clearInterval(timer); await Promise.allSettled([...jobs.values()]); await cleanup; });

  app.post('/api/v1/shelves/:id/uploads', {
    ...auth, bodyLimit: 2 * 1024 * 1024,
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['title', 'files'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        retainOriginal: { type: 'boolean', default: true },
        resume:{type:'boolean',default:false},
        seriesId:{anyOf:[{type:'string',format:'uuid'},{type:'null'}]},
        clientTransferId:{type:'string',format:'uuid'},
        files: { type: 'array', minItems: 1, maxItems: MAX_BOOK_PAGES, items: {
          type: 'object', additionalProperties: false, required: ['filename', 'mime', 'size'],
          properties: { filename: { type: 'string', minLength: 1, maxLength: 255 }, mime: { enum: MIME_TYPES }, size: { type: 'integer', minimum: 1, maximum: maxUploadBytes } }
        } }
      }
    } }
  }, async (req, reply) => {
    membership(req.params.id, req.user.id, ['owner', 'editor']);
    const title = req.body.title.trim().normalize('NFC'), files = req.body.files;
    if (files.some(file=>file.mime===EPUB_MIME && file.size>MAX_EPUB_BYTES)) throw httpError(413,'EPUBは64 MiB以下にしてください。');
    if (!title) throw httpError(400, 'タイトルを入力してください。');
    if (files.length > 1 && !files.every(file => IMAGE_TYPES.includes(file.mime))) throw httpError(400, '画像の本は画像だけを選択してください。PDF・EPUB・動画・音声は1ファイルずつ登録します。');
    if (files.some(file => IMAGE_TYPES.includes(file.mime) && file.size > MAX_IMAGE_BYTES) || files.reduce((sum, file) => sum + file.size, 0) > maxUploadBytes) {
      throw httpError(413, 'アップロードの合計、または画像1枚のサイズ上限を超えています。');
    }
    if(req.body.seriesId&&!db.prepare('SELECT 1 FROM series WHERE id=? AND shelf_id=?').get(req.body.seriesId,req.params.id))throw httpError(422,'この本棚のシリーズを選んでください。');
    if(req.body.resume){
      const canonicalFiles=files.map(file=>({...file,filename:file.filename.replaceAll('\\','/').split('/').pop()||'file'}));
      const candidates=db.prepare("SELECT * FROM upload_sessions WHERE shelf_id=? AND user_id=? AND title=? AND COALESCE(target_series_id,'')=? AND (state='processing' OR state='uploading' AND expires_at>?)").all(req.params.id,req.user.id,title,req.body.seriesId??'',Date.now()).filter(row=>JSON.stringify(JSON.parse(row.files_json).map(({filename,mime,size})=>({filename,mime,size})))===JSON.stringify(canonicalFiles.map(({filename,mime,size})=>({filename,mime,size})))&&Boolean(row.retain_original)===Boolean(req.body.retainOriginal&&isTimedMime(files[0].mime)));
      if(candidates.length>1)throw httpError(409,'同じ送信候補が複数あります。転送状況で整理してから再試行してください。');
      if(candidates.length===1){transaction(db,()=>linkQueuedUpload(db,req.body.clientTransferId,candidates[0]));return reply.code(200).send(status(candidates[0]));}
    }
    context.jobPool.prioritizeTransfers?.();
    const id = randomUUID(), now = Date.now();
    try {
      // Count and reserve synchronously before filesystem I/O: concurrent
      // requests cannot all pass the per-user active-upload limit.
      transaction(db,()=>{requireSlot(req.user.id,req.body.clientTransferId);assertUploadName(db,{id,shelf_id:req.params.id,title,target_series_id:req.body.seriesId??null,series_requested:Boolean(req.body.seriesId)});
      db.prepare(`INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at,retain_original)
        VALUES(?,?,?,?,?,?,?,'uploading',?,?,?)`).run(id, req.params.id, req.user.id, req.session.id, title,
        JSON.stringify(files.map(file => ({ ...file, filename: file.filename.replaceAll('\\', '/').split('/').pop() || 'file' }))), chunkSize, now, now + UPLOAD_TTL_MS, req.body.retainOriginal && isTimedMime(files[0].mime)?1:0);
      db.prepare('UPDATE upload_sessions SET target_series_id=?,series_requested=? WHERE id=?').run(req.body.seriesId??null,req.body.seriesId?1:0,id);linkQueuedUpload(db,req.body.clientTransferId,get(id));});
      await mkdir(join(transferDir, id), { mode: 0o700 });
      authenticate(req);
      membership(req.params.id, req.user.id, ['owner', 'editor']);
    } catch (error) { db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id); await discard(id); throw error; }
    return reply.code(201).send(status(get(id)));
  });
  app.get('/api/v1/uploads/:id', auth, async req => status(owned(req)));
  app.get('/api/v1/uploads/:id/status',auth,async req=>status(owned(req),false));
  app.get('/api/v1/transfers/uploads',{...auth,schema:{querystring:{type:'object',additionalProperties:false,properties:{cursor:{type:'string',pattern:'^[01]:[0-9]{1,16}:[0-9a-f-]{36}$',maxLength:56}}}}},async req=>{
    const cursor=req.query.cursor?.split(':'),rank=cursor?Number(cursor[0]):-1,before=cursor?Number(cursor[1]):0,after=cursor?.[2]??'';
    if(!Number.isSafeInteger(before))throw httpError(400,'転送一覧の続き位置が不正です。');
    const rows=db.prepare(`SELECT u.*,q.id AS client_transfer_id,CASE WHEN u.state IN ('uploading','processing') THEN 0 ELSE 1 END AS queue_rank FROM upload_sessions u LEFT JOIN upload_queue q ON q.upload_id=u.id JOIN memberships m ON m.shelf_id=u.shelf_id AND m.user_id=u.user_id
      WHERE u.user_id=? AND m.role IN ('owner','editor') AND u.state IN ('complete','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM transfer_hidden h WHERE h.upload_id=u.id AND h.user_id=u.user_id) AND (u.state!='uploading' OR u.expires_at>?)
      AND (?<0 OR (CASE WHEN u.state IN ('uploading','processing') THEN 0 ELSE 1 END)>? OR (CASE WHEN u.state IN ('uploading','processing') THEN 0 ELSE 1 END)=? AND (u.created_at<? OR u.created_at=? AND u.id<?))
      ORDER BY queue_rank,u.created_at DESC,u.id DESC LIMIT 101`).all(req.user.id,Date.now(),rank,rank,rank,before,before,after);
    const queue=cursor?[]:db.prepare(`SELECT q.*,u.state,u.processing_json,u.error,(SELECT COALESCE(SUM(size),0) FROM upload_parts p WHERE p.upload_id=q.upload_id) AS received_bytes FROM upload_queue q JOIN memberships m ON m.shelf_id=q.shelf_id AND m.user_id=q.user_id LEFT JOIN upload_sessions u ON u.id=q.upload_id WHERE q.user_id=? AND m.role IN ('owner','editor') AND (q.upload_id IS NULL AND q.expires_at>? OR u.state IN ('uploading','processing') AND (u.state!='uploading' OR u.expires_at>?)) ORDER BY q.created_at,q.id`).all(req.user.id,Date.now(),Date.now()).map(row=>({id:row.upload_id,...(row.upload_id?jobTiming(db,row.upload_id,'upload'):{}),clientTransferId:row.id,title:row.title,shelfId:row.shelf_id,seriesId:row.series_id,state:row.state??'queued',createdAt:row.created_at,totalBytes:row.total_bytes,receivedBytes:row.state==='processing'?row.total_bytes:row.received_bytes,processing:JSON.parse(row.processing_json??'{}'),...(row.error?{error:row.error}:{})}));
    if(!cursor)for(const row of db.prepare("SELECT u.* FROM upload_sessions u JOIN memberships m ON m.shelf_id=u.shelf_id AND m.user_id=u.user_id WHERE u.user_id=? AND m.role IN ('owner','editor') AND (u.state='processing' OR u.state='uploading' AND u.expires_at>?) AND NOT EXISTS(SELECT 1 FROM upload_queue q WHERE q.upload_id=u.id)").all(req.user.id,Date.now())){const value=status(row,false),totalBytes=JSON.parse(row.files_json).reduce((n,f)=>n+f.size,0);queue.push({...value,createdAt:row.created_at,totalBytes,receivedBytes:row.state==='processing'?totalBytes:value.receivedBytes});}
    return {manualStartSupported:true,manualSlot:manualUploadSlot(db,req.user.id),queue:queue.map(row=>({...row,destination:transferDestination(db,row.shelfId,row.seriesId)})),uploads:rows.slice(0,100).map(row=>{
      const totalBytes=JSON.parse(row.files_json).reduce((n,f)=>n+f.size,0),value=status(row,false);
      return {...value,destination:transferDestination(db,row.shelf_id,row.target_series_id),clientTransferId:row.client_transfer_id,createdAt:row.created_at,totalBytes,receivedBytes:row.state==='uploading'||row.state==='cancelled'?value.receivedBytes:totalBytes};
    }),nextCursor:rows.length>100?`${rows[99].queue_rank}:${rows[99].created_at}:${rows[99].id}`:null};
  });
  app.post('/api/v1/transfers/uploads/clear-attention',auth,async req=>{
    const result=db.prepare("INSERT OR IGNORE INTO transfer_hidden(user_id,upload_id,hidden_at) SELECT user_id,id,? FROM upload_sessions WHERE user_id=? AND state IN ('failed','cancelled')").run(Date.now(),req.user.id);
    return {hidden:Number(result.changes)};
  });
  app.get('/api/v1/uploads', auth, async req => ({uploads:db.prepare("SELECT u.* FROM upload_sessions u JOIN memberships m ON m.shelf_id=u.shelf_id AND m.user_id=u.user_id WHERE u.user_id=? AND m.role IN ('owner','editor') AND (u.state IN ('processing','failed') OR u.state='uploading' AND u.expires_at>?) ORDER BY u.created_at DESC LIMIT 100").all(req.user.id,Date.now()).map(row=>status(row,false)),activeCount:activeCount(req.user.id)}));

  app.post('/api/v1/uploads/status',{...auth,bodyLimit:64*1024,schema:{body:{type:'object',additionalProperties:false,required:['ids'],properties:{ids:{type:'array',minItems:1,maxItems:1000,uniqueItems:true,items:{type:'string',format:'uuid'}}}}}},async req=>{
    const rows=db.prepare("SELECT u.* FROM upload_sessions u JOIN memberships m ON m.shelf_id=u.shelf_id AND m.user_id=u.user_id WHERE u.user_id=? AND m.role IN ('owner','editor') AND u.id IN (SELECT value FROM json_each(?))").all(req.user.id,JSON.stringify(req.body.ids));
    return {uploads:rows.map(row=>status(row,false))};
  });
  app.post('/api/v1/uploads/:id/retry', auth, async(req,reply)=>{
    await exclusive(req.params.id,async()=>{
      const upload=owned(req);
      if(upload.state!=='failed'||!isTimedMime(JSON.parse(upload.files_json)[0].mime))throw httpError(409,'再試行できる動画・音声ではありません。');
      if(jobs.has(upload.id))throw httpError(409,'直前の処理を終了しています。少し待って再試行してください。');
      requireSlot(upload.user_id);
      db.prepare('DELETE FROM admin_upload_retries WHERE upload_id=?').run(upload.id);
      db.prepare("UPDATE upload_sessions SET state='processing',error=NULL,session_id=?,processing_json='{}' WHERE id=?").run(req.session.id,upload.id);
      if(!context.mediaPipeline?.retry(upload.id))schedule(upload.id);
    });
    return reply.code(202).send(status(get(req.params.id)));
  });

  await app.register(async routes => {
    routes.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    routes.put('/api/v1/uploads/:id/files/:fileIndex/parts/:partIndex', {
      ...auth, bodyLimit: chunkSize,
      schema: { params: { type: 'object', required: ['id','fileIndex','partIndex'], properties: { id: { type: 'string' }, fileIndex: integer, partIndex: integer } } }
    }, async (req, reply) => {
      await transferPart(req.params.id,req.params.fileIndex+':'+req.params.partIndex, async signal => {
        context.jobPool.prioritizeTransfers?.();
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
        const destination = join(transferDir, upload.id, `${fileIndex}-${partIndex}`);
        const previous = db.prepare('SELECT size,sha256 FROM upload_parts WHERE upload_id=? AND file_index=? AND part_index=?').get(upload.id,fileIndex,partIndex);
        const reusable=previous?.size===expectedSize&&previous.sha256===expectedHash&&(await stat(destination).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))?.size===expectedSize;
        const hash = createHash('sha256');
        let size = 0;
        try {
          const inspect = new Transform({ transform(bytes, _encoding, done) {
            size += bytes.length;
            if (size > expectedSize) return done(httpError(413, '分割データのサイズ上限を超えています。'));
            hash.update(bytes);context.jobPool.prioritizeTransfers?.();
            done(null, bytes);
          } });
          // A lost acknowledgement may resend an already durable part. Verify
          // every incoming byte, but avoid rewriting the same file to disk.
          await pipeline(req.body, inspect,reusable?new Writable({write(_bytes,_encoding,done){done();}}):createWriteStream(temporary, { flags: 'wx', mode: 0o600,highWaterMark:1024*1024 }),{signal});
          if (size !== expectedSize || hash.digest('hex') !== expectedHash) throw httpError(422, '分割データの長さ、またはSHA-256が一致しません。');
          authenticate(req);
          if(owned(req).state!=='uploading')throw httpError(409,'アップロードをキャンセルしました。');
          if(previous&&(previous.size!==size||previous.sha256!==expectedHash))throw httpError(409,'受信済みの分割データと一致しません。');
          if(!reusable){
            const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}
            // A crash between rename and INSERT can leave an uncommitted part.
            await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
            await rename(temporary, destination);
            if(process.platform!=='win32'){const directory=await open(join(transferDir,upload.id),'r');try{await directory.sync();}finally{await directory.close();}}
            authenticate(req);
            if(owned(req).state!=='uploading')throw httpError(409,'アップロードをキャンセルしました。');
            db.prepare('INSERT OR REPLACE INTO upload_parts VALUES(?,?,?,?,?)').run(upload.id, fileIndex, partIndex, size, expectedHash);
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
      return status(current,false);
    });
    return reply.code(result.state === 'complete' ? 200 : 202).send(result);
  });
  app.delete('/api/v1/uploads/:id', auth, async (req, reply) => {
    await exclusive(req.params.id, async () => {
      const upload = owned(req);
      if (upload.state === 'complete'||context.mediaPipeline?.has(upload.id)) throw httpError(409, '原本を保存済みです。削除を確認してコンテンツ一覧から削除してください。');
      db.prepare("UPDATE upload_sessions SET state='cancelled' WHERE id=?").run(upload.id);
      context.jobPool.cancel(upload.id);await stopParts(upload.id);
      if(!jobs.has(upload.id))await discard(upload.id);
    },{allowParts:true});
    return reply.code(204).send();
  });
  return {
    async cancelForDeletion(ids){
      for(const id of ids){db.prepare("UPDATE upload_sessions SET state='cancelled' WHERE id=? AND state!='complete'").run(id);context.jobPool.cancel(id);await stopParts(id);await context.mediaPipeline?.cancel(id);}
      await Promise.allSettled(ids.map(id=>jobs.get(id)).filter(Boolean));
      for(const id of ids){await discard(id);db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id);}
    },
    async adminRetry(id,adminId,sessionId){
      await exclusive(id,async()=>{
        const upload=get(id);
        if(!upload||upload.state!=='failed'||!isTimedMime(JSON.parse(upload.files_json)[0]?.mime))throw httpError(409,'再試行できる失敗した動画・音声ジョブではありません。');
        if(jobs.has(id))throw httpError(409,'処理の終了を待ってください。');
        if(!context.adminAccess.isAdmin(adminId)||!context.adminAccess.enabled(upload.user_id))throw httpError(403,'アカウントの権限を確認してください。');
        membership(upload.shelf_id,upload.user_id,['owner','editor']);
        requireSlot(upload.user_id);
        db.prepare('INSERT INTO admin_upload_retries VALUES(?,?,?) ON CONFLICT(upload_id) DO UPDATE SET admin_id=excluded.admin_id,session_id=excluded.session_id').run(id,adminId,sessionId);
        db.prepare("UPDATE upload_sessions SET state='processing',error=NULL,processing_json='{}' WHERE id=?").run(id);if(!context.mediaPipeline?.retry(id))schedule(id);
      });
    },
    forceStart(id,userId){const row=get(id);if(row?.state!=='processing'||context.mediaPipeline?.has(id))throw httpError(409,'送信後の処理待ちを選んでください。');schedule(id);return context.jobPool.forceStart(id,userId);},
    get busy(){return jobs.size>0||locked.size>0||partTransfers.size>0||sweeping;},
    // Compatibility API: multipart clients enter the same durable, serialized
    // processing path as resumable uploads; they cannot bypass normalization.
    async publishMultipartMedia({id,shelfId,userId,sessionId,title,file,retainOriginal=true}) {
      requireSlot(userId);
      const now=Date.now();
      assertUploadName(db,{id,shelf_id:shelfId,title});
      db.prepare(`INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at,retain_original)
        VALUES(?,?,?,?,?,?,?,'uploading',?,?,?)`).run(id,shelfId,userId,sessionId,title,JSON.stringify([file]),chunkSize,now,now+UPLOAD_TTL_MS,retainOriginal?1:0);
      try {
        await mkdir(join(transferDir,id),{mode:0o700});
        const handle=await open(join(stagingDir,id,'raw-1'),'r');
        try {
          for(let part=0;part<Math.ceil(file.size/chunkSize);part++){
            const bytes=Buffer.alloc(Math.min(chunkSize,file.size-part*chunkSize));let n=0;
            while(n<bytes.length){const result=await handle.read(bytes,n,bytes.length-n,part*chunkSize+n);if(!result.bytesRead)throw new Error('Incomplete multipart source');n+=result.bytesRead;}
            await writeFile(join(transferDir,id,`0-${part}`),bytes,{flag:'wx',mode:0o600});
            db.prepare('INSERT INTO upload_parts VALUES(?,?,?,?,?)').run(id,0,part,bytes.length,createHash('sha256').update(bytes).digest('hex'));
          }
        }finally{await handle.close();}
        db.prepare("UPDATE upload_sessions SET state='processing' WHERE id=?").run(id);
        await schedule(id);
        const state=get(id);
        if(state.state!=='complete'&&!context.mediaPipeline?.has(id))throw httpError(422,`${state.error||'メディアを変換できませんでした。'} 処理状況から再試行できます。`);
        return publicItem(db.prepare('SELECT * FROM items WHERE id=?').get(id));
      }catch(error){if(get(id)?.state==='uploading'){await discard(id);db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id);}throw error;}
    },
    async cleanupUploads(ids) {
    for (const id of ids) {
      try { await discard(id); }
      catch (error) { app.log.error({ err: error, uploadId: id }, 'Deleted account upload cleanup requires attention'); }
    }
  } };
}
