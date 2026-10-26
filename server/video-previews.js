import {videoThumbnailState,recordVideoPreview,ensureVideoThumbnailAnchor,PREVIEW_SPEC_VERSION} from './video-thumbnail.js';
import { mkdir, stat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { MAX_PREVIEW_BYTES, PREVIEW_SECONDS } from './media.js';
import { httpError, parseRange } from './security.js';

// Generated clips are an optional cache, never the source of truth. Originals
// remain untouched; a failed conversion always leaves the JPEG thumbnail usable.
export async function registerVideoPreviews(app, { db, media, dataDir, uploadDir, authenticate, findItem,jobPool }) {
  const directory = join(dataDir, 'previews');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pending = new Map(), failed = new Map();
  let closing = false;
  const pathFor = id => join(directory, `${id}.mp4`);
  const temporaryFor = id => join(directory, `${id}.part.mp4`);
  const removeFile = path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const isVideo = item => item.mime_type.startsWith('video/');
  const exists = id => Boolean(db.prepare('SELECT 1 FROM items WHERE id=?').get(id));
  function video(req) {
    const item = findItem(req.params.id, req.user.id);
    if (!isVideo(item)) throw httpError(400, '動画のプレビューではありません。');
    return item;
  }
  async function state(id) {
    try {
      const { size } = await stat(pathFor(id));
      if (size > 0 && size <= MAX_PREVIEW_BYTES && videoThumbnailState(db,id)?.preview_version===PREVIEW_SPEC_VERSION && videoThumbnailState(db,id).preview_position_seconds===videoThumbnailState(db,id).position_seconds) return { state: 'ready', url: `/api/v1/items/${id}/preview/content`, size, maxDuration: PREVIEW_SECONDS };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending.has(id)) return { state: 'processing', retryAfterMs: 1200 };
    if ((failed.get(id) ?? 0) > Date.now()) return { state: 'unavailable' };
    failed.delete(id);
    return { state: 'absent' };
  }
  function start(item) {
    const id = item.id;
    if (closing || pending.size >= 4) return { state: 'busy', retryAfterMs: 2500 };
    const work = async () => {
      try {
        if (!exists(id)) return;
        // Lazy previews obey the same global processing limit as uploads and regeneration.
        const startSeconds=await ensureVideoThumbnailAnchor({db,item,media,uploadDir,thumbnailDir:join(dataDir,'thumbnails'),authorize:()=>{if(!exists(id))throw Error('Asset deleted');}});
        await media.preview(join(uploadDir, id), temporaryFor(id), item.mime_type,{startSeconds});
        if(videoThumbnailState(db,id)?.position_seconds!==startSeconds)return;
        if (!exists(id)) return;
        await rename(temporaryFor(id), pathFor(id));recordVideoPreview(db,id,startSeconds);
        // An item can be deleted while the asynchronous rename is pending.
        if (!exists(id)) await removeFile(pathFor(id));
      } catch (error) {
        failed.set(id, Date.now() + 5 * 60 * 1000);
        if (failed.size > 256) failed.delete(failed.keys().next().value);
        app.log.warn({ err: error, itemId: id }, 'Video preview unavailable; using thumbnail');
      } finally {
        await removeFile(temporaryFor(id));
      }
    };
    const job=(jobPool?jobPool.run(work,'preview:'+id):work()).catch(error => app.log.error({ err: error }, 'Video preview cleanup failed'));
    pending.set(id, job);
    job.finally(() => pending.delete(id));
    return { state: 'processing', retryAfterMs: 1200 };
  }
  const auth = { onRequest: async req => authenticate(req) };
  app.post('/api/v1/items/:id/preview', auth, async (req, reply) => {
    const item = video(req);
    let result = await state(item.id);
    authenticate(req); video(req);
    // Recheck after stat: simultaneous requests must not schedule two encoders.
    if (result.state === 'absent') result = pending.has(item.id) ? { state: 'processing', retryAfterMs: 1200 } : start(item);
    return reply.code(['processing', 'busy'].includes(result.state) ? 202 : 200).send(result);
  });
  app.get('/api/v1/items/:id/preview', auth, async req => {
    const item = video(req);
    const result = await state(item.id);
    authenticate(req); video(req);
    return result;
  });
  app.route({ method: ['GET', 'HEAD'], url: '/api/v1/items/:id/preview/content', ...auth, handler: async (req, reply) => {
    const item = video(req);
    if((await state(item.id)).state!=='ready')throw httpError(404,'現在のサムネイルに対応するプレビューを準備しています。');
    const metadata = await stat(pathFor(item.id)).catch(error => {
      if (error.code === 'ENOENT') throw httpError(404, 'プレビューはまだ用意されていません。');
      throw error;
    });
    authenticate(req); video(req);
    if (!metadata.size || metadata.size > MAX_PREVIEW_BYTES) throw httpError(404, 'プレビューは利用できません。');
    let range;
    try { range = parseRange(req.headers.range, metadata.size); }
    catch (error) { reply.header('Content-Range', `bytes */${metadata.size}`); throw error; }
    reply.type('video/mp4').header('Accept-Ranges', 'bytes').header('Content-Length', range ? range.end - range.start + 1 : metadata.size);
    if (range) reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`);
    if (req.method === 'HEAD') return reply.send();
    return reply.send(createReadStream(pathFor(item.id), range ?? {}));
  } });
  app.addHook('onClose', async () => { closing = true; await Promise.allSettled([...pending.values()]); });
  return {
    get busy(){return pending.size>0;},
    clearFailure(id){failed.delete(id);},
    inspect(){return [...pending.keys()].map(id=>({assetId:id,state:'running',kind:'preview'})).concat([...failed.keys()].filter(id=>(failed.get(id)??0)>Date.now()).map(id=>({assetId:id,state:'failed',kind:'preview'})));},
    async remove(id) {
      failed.delete(id);jobPool?.cancel('preview:'+id);
      // In-flight conversions check item existence and clean themselves up.
      await removeFile(pathFor(id));
      if (!pending.has(id)) await removeFile(temporaryFor(id));
    }
  };
}
