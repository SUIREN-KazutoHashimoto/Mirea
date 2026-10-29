import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { createMediaProcessor } from '../server/media.js';
import { makePdf, makeMp4, withOutOfRangeEditList } from './fixtures.js';
import {uploadErrorMessage} from '../server/upload-errors.js';

const pdf = makePdf();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('image uploads advertise 100 MiB, accept its exact boundary, reject larger pages and preserve a real image over the old 25 MiB limit',async t=>{
 const limit=100*1024*1024,ctx=await setup(t,{maxUploadBytes:256*1024*1024,chunkSize:1024*1024});
 const config=(await ctx.request('GET','/config')).json();assert.equal(config.maxImageBytes,limit);
 for(const size of [25*1024*1024+1,limit]){const upload=await ctx.start([{filename:'boundary.png',mime:'image/png',size}]);assert.equal((await ctx.request('DELETE','/uploads/'+upload.id,ctx.owner)).statusCode,204);}
 const rejected=await ctx.request('POST','/shelves/'+ctx.shelfId+'/uploads',ctx.owner,{title:'Too large',files:[{filename:'too-large.png',mime:'image/png',size:limit+1}]});assert.equal(rejected.statusCode,413,rejected.body);
 const {validateUploadPlan}=await import('../web/src/upload-batch.js'),job=size=>[{key:'page',title:'Boundary',imageBook:true,files:[{name:'page.png',type:'image/png',size}]}];assert.equal(validateUploadPlan(job(limit),config),'');assert.match(validateUploadPlan(job(limit+1),config),/画像1枚/);
 const image=await sharp({create:{width:4096,height:3000,channels:3,background:'#506fa0'}}).png({compressionLevel:0}).toBuffer();assert(image.length>25*1024*1024&&image.length<=limit);
 const upload=await ctx.start([{filename:'large-page.png',mime:'image/png',size:image.length}]);await ctx.send(upload,[image]);assert.equal((await ctx.request('POST','/uploads/'+upload.id+'/complete',ctx.owner)).statusCode,202);const complete=await ctx.wait(upload.id);assert.equal(complete.item.kind,'image-book');assert.equal(complete.item.pageCount,1);assert.deepEqual(await readFile(join(ctx.dataDir,'uploads','books',upload.id,'1.png')),image);
});

async function setup(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mirea-chunks-'));
  const options = { dataDir, maxUploadBytes: 8192, chunkSize: 256, rateLimit: false, ...overrides };
  const ctx = { dataDir, options, app: await createApp(options) };
  t.after(async () => { await ctx.app.close(); await rm(dataDir, { recursive: true, force: true }); });
  ctx.request = (method, url, user, payload, headers = {}) => ctx.app.inject({ method, url: `/api/v1${url}`, headers: { ...(user ? { authorization: `Bearer ${user.token}` } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
  ctx.register = async name => {
    const response = await ctx.request('POST', '/auth/register', null, { name, email: `${name}@example.test`, password: 'chunk-test-password-1234' });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  ctx.owner = await ctx.register('owner');
  const shelf = await ctx.request('POST', '/shelves', ctx.owner, { name: 'Chunks' });
  ctx.shelfId = shelf.json().id;
  let uploadSequence = 0;
  ctx.start = async (files = [{ filename: 'book.pdf', mime: 'application/pdf', size: pdf.length }], user = ctx.owner) => {
    const response = await ctx.request('POST', `/shelves/${ctx.shelfId}/uploads`, user, { title: 'Chunked media '+(++uploadSequence), files });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  ctx.part = (upload, file, index, bytes, user = ctx.owner, hash = sha256(bytes)) => ctx.request('PUT', `/uploads/${upload.id}/files/${file}/parts/${index}`, user, bytes, { 'content-type': 'application/octet-stream', 'x-chunk-sha256': hash });
  ctx.send = async (upload, buffers = [pdf]) => {
    for (const [file, bytes] of buffers.entries()) {
      for (let index = 0; index < Math.ceil(bytes.length / upload.chunkSize); index++) {
        const response = await ctx.part(upload, file, index, bytes.subarray(index * upload.chunkSize, (index + 1) * upload.chunkSize));
        assert.equal(response.statusCode, 204, response.body);
      }
    }
  };
  ctx.wait = async (id, expected = 'complete') => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const response = await ctx.request('GET', `/uploads/${id}`, ctx.owner);
      assert.equal(response.statusCode, 200, response.body);
      const status = response.json();
      if (status.state !== 'processing') {
        assert.equal(status.state, expected, JSON.stringify(status));
        // Terminal publication is committed before best-effort disk cleanup.
        while (Date.now() < deadline && (await readdir(join(dataDir, 'uploads', 'staging'))).includes(id)) await delay(10);
        while (Date.now() < deadline && (await readdir(join(dataDir, 'uploads', 'transfers'))).includes(id)) await delay(10);
        return status;
      }
      await delay(15);
    }
    assert.fail('Upload job did not finish');
  };
  return ctx;
}

test('chunk upload validates size/hash/index, retries idempotently and publishes PDF asynchronously', async t => {
  const ctx = await setup(t), upload = await ctx.start();
  assert.equal((await ctx.request('GET', '/config')).json().uploadChunkBytes, 256);
  const chunk = pdf.subarray(0, 256);
  assert.equal((await ctx.part(upload, 0, 0, chunk, ctx.owner, '0'.repeat(64))).statusCode, 422);
  assert.equal((await ctx.part(upload, 0, 0, chunk.subarray(1))).statusCode, 400);
  assert.equal((await ctx.part(upload, 0, 999, chunk)).statusCode, 400);
  assert.equal((await ctx.part(upload, 1, 0, chunk)).statusCode, 400);
  assert.equal((await ctx.request('POST', `/uploads/${upload.id}/complete`, ctx.owner)).statusCode, 409);
  assert.equal((await ctx.part(upload, 0, 0, chunk)).statusCode, 204);
  assert.equal((await ctx.part(upload, 0, 0, chunk)).statusCode, 204);
  const other = Buffer.from(chunk); other[10] ^= 1;
  assert.equal((await ctx.part(upload, 0, 0, other)).statusCode, 409);
  const status = (await ctx.request('GET', `/uploads/${upload.id}`, ctx.owner)).json();
  assert.equal(status.receivedBytes, chunk.length);
  assert.deepEqual(status.files[0].receivedParts, [0]);
  assert.equal(status.files[0].receivedHashes[0], sha256(chunk));
  await ctx.send(upload);
  const complete = await ctx.request('POST', `/uploads/${upload.id}/complete`, ctx.owner);
  assert.equal(complete.statusCode, 202, complete.body);
  const result = await ctx.wait(upload.id);
  assert.equal(result.item.kind, 'pdf');
  assert.equal(result.item.pageCount, 1);
  assert.equal((await ctx.request('POST', `/uploads/${upload.id}/complete`, ctx.owner)).statusCode, 200);
  const range = await ctx.request('GET', `/items/${result.item.id}/content`, ctx.owner, undefined, { range: 'bytes=16-47' });
  assert.equal(range.statusCode, 206);
  assert.equal(range.headers['content-range'], `bytes 16-47/${pdf.length}`);
  assert.equal(range.headers['accept-ranges'], 'bytes');
  assert.equal(range.headers['cache-control'], 'private, no-store, no-transform');
  assert.deepEqual(range.rawPayload, pdf.subarray(16, 48));
  assert.equal((await readdir(join(ctx.dataDir, 'uploads', 'transfers'))).length, 0);
});

test('part state survives restart and persisted processing jobs recover without an open request', async t => {
  const ctx = await setup(t), upload = await ctx.start();
  await ctx.part(upload, 0, 0, pdf.subarray(0, 256));
  await ctx.app.close();
  ctx.app = await createApp(ctx.options);
  const status = (await ctx.request('GET', `/uploads/${upload.id}`, ctx.owner)).json();
  assert.deepEqual(status.files[0].receivedParts, [0]);
  await ctx.send(upload);
  await ctx.app.close();
  const db = new DatabaseSync(join(ctx.dataDir, 'mirea.sqlite'));
  db.prepare("UPDATE upload_sessions SET state='processing' WHERE id=?").run(upload.id);
  db.close();
  ctx.app = await createApp(ctx.options);
  assert.equal((await ctx.wait(upload.id)).item.size, pdf.length);
});

test('upload ownership, role/session revocation, cancellation, expiration and active limits', async t => {
  const ctx = await setup(t), editor = await ctx.register('editor'), viewer = await ctx.register('viewer');
  for (const [member, role] of [[editor, 'editor'], [viewer, 'viewer']]) {
    await ctx.request('POST', `/shelves/${ctx.shelfId}/members`, ctx.owner, { email: member.user.email, role });
  }
  const upload = await ctx.start();
  assert.equal((await ctx.request('GET', `/uploads/${upload.id}`)).statusCode, 401);
  assert.equal((await ctx.request('GET', `/uploads/${upload.id}`, editor)).statusCode, 404);
  assert.equal((await ctx.request('POST', `/shelves/${ctx.shelfId}/uploads`, viewer, { title: 'Denied', files: upload.files })).statusCode, 403);
  const editorUpload = await ctx.start(undefined, editor);
  await ctx.request('DELETE', `/shelves/${ctx.shelfId}/members/${editor.user.id}`, ctx.owner);
  assert.equal((await ctx.part(editorUpload, 0, 0, pdf.subarray(0, 256), editor)).statusCode, 404);
  assert.equal((await ctx.request('POST', `/uploads/${editorUpload.id}/complete`, editor)).statusCode, 404);
  assert.equal((await ctx.request('DELETE', `/uploads/${upload.id}`, ctx.owner)).statusCode, 204);
  assert.equal((await ctx.part(upload, 0, 0, pdf.subarray(0, 256))).statusCode, 409);
  const active = [await ctx.start(), await ctx.start(), await ctx.start()];
  const limited = await ctx.request('POST', `/shelves/${ctx.shelfId}/uploads`, ctx.owner, { title: 'Fourth', files: [{ filename: 'a.pdf', mime: 'application/pdf', size: pdf.length }] });
  assert.equal(limited.statusCode, 429);
  await ctx.app.close();
  const db = new DatabaseSync(join(ctx.dataDir, 'mirea.sqlite'));
  db.prepare('UPDATE upload_sessions SET expires_at=1 WHERE id=?').run(active[0].id);
  db.close();
  ctx.app = await createApp(ctx.options);
  assert.equal((await ctx.request('GET', `/uploads/${active[0].id}`, ctx.owner)).statusCode, 404);
  assert.equal((await readdir(join(ctx.dataDir, 'uploads', 'transfers'))).includes(active[0].id), false);
  await ctx.request('POST', '/auth/logout', ctx.owner);
  assert.equal((await ctx.part(active[1], 0, 0, pdf.subarray(0, 256))).statusCode, 401);
});

test('retained failed sources never occupy slots; all retry entry points respect the same active limit',async t=>{
  const admins=[],ctx=await setup(t,{serverAdminUserIds:admins});admins.push(ctx.owner.user.id);
  const db=new DatabaseSync(join(ctx.dataDir,'mirea.sqlite'));
  try{
  const failed=[];for(let n=0;n<4;n++){
    const r=await ctx.request('POST',`/shelves/${ctx.shelfId}/uploads`,ctx.owner,{title:'Failed fixture '+n,files:[{filename:'fixture.mp4',mime:'video/mp4',size:16}]});assert.equal(r.statusCode,201,r.body);failed.push(r.json().id);
    db.prepare("UPDATE upload_sessions SET state='failed',expires_at=1,error='fixture' WHERE id=?").run(r.json().id);
  }
  let list=(await ctx.request('GET','/uploads',ctx.owner)).json();assert.equal(list.activeCount,0);assert.equal(list.uploads.length,4);assert(list.uploads.every(u=>u.sourceRetained));
  const active=await Promise.all([ctx.start(),ctx.start(),ctx.start()]);assert.equal((await ctx.request('GET','/uploads',ctx.owner)).json().activeCount,3);
  assert.equal((await ctx.request('POST',`/uploads/${failed[0]}/retry`,ctx.owner)).statusCode,429);
  assert.equal((await ctx.request('POST',`/admin/uploads/${failed[1]}/retry`,ctx.owner,{acknowledgeCost:true})).statusCode,429);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admin_upload_retries').get().n,0);
  assert.equal((await ctx.request('DELETE',`/uploads/${active[0].id}`,ctx.owner)).statusCode,204);
  assert.equal((await ctx.request('POST',`/uploads/${failed[0]}/retry`,ctx.owner)).statusCode,202);
  while(db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(failed[0]).state==='processing')await delay(10);
  assert.equal((await ctx.request('POST',`/admin/uploads/${failed[1]}/retry`,ctx.owner,{acknowledgeCost:true})).statusCode,202);
  while(db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(failed[1]).state==='processing')await delay(10);
  assert.equal((await ctx.request('GET','/uploads',ctx.owner)).json().activeCount,2);assert.equal(db.prepare("SELECT COUNT(*) n FROM upload_sessions WHERE state='failed'").get().n,4);
  }finally{db.close();}
});

test('filesystem failures provide actionable sanitized errors and release slots for later uploads',async t=>{
  const ctx=await setup(t,{mediaProcessor:{async close(){},async thumbnail(){throw Object.assign(Error('EACCES private host path'),{code:'EACCES'});}}});
  for(let n=0;n<4;n++){const upload=await ctx.start();await ctx.send(upload);await ctx.request('POST',`/uploads/${upload.id}/complete`,ctx.owner);const state=await ctx.wait(upload.id,'failed');assert.match(state.error,/書き込めません/);assert(!state.error.includes('private'));assert.equal((await ctx.request('GET','/uploads',ctx.owner)).json().activeCount,0);}
  assert.match(uploadErrorMessage({code:'ENOSPC'}),/空き/);assert.match(uploadErrorMessage({cause:{code:'EROFS'}}),/書き込めません/);assert.match(uploadErrorMessage({code:'ESTALE'}),/接続状態/);assert(!uploadErrorMessage(Error('private')).includes('private'));assert.equal(uploadErrorMessage({statusCode:422,message:'invalid media'}),'invalid media');
});

test('image books retain manifest order and original bytes; corrupted persisted chunks fail without publication', async t => {
  const ctx = await setup(t);
  const png = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#ac431b' } }).png().toBuffer();
  const webp = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#274a90' } }).webp().toBuffer();
  const files = [{ filename: 'page-2.webp', mime: 'image/webp', size: webp.length }, { filename: 'page-1.png', mime: 'image/png', size: png.length }];
  const upload = await ctx.start(files);
  await ctx.send(upload, [webp, png]);
  assert.equal((await ctx.request('POST', `/uploads/${upload.id}/complete`, ctx.owner)).statusCode, 202);
  const { item } = await ctx.wait(upload.id);
  assert.equal(item.kind, 'image-book');
  const manifest = (await ctx.request('GET', `/items/${item.id}/pages`, ctx.owner)).json();
  assert.deepEqual(manifest.pages.map(page => page.filename), files.map(file => file.filename));
  assert.deepEqual((await ctx.request('GET', `/items/${item.id}/pages/1/content`, ctx.owner)).rawPayload, webp);
  assert.equal((await sharp((await ctx.request('GET', `/items/${item.id}/thumbnail`, ctx.owner)).rawPayload).metadata()).format, 'webp');
  const broken = await ctx.start();
  await ctx.send(broken);
  await writeFile(join(ctx.dataDir, 'uploads', 'transfers', broken.id, '0-0'), Buffer.alloc(256));
  await ctx.request('POST', `/uploads/${broken.id}/complete`, ctx.owner);
  await ctx.wait(broken.id, 'failed');
  assert.equal((await ctx.request('GET', `/items/${broken.id}/content`, ctx.owner)).statusCode, 404);
  assert.equal((await readdir(join(ctx.dataDir, 'uploads', 'staging'))).length, 0);
});

test('chunked video has a thumbnail and supports suffix ranges and scoped-ticket seeking', async t => {
  const ctx = await setup(t);
  const video = await makeMp4(join(ctx.dataDir, 'fixture.mp4'));
  const upload = await ctx.start([{ filename: 'video.mp4', mime: 'video/mp4', size: video.length }]);
  await ctx.send(upload, [video]);
  await ctx.request('POST', `/uploads/${upload.id}/complete`, ctx.owner);
  const { item } = await ctx.wait(upload.id);
  assert.equal(item.kind, 'video');
  const ticket = (await ctx.request('POST', `/items/${item.id}/playback-ticket`, ctx.owner)).json();
  const range = await ctx.app.inject({ url: ticket.url, headers: { range: 'bytes=-32' } });
  assert.equal(range.statusCode, 206);
  const canonical=(await ctx.request('GET',`/items/${item.id}/content`,ctx.owner)).rawPayload;
  assert.deepEqual(range.rawPayload, canonical.subarray(-32));
  const head = await ctx.app.inject({ method: 'HEAD', url: ticket.url, headers: { range: 'bytes=0-31' } });
  assert.equal(head.statusCode, 206);
  assert.equal(head.headers['content-length'], '32');
  assert.equal(head.body, '');
  const preflight = await ctx.request('OPTIONS', `/uploads/${upload.id}/files/0/parts/0`, null, undefined, {
    origin: 'https://localhost', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type,x-chunk-sha256'
  });
  assert.equal(preflight.statusCode, 204);
  assert.ok(preflight.headers['access-control-allow-methods'].includes('PUT'));
  assert.ok(preflight.headers['access-control-allow-headers'].toLowerCase().includes('x-chunk-sha256'));
});

test('chunked short MP4 with an invalid edit list normalizes playback and preserves the original only when opted in', async t => {
  const ctx = await setup(t);
  const video = withOutOfRangeEditList(await makeMp4(join(ctx.dataDir, 'short.mp4'), { duration: 0.04 }));
  const response=await ctx.request('POST',`/shelves/${ctx.shelfId}/uploads`,ctx.owner,{title:'Short clip',retainOriginal:true,files:[{filename:'short.mp4',mime:'video/mp4',size:video.length}]});
  assert.equal(response.statusCode,201,response.body);
  const upload=response.json();
  await ctx.send(upload, [video]);
  assert.equal((await ctx.request('POST', `/uploads/${upload.id}/complete`, ctx.owner)).statusCode, 202);
  const { item } = await ctx.wait(upload.id);
  const thumbnail = await ctx.request('GET', `/items/${item.id}/thumbnail`, ctx.owner);
  assert.equal(thumbnail.statusCode, 200, thumbnail.body);
  assert.equal((await sharp(thumbnail.rawPayload).metadata()).format, 'webp');
  assert.deepEqual(await readFile(join(ctx.dataDir,'originals',item.id)),video);
  assert.notDeepEqual((await ctx.request('GET',`/items/${item.id}/content`,ctx.owner)).rawPayload,video);
});

test('cancellation, logout and role revocation during thumbnail processing prevent publication', async t => {
  for (const action of ['cancel', 'logout', 'revoke']) await t.test(action, async t => {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const media = createMediaProcessor();
    t.after(release);
    const ctx = await setup(t, { mediaProcessor: { ...media, thumbnail: async (...args) => {
      started(); await gate; return media.thumbnail(...args);
    } } });
    const editor = await ctx.register('processing-editor');
    await ctx.request('POST', `/shelves/${ctx.shelfId}/members`, ctx.owner, { email: editor.user.email, role: 'editor' });
    const upload = await ctx.start(undefined, editor);
    const chunks = Math.ceil(pdf.length / upload.chunkSize);
    for (let index = 0; index < chunks; index++) {
      assert.equal((await ctx.part(upload, 0, index, pdf.subarray(index * upload.chunkSize, (index + 1) * upload.chunkSize), editor)).statusCode, 204);
    }
    assert.equal((await ctx.request('POST', `/uploads/${upload.id}/complete`, editor)).statusCode, 202);
    await entered;
    if (action === 'cancel') await ctx.request('DELETE', `/uploads/${upload.id}`, editor);
    if (action === 'logout') await ctx.request('POST', '/auth/logout', editor);
    if (action === 'revoke') await ctx.request('PATCH', `/shelves/${ctx.shelfId}/members/${editor.user.id}`, ctx.owner, { role: 'viewer' });
    release();
    await ctx.app.close(); // waits for the background queue and file cleanup
    const db = new DatabaseSync(join(ctx.dataDir, 'mirea.sqlite'));
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
      assert.equal(db.prepare('SELECT state FROM upload_sessions WHERE id=?').get(upload.id).state, action === 'cancel' ? 'cancelled' : 'failed');
    } finally { db.close(); }
    assert.equal((await readdir(join(ctx.dataDir, 'uploads', 'transfers'))).length, 0);
    assert.equal((await readdir(join(ctx.dataDir, 'uploads', 'staging'))).length, 0);
    assert.equal((await readdir(join(ctx.dataDir, 'thumbnails'))).length, 0);
  });
});
