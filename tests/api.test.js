import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import sharp from 'sharp';
import { makePdf, makeMp4 } from './fixtures.js';

let app, dataDir, mp4;
const password = 'correct-horse-battery-staple';
const pdf = makePdf();
const MAX_TEST_UPLOAD = 8192;
const bearer = user => ({ authorization: `Bearer ${user.token}` });
async function register(name) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { name, email: `${name}@example.com`, password } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}
async function shelfFor(owner, name = 'Library') {
  const response = await app.inject({ method: 'POST', url: '/api/v1/shelves', headers: bearer(owner), payload: { name, description: 'Shared media' } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().id;
}
async function addMember(owner, shelf, member, role = 'viewer') {
  return app.inject({ method: 'POST', url: `/api/v1/shelves/${shelf}/members`, headers: bearer(owner), payload: { email: member.user.email, role } });
}
async function uploadFile(user, shelf, buffer = pdf, mime = 'application/pdf', name = '本.pdf', title = 'Test document') {
  return uploadFiles(user, shelf, [{ buffer, mime, name }], title);
}
async function uploadFiles(user, shelf, files, title = 'Image book') {
  const boundary = 'mirea-test-boundary';
  const parts = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n`)];
  for (const file of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.buffer, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return app.inject({ method: 'POST', url: `/api/v1/shelves/${shelf}/items`, headers: { ...bearer(user), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(parts) });
}
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mirea-test-'));
  mp4 = await makeMp4(join(dataDir, 'fixture.mp4'));
  app = await createApp({ dataDir, maxUploadBytes: MAX_TEST_UPLOAD, rateLimit: false, logger: process.env.TEST_LOG === '1' });
  await app.ready();
});
after(async () => { await app?.close(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

test('registration, login, validation, normalization and revoked sessions', async () => {
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  assert.equal((await app.inject('/api/v1/shelves')).statusCode, 401);
  const user = await register('auth');
  const duplicate = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { name: 'Duplicate', email: 'AUTH@example.com', password } });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  const invalid = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { name: 'A', email: 'not-an-email', password: 'short' } });
  assert.equal(invalid.statusCode, 400);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'AUTH@EXAMPLE.COM', password } });
  assert.equal(login.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'auth@example.com', password: 'a wrong password' } })).statusCode, 401);
  const me = await app.inject({ url: '/api/v1/auth/me', headers: bearer(user) });
  assert.equal(me.json().user.email, 'auth@example.com');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: bearer(user) })).statusCode, 204);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: bearer(user) })).statusCode, 401);
});
test('many-to-many shelves, owner protection and nonmember isolation', async () => {
  const owner = await register('owner'), viewer = await register('viewer'), outsider = await register('outsider');
  const shelf = await shelfFor(owner), second = await shelfFor(viewer, 'Another library');
  assert.equal((await addMember(owner, shelf, viewer)).statusCode, 201);
  assert.equal((await addMember(owner, shelf, viewer)).statusCode, 409);
  const visible = await app.inject({ url: '/api/v1/shelves', headers: bearer(viewer) });
  assert.equal(visible.json().shelves.length, 2);
  assert.deepEqual(new Set(visible.json().shelves.map(s => s.id)), new Set([shelf, second]));
  assert.equal((await app.inject({ url: `/api/v1/shelves/${shelf}/items`, headers: bearer(outsider) })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/v1/shelves', headers: bearer(outsider) })).json().shelves.length, 0);
  assert.equal((await addMember(viewer, shelf, outsider)).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/v1/shelves/${shelf}/members`, headers: bearer(viewer) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/shelves/${shelf}/members/${owner.user.id}`, headers: bearer(owner) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/shelves/${shelf}/members/${owner.user.id}`, headers: bearer(owner), payload: { role: 'viewer' } })).statusCode, 400);
  assert.equal((await uploadFile(viewer, shelf)).statusCode, 403);
});
test('PDF upload, authorized byte serving, scoped tickets and immediate membership revocation', async () => {
  const owner = await register('streamowner'), viewer = await register('streamviewer'), outsider = await register('streamoutsider');
  const shelf = await shelfFor(owner);
  await addMember(owner, shelf, viewer);
  const uploaded = await uploadFile(owner, shelf);
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const item = uploaded.json().item;
  assert.equal(item.size, pdf.length);
  const path = `/api/v1/items/${item.id}`;
  assert.equal((await app.inject(`${path}/content`)).statusCode, 401);
  assert.equal((await app.inject({ url: `${path}/content`, headers: bearer(outsider) })).statusCode, 404);
  const content = await app.inject({ url: `${path}/content`, headers: bearer(viewer) });
  assert.equal(content.statusCode, 200, content.body);
  assert.deepEqual(content.rawPayload, pdf);
  assert.equal(content.headers['cache-control'], 'private, no-store, no-transform');
  const cover = await app.inject({ url: `${path}/thumbnail`, headers: bearer(viewer) });
  assert.equal(cover.statusCode, 200, cover.body);
  assert.equal(cover.headers['content-type'], 'image/webp');
  assert.equal((await sharp(cover.rawPayload).metadata()).format, 'jpeg');
  assert.equal((await app.inject(`${path}/thumbnail`)).statusCode, 401);
  assert.equal((await app.inject({ url: `${path}/thumbnail`, headers: bearer(outsider) })).statusCode, 404);
  assert.ok(content.headers['content-disposition'].includes('UTF-8'));
  const range = await app.inject({ url: `${path}/content`, headers: { ...bearer(viewer), range: 'bytes=5-10' } });
  assert.equal(range.statusCode, 206);
  assert.equal(range.headers['content-range'], `bytes 5-10/${pdf.length}`);
  assert.deepEqual(range.rawPayload, pdf.subarray(5, 11));
  const head = await app.inject({ method: 'HEAD', url: `${path}/content`, headers: bearer(viewer) });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), pdf.length);
  const invalidRange = await app.inject({ url: `${path}/content`, headers: { ...bearer(viewer), range: 'bytes=999-' } });
  assert.equal(invalidRange.statusCode, 416);
  assert.equal(invalidRange.headers['content-range'], `bytes */${pdf.length}`);
  const ticket = (await app.inject({ method: 'POST', url: `${path}/playback-ticket`, headers: bearer(viewer) })).json();
  assert.equal((await app.inject(ticket.url)).statusCode, 200);
  const another = (await uploadFile(owner, shelf)).json().item;
  assert.equal((await app.inject(ticket.url.replace(item.id, another.id))).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/shelves/${shelf}/members/${viewer.user.id}`, headers: bearer(owner) })).statusCode, 204);
  assert.equal((await app.inject(ticket.url)).statusCode, 404);
  assert.equal((await app.inject({ url: `${path}/content`, headers: bearer(viewer) })).statusCode, 404);
  assert.equal((await app.inject({ url: `${path}/thumbnail`, headers: bearer(viewer) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `${path}/playback-ticket`, headers: bearer(viewer) })).statusCode, 404);
});
test('editor permissions, video signatures, session-ticket revocation and file deletion', async () => {
  const owner = await register('editorowner'), editor = await register('editor');
  const shelf = await shelfFor(owner);
  await addMember(owner, shelf, editor, 'editor');
  const response = await uploadFile(editor, shelf, mp4, 'video/mp4', 'test.mp4', 'Video');
  assert.equal(response.statusCode, 201, response.body);
  const item = response.json().item;
  const cover = await app.inject({ url: `/api/v1/items/${item.id}/thumbnail`, headers: bearer(editor) });
  assert.equal(cover.statusCode, 200);
  assert.equal((await sharp(cover.rawPayload).metadata()).format, 'jpeg');
  const ticket = (await app.inject({ method: 'POST', url: `/api/v1/items/${item.id}/playback-ticket`, headers: bearer(editor) })).json();
  assert.equal((await app.inject(ticket.url)).headers['content-type'], 'video/mp4');
  await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: bearer(editor) });
  assert.equal((await app.inject(ticket.url)).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/items/${item.id}`, headers: bearer(owner) })).statusCode, 204);
  assert.equal((await app.inject({ url: `/api/v1/items/${item.id}/content`, headers: bearer(owner) })).statusCode, 404);
  assert.equal((await readdir(join(dataDir, 'uploads'))).includes(item.id), false);
  assert.equal((await readdir(join(dataDir, 'thumbnails'))).includes(`${item.id}.jpg`), false);
});
test('oversized, spoofed and empty files are rejected and temporary files are removed', async () => {
  const owner = await register('invalidowner'), shelf = await shelfFor(owner);
  assert.equal((await uploadFile(owner, shelf, Buffer.from('not a pdf'))).statusCode, 415);
  assert.equal((await uploadFile(owner, shelf, Buffer.alloc(0))).statusCode, 400);
  const huge = await uploadFile(owner, shelf, Buffer.concat([pdf, Buffer.alloc(MAX_TEST_UPLOAD)]));
  assert.equal(huge.statusCode, 413, huge.body);
  assert.equal((await readdir(join(dataDir, 'uploads', 'staging'))).length, 0);
});
test('role changes affect future uploads and deletes; owner cannot be forged', async () => {
  const owner = await register('roleowner'), member = await register('rolemember');
  const shelf = await shelfFor(owner);
  await addMember(owner, shelf, member);
  const path = `/api/v1/shelves/${shelf}/members/${member.user.id}`;
  assert.equal((await app.inject({ method: 'PATCH', url: path, headers: bearer(owner), payload: { role: 'owner' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: path, headers: bearer(owner), payload: { role: 'editor' } })).statusCode, 204);
  const item = (await uploadFile(member, shelf)).json().item;
  await app.inject({ method: 'PATCH', url: path, headers: bearer(owner), payload: { role: 'viewer' } });
  assert.equal((await uploadFile(member, shelf)).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/items/${item.id}`, headers: bearer(member) })).statusCode, 403);
});
test('multiple JPEG, PNG and WebP images form one book with ordered pages and a real cover', async () => {
  const owner = await register('imageowner'), viewer = await register('imageviewer'), outsider = await register('imageoutsider');
  const shelf = await shelfFor(owner);
  await addMember(owner, shelf, viewer);
  const redPng = await sharp({ create: { width: 120, height: 180, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const greenJpeg = await sharp({ create: { width: 100, height: 150, channels: 3, background: '#00ff00' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const blueWebp = await sharp({ create: { width: 120, height: 180, channels: 3, background: '#0000ff' } }).webp().toBuffer();
  const response = await uploadFiles(owner, shelf, [
    { buffer: redPng, mime: 'image/png', name: 'page-10.png' },
    { buffer: greenJpeg, mime: 'image/jpeg', name: 'page-2.jpg' },
    { buffer: blueWebp, mime: 'image/webp', name: 'page-1.webp' }
  ]);
  assert.equal(response.statusCode, 201, response.body);
  const item = response.json().item;
  assert.equal(item.kind, 'image-book');
  assert.equal(item.pageCount, 3);
  const path = `/api/v1/items/${item.id}`;
  const manifest = await app.inject({ url: `${path}/pages`, headers: bearer(viewer) });
  assert.deepEqual(manifest.json().pages.map(p => p.filename), ['page-10.png', 'page-2.jpg', 'page-1.webp']);
  assert.deepEqual(manifest.json().pages.map(p => p.number), [1, 2, 3]);
  assert.equal(manifest.json().pages[1].width, 150, 'EXIF orientation must be applied');
  assert.equal(manifest.json().pages[1].height, 100);
  const page = await app.inject({ url: manifest.json().pages[2].url, headers: bearer(viewer) });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['content-type'], 'image/webp');
  assert.deepEqual(page.rawPayload, blueWebp, 'page originals must retain their exact bytes');
  assert.ok((await sharp(page.rawPayload).stats()).channels[2].mean > 240);
  const cover = await app.inject({ url: item.thumbnailUrl, headers: bearer(viewer) });
  assert.equal(cover.statusCode, 200);
  assert.ok((await sharp(cover.rawPayload).stats()).channels[0].mean > 240, 'cover must come from first uploaded page');
  assert.equal((await app.inject({ url: `${path}/pages/1/content`, headers: bearer(outsider) })).statusCode, 404);
  assert.equal((await app.inject(`${path}/pages/1/content`)).statusCode, 401);
  assert.equal((await app.inject({ url: `${path}/pages/4/content`, headers: bearer(viewer) })).statusCode, 404);
  assert.ok([400, 404].includes((await app.inject({ url: `${path}/pages/../content`, headers: bearer(viewer) })).statusCode));
  assert.equal((await app.inject({ method: 'POST', url: `${path}/playback-ticket`, headers: bearer(viewer) })).statusCode, 400);
  await app.inject({ method: 'DELETE', url: `/api/v1/shelves/${shelf}/members/${viewer.user.id}`, headers: bearer(owner) });
  assert.equal((await app.inject({ url: `${path}/pages`, headers: bearer(viewer) })).statusCode, 404);
  assert.equal((await app.inject({ url: `${path}/pages/1/content`, headers: bearer(viewer) })).statusCode, 404);
  assert.equal((await app.inject({ url: item.thumbnailUrl, headers: bearer(viewer) })).statusCode, 404);
  await app.inject({ method: 'DELETE', url: path, headers: bearer(owner) });
  assert.equal((await readdir(join(dataDir, 'uploads', 'books'))).includes(item.id), false);
  assert.equal((await readdir(join(dataDir, 'thumbnails'))).includes(`${item.id}.jpg`), false);
});
test('mixed formats, corrupt later pages and unreadable PDFs do not publish partial books', async () => {
  const owner = await register('badbookowner'), shelf = await shelfFor(owner);
  const png = await sharp({ create: { width: 16, height: 20, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const mixed = await uploadFiles(owner, shelf, [{ buffer: png, mime: 'image/png', name: 'p.png' }, { buffer: pdf, mime: 'application/pdf', name: 'a.pdf' }]);
  assert.equal(mixed.statusCode, 400, mixed.body);
  const corrupt = await uploadFiles(owner, shelf, [
    { buffer: png, mime: 'image/png', name: 'first.png' },
    { buffer: png.subarray(0, 16), mime: 'image/png', name: 'broken.png' }
  ]);
  assert.equal(corrupt.statusCode, 422, corrupt.body);
  const invalidPdf = await uploadFile(owner, shelf, Buffer.from('%PDF-1.7\nnot a real document'));
  assert.equal(invalidPdf.statusCode, 422, invalidPdf.body);
  assert.equal((await app.inject({ url: `/api/v1/shelves/${shelf}/items`, headers: bearer(owner) })).json().items.length, 0);
  assert.deepEqual(await readdir(join(dataDir, 'uploads', 'staging')), []);
});
test('Android origin is allowed; unrelated browser origins receive no CORS permission', async () => {
  const allowed = await app.inject({ method: 'OPTIONS', url: '/api/v1/shelves', headers: { origin: 'https://localhost', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://localhost');
  const rejected = await app.inject({ url: '/api/v1/config', headers: { origin: 'https://untrusted.example' } });
  assert.equal(rejected.headers['access-control-allow-origin'], undefined);
});
test('stored accounts, memberships and files survive a server restart', async () => {
  const owner = await register('persistowner'), shelf = await shelfFor(owner);
  const item = (await uploadFile(owner, shelf)).json().item;
  await app.close();
  app = await createApp({ dataDir, maxUploadBytes: MAX_TEST_UPLOAD, rateLimit: false });
  await app.ready();
  const response = await app.inject({ url: `/api/v1/shelves/${shelf}/items`, headers: bearer(owner) });
  assert.equal(response.statusCode, 200);
  assert.ok(response.json().items.some(i => i.id === item.id));
  assert.deepEqual((await app.inject({ url: `/api/v1/items/${item.id}/content`, headers: bearer(owner) })).rawPayload, pdf);
});
