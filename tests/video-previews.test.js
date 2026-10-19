import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { createMediaProcessor, ffmpegPath, MAX_PREVIEW_BYTES } from '../server/media.js';
import { makePdf, makeMp4, withOutOfRangeEditList } from './fixtures.js';

async function setup(t, customize) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mirea-preview-'));
  const media = createMediaProcessor();
  const options = { dataDir, rateLimit: false, mediaProcessor: customize ? customize(media) : media };
  const ctx = { dataDir, app: await createApp(options), options };
  t.after(async () => { await ctx.app.close(); await rm(dataDir, { recursive: true, force: true }); });
  ctx.request = (method, url, user, payload, headers = {}) => ctx.app.inject({ method, url: `/api/v1${url}`, headers: { ...(user ? { authorization: `Bearer ${user.token}` } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
  ctx.register = async name => (await ctx.request('POST', '/auth/register', null, { name, email: `${name}@example.test`, password: 'preview-password-12345' })).json();
  ctx.owner = await ctx.register('owner');
  ctx.shelf = (await ctx.request('POST', '/shelves', ctx.owner, { name: 'Video previews' })).json().id;
  ctx.upload = async (bytes, mime = 'video/mp4', filename = 'test.mp4') => {
    const boundary = 'preview-test';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const response = await ctx.request('POST', `/shelves/${ctx.shelf}/items`, ctx.owner, body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().item;
  };
  ctx.wait = async (id, state = 'ready') => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await ctx.request('GET', `/items/${id}/preview`, ctx.owner);
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json();
      if (result.state !== 'processing') { assert.equal(result.state, state, response.body); return result; }
      await delay(20);
    }
    assert.fail('Preview generation timed out');
  };
  return ctx;
}

test('video preview is deduplicated, silent, six seconds, bounded and protected by shelf membership', async t => {
  let conversions = 0;
  const ctx = await setup(t, media => ({ ...media, preview: (...args) => { conversions++; return media.preview(...args); } }));
  const original = await makeMp4(join(ctx.dataDir, 'original.mp4'), { duration: 8, width: 640, height: 360, audio: true });
  const item = await ctx.upload(original);
  const path = `/items/${item.id}/preview`;
  const viewer = await ctx.register('viewer'), outsider = await ctx.register('outsider');
  await ctx.request('POST', `/shelves/${ctx.shelf}/members`, ctx.owner, { email: viewer.user.email, role: 'viewer' });
  assert.equal((await ctx.request('GET', path, ctx.owner)).json().state, 'absent');
  assert.equal(conversions, 0);
  assert.equal((await ctx.request('POST', path)).statusCode, 401);
  assert.equal((await ctx.request('POST', path, outsider)).statusCode, 404);
  const responses = await Promise.all([ctx.request('POST', path, viewer), ctx.request('POST', path, ctx.owner)]);
  assert.ok(responses.every(response => [200, 202].includes(response.statusCode)));
  const ready = await ctx.wait(item.id);
  assert.equal(conversions, 1);
  assert.equal(ready.maxDuration, 6);
  assert.ok(ready.size <= MAX_PREVIEW_BYTES);
  const clip = await ctx.request('GET', `${path}/content`, viewer);
  assert.equal(clip.statusCode, 200);
  assert.equal(clip.headers['content-type'], 'video/mp4');
  assert.equal(clip.headers['cache-control'], 'private, no-store, no-transform');
  assert.ok(clip.rawPayload.length < original.length, 'preview must not download the original');
  const clipPath = join(ctx.dataDir, 'inspect.mp4');
  await writeFile(clipPath, clip.rawPayload);
  const decoded = await promisify(execFile)(ffmpegPath(), ['-hide_banner', '-i', clipPath, '-f', 'null', '-'], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.match(decoded.stderr, /Video: h264/);
  assert.match(decoded.stderr, /480x270/);
  assert.doesNotMatch(decoded.stderr, /Audio:/);
  const duration = decoded.stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  assert.ok(duration);
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  assert.ok(seconds >= 5.5 && seconds <= 6.1, `Preview duration: ${seconds}`);
  const range = await ctx.request('GET', `${path}/content`, viewer, undefined, { range: 'bytes=5-20' });
  assert.equal(range.statusCode, 206);
  assert.deepEqual(range.rawPayload, clip.rawPayload.subarray(5, 21));
  const head = await ctx.request('HEAD', `${path}/content`, viewer);
  assert.equal(Number(head.headers['content-length']), clip.rawPayload.length);
  assert.equal(head.body, '');
  assert.equal((await ctx.request('GET', `${path}/content`, outsider)).statusCode, 404);
  assert.equal((await ctx.request('GET', `${path}/content`)).statusCode, 401);
  await ctx.request('DELETE', `/shelves/${ctx.shelf}/members/${viewer.user.id}`, ctx.owner);
  for (const [method, url] of [['GET', path], ['POST', path], ['GET', `${path}/content`]]) assert.equal((await ctx.request(method, url, viewer)).statusCode, 404);
  assert.deepEqual((await ctx.request('GET', `/items/${item.id}/content`, ctx.owner)).rawPayload, original);
  await ctx.app.close();
  ctx.app = await createApp(ctx.options);
  assert.equal((await ctx.request('POST', path, ctx.owner)).json().state, 'ready');
  assert.equal(conversions, 1, 'restart must reuse the generated clip');
  await ctx.request('DELETE', `/items/${item.id}`, ctx.owner);
  assert.equal((await readdir(join(ctx.dataDir, 'previews'))).includes(`${item.id}.mp4`), false);
  await ctx.request('POST', '/auth/logout', ctx.owner);
  assert.equal((await ctx.request('GET', `${path}/content`, ctx.owner)).statusCode, 401);
});

test('preview failure leaves the image/original available and does not retry on every hover', async t => {
  let attempts = 0;
  const ctx = await setup(t, media => ({ ...media, preview: async (_source, destination) => {
    attempts++; await writeFile(destination, 'partial'); throw new Error('Encoder failure');
  } }));
  const item = await ctx.upload(await makeMp4(join(ctx.dataDir, 'source.mp4')));
  const path = `/items/${item.id}/preview`;
  await ctx.request('POST', path, ctx.owner);
  await ctx.wait(item.id, 'unavailable');
  assert.equal((await ctx.request('POST', path, ctx.owner)).json().state, 'unavailable');
  assert.equal(attempts, 1);
  assert.equal((await ctx.request('GET', `/items/${item.id}/thumbnail`, ctx.owner)).statusCode, 200);
  assert.equal((await ctx.request('GET', `/items/${item.id}/content`, ctx.owner)).statusCode, 200);
  assert.equal((await ctx.request('GET', `${path}/content`, ctx.owner)).statusCode, 404);
  const pdf = await ctx.upload(makePdf(), 'application/pdf', 'test.pdf');
  assert.equal((await ctx.request('POST', `/items/${pdf.id}/preview`, ctx.owner)).statusCode, 400);
  await ctx.app.close();
  assert.deepEqual(await readdir(join(ctx.dataDir, 'previews')), []);
});

test('short MP4 with out-of-range edits gets a decodable preview through the authenticated API', async t => {
  const ctx = await setup(t);
  const original = withOutOfRangeEditList(await makeMp4(join(ctx.dataDir, 'short.mp4'), { duration: 0.04 }));
  const item = await ctx.upload(original);
  assert.equal((await ctx.request('POST', `/items/${item.id}/preview`, ctx.owner)).statusCode, 202);
  await ctx.wait(item.id);
  const response = await ctx.request('GET', `/items/${item.id}/preview/content`, ctx.owner);
  assert.equal(response.statusCode, 200);
  const path = join(ctx.dataDir, 'preview-check.mp4');
  await writeFile(path, response.rawPayload);
  const { stderr } = await promisify(execFile)(ffmpegPath(), [
    '-hide_banner', '-abort_on', 'empty_output', '-i', path, '-map', '0:v:0', '-f', 'null', '-'
  ], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.match(stderr, /Video: h264/);
  assert.doesNotMatch(stderr, /Audio:/);
  assert.match(stderr, /Duration: 00:00:00\./);
  assert.deepEqual((await ctx.request('GET', `/items/${item.id}/content`, ctx.owner)).rawPayload, original);
});

test('deleting an item during encoding cannot leave an accessible or orphaned preview', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  t.after(release);
  const ctx = await setup(t, media => ({ ...media, preview: async (_source, destination) => {
    await writeFile(destination, 'incomplete'); started(); await gate;
  } }));
  const item = await ctx.upload(await makeMp4(join(ctx.dataDir, 'source.mp4')));
  await ctx.request('POST', `/items/${item.id}/preview`, ctx.owner);
  await entered;
  assert.equal((await ctx.request('DELETE', `/items/${item.id}`, ctx.owner)).statusCode, 204);
  assert.equal((await ctx.request('GET', `/items/${item.id}/preview/content`, ctx.owner)).statusCode, 404);
  release();
  await ctx.app.close();
  assert.deepEqual(await readdir(join(ctx.dataDir, 'previews')), []);
});
