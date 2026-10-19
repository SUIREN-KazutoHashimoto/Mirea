import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, rename, rm, stat, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import bundledFfmpeg from 'ffmpeg-static';
import { httpError } from './security.js';

export const IMAGE_BOOK_MIME = 'application/vnd.mirea.image-book';
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const imageExtension = mime => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[mime];
export const MAX_BOOK_PAGES = 500;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const PREVIEW_SECONDS = 6;
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const runFile = promisify(execFile);
export const ffmpegPath = () => process.env.FFMPEG_PATH || bundledFfmpeg;

function workerOperation(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./media-worker.js', import.meta.url), {
      workerData: data, resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    let receivedResult = false;
    const timer = setTimeout(() => { worker.terminate(); reject(httpError(422, '画像・PDFの処理が時間内に完了しませんでした。')); }, 30_000);
    worker.once('message', async result => {
      receivedResult = true;
      clearTimeout(timer);
      // Native decoders may hold source files open until the worker exits on Windows.
      await worker.terminate();
      if (result.error && process.env.TEST_LOG === '1') console.error('Media worker:', result.error);
      if (result.error) reject(httpError(422, '画像またはPDFを読み込めません。破損・暗号化・対応形式を確認してください。'));
      else resolve(result);
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', () => { clearTimeout(timer); if (!receivedResult) reject(httpError(422, 'メディアの処理に失敗しました。')); });
  });
}

// Serialize decoding to avoid allocating one large canvas per concurrent upload.
export function createMediaProcessor() {
  let tail = Promise.resolve();
  const enqueue = job => {
    const current = tail.then(job);
    tail = current.catch(() => {});
    return current;
  };
  return {
    validateImage(source) {
      return enqueue(() => workerOperation({ source, mode: 'validate-image' }));
    },
    preview(source, destination) {
      return enqueue(async () => {
        try {
          await runFile(ffmpegPath(), [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
            '-i', source, '-t', String(PREVIEW_SECONDS), '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
            '-vf', 'fps=12,scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-maxrate', '600k', '-bufsize', '1200k',
            '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', '-f', 'mp4', destination
          ], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, killSignal: 'SIGKILL' });
          const { size } = await stat(destination);
          if (!size || size > MAX_PREVIEW_BYTES) throw new Error('Preview size out of bounds');
        } catch (error) {
          if (error.code === 'ENOENT') throw httpError(503, '動画プレビュー用のFFmpegが見つかりません。');
          throw httpError(422, '動画プレビューを生成できません。');
        }
      });
    },
    thumbnail(source, mime, destination) {
      return enqueue(async () => {
        if (mime.startsWith('video/')) {
          try {
            await runFile(ffmpegPath(), [
              '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
              '-i', source, '-map', '0:v:0', '-frames:v', '1', '-an', '-threads', '1',
              '-vf', 'thumbnail=30,scale=480:720:force_original_aspect_ratio=decrease',
              '-c:v', 'mjpeg', '-f', 'image2', destination
            ], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, killSignal: 'SIGKILL' });
            if (!(await stat(destination)).size) throw new Error('No frame');
            return { pageCount: 1 };
          } catch (error) {
            if (error.code === 'ENOENT') throw httpError(503, '動画サムネイル用のFFmpegが見つかりません。サーバー設定を確認してください。');
            throw httpError(422, '動画のサムネイルを生成できません。対応する動画形式か確認してください。');
          }
        }
        return workerOperation({ source, destination, mode: mime === 'application/pdf' ? 'pdf-thumbnail' : 'image-thumbnail' });
      });
    }
  };
}

export function createThumbnailStore(db, media, uploadDir, thumbnailDir) {
  const pending = new Map();
  return async function ensureThumbnail(item) {
    const destination = join(thumbnailDir, `${item.id}.jpg`);
    try { await access(destination); return destination; } catch { /* create missing or legacy thumbnails */ }
    if (!pending.has(item.id)) {
      const job = (async () => {
        const firstPage = item.mime_type === IMAGE_BOOK_MIME ? db.prepare('SELECT mime_type FROM image_pages WHERE item_id=? AND page_number=1').get(item.id) : null;
        const source = firstPage ? join(uploadDir, 'books', item.id, `1.${imageExtension(firstPage.mime_type)}`) : join(uploadDir, item.id);
        const temporary = join(thumbnailDir, `${item.id}.part.jpg`);
        try {
          const result = await media.thumbnail(source, item.mime_type, temporary);
          await rename(temporary, destination);
          const updated = db.prepare('UPDATE items SET thumbnail_ready=1, page_count=? WHERE id=?').run(item.mime_type === IMAGE_BOOK_MIME ? item.page_count : result.pageCount, item.id);
          if (!updated.changes) { await unlink(destination).catch(() => {}); throw httpError(404, 'コンテンツが見つかりません。'); }
          return destination;
        } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
        finally { pending.delete(item.id); }
      })();
      pending.set(item.id, job);
    }
    return pending.get(item.id);
  };
}

// Only remove a validated UUID child of a designated storage directory.
export async function removeItemDirectory(root, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid cleanup target');
  const parent = resolve(root);
  const target = resolve(parent, id);
  if (!target.startsWith(parent + sep)) throw new Error('Cleanup outside storage directory');
  await rm(target, { recursive: true, force: true });
}
