import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { transaction } from './database.js';
import { httpError, matchesFileType } from './security.js';
import { IMAGE_TYPES, IMAGE_BOOK_MIME, imageExtension, removeItemDirectory } from './media.js';

// Only fully verified media is published. An upload ID also becomes its item ID,
// allowing a persisted job to recognize publication after an interrupted restart.
export async function publishStagedUpload({ db, media, uploadDir, stagingDir, booksDir, thumbnailDir, publicItem }, upload, authorize) {
  const { id, shelf_id: shelfId, user_id: userId, title } = upload;
  const files = JSON.parse(upload.files_json);
  const stage = join(stagingDir, id);
  const finalPath = join(uploadDir, id);
  const finalThumbnail = join(thumbnailDir, `${id}.jpg`);
  const existing = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  if (existing) return publicItem(existing);
  const isBook = IMAGE_TYPES.includes(files[0].mime);
  const pages = [];
  try {
    // Recover uncommitted filesystem moves from a process crash. Chunk sources
    // live in another directory and remain available until publication commits.
    await removeItemDirectory(booksDir, id);
    await Promise.all([finalPath, finalThumbnail].map(path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; })));
    authorize();
    for (const [index, file] of files.entries()) {
      const source = join(stage, `raw-${index + 1}`);
      const handle = await open(source, 'r');
      let head;
      try {
        head = Buffer.alloc(16);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        head = head.subarray(0, bytesRead);
      } finally { await handle.close(); }
      if (!matchesFileType(file.mime, head)) throw httpError(415, 'ファイルの内容と形式が一致しません。');
      if (isBook) {
        const metadata = await media.validateImage(source);
        await rename(source, join(stage, `${index + 1}.${imageExtension(file.mime)}`));
        pages.push({ ...metadata, ...file, number: index + 1 });
      }
      authorize();
    }
    const first = files[0];
    const thumbnail = await media.thumbnail(join(stage, isBook ? `1.${imageExtension(first.mime)}` : 'raw-1'), first.mime, join(stage, 'thumbnail.jpg'));
    authorize();
    await rename(join(stage, 'thumbnail.jpg'), finalThumbnail);
    if (isBook) await rename(stage, join(booksDir, id));
    else {
      await rename(join(stage, 'raw-1'), finalPath);
      await removeItemDirectory(stagingDir, id);
    }
    authorize();
    transaction(db, () => {
      db.prepare(`INSERT INTO items (id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count,thumbnail_ready)
        VALUES(?,?,?,?,?,?,?,?,?,1)`).run(id, shelfId, title, first.filename, isBook ? IMAGE_BOOK_MIME : first.mime,
        files.reduce((sum, file) => sum + file.size, 0), userId, Date.now(), isBook ? pages.length : thumbnail.pageCount);
      const insert = db.prepare('INSERT INTO image_pages VALUES(?,?,?,?,?,?,?)');
      for (const page of pages) insert.run(id, page.number, page.filename, page.size, page.width, page.height, page.mime);
      db.prepare("UPDATE upload_sessions SET state='complete', error=NULL WHERE id=?").run(id);
    });
    return publicItem(db.prepare('SELECT * FROM items WHERE id=?').get(id));
  } catch (error) {
    await Promise.allSettled([removeItemDirectory(stagingDir, id), removeItemDirectory(booksDir, id), unlink(finalPath), unlink(finalThumbnail)]);
    throw error;
  }
}
