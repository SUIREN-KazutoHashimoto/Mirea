import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { createResumableUpload } from '../web/src/resumable-upload.js';
import { makePdf } from './fixtures.js';

test('web upload client recovers a lost part response and resumes received parts after a network outage', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mirea-client-'));
  const app = await createApp({ dataDir, chunkSize: 128, maxUploadBytes: 8192, rateLimit: false });
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const memory = new Map();
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldXhr = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  let mode = 'lose-response', lost = false, outage = false;
  const requests = [];
  class XHR {
    upload = {};
    headers = {};
    controller = new AbortController();
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    abort() { this.controller.abort(); this.onabort?.(); }
    async send(body) {
      const part = Number(this.url.split('/').at(-1));
      requests.push(part);
      if (mode === 'outage' && (outage || part === 1)) { outage = true; this.onerror(); return; }
      try {
        const response = await fetch(this.url, { method: this.method, headers: this.headers, body, signal: this.controller.signal });
        this.status = response.status;
        this.responseText = await response.text();
        this.upload.onprogress?.({ lengthComputable: true, loaded: body.size });
        if (mode === 'lose-response' && !lost) { lost = true; this.onerror(); return; }
        this.onload();
      } catch { if (!this.controller.signal.aborted) this.onerror(); }
    }
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key)
  } });
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: XHR });
  t.after(async () => {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete globalThis.localStorage;
    if (oldXhr) Object.defineProperty(globalThis, 'XMLHttpRequest', oldXhr); else delete globalThis.XMLHttpRequest;
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const register = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { name: 'Client', email: 'client@example.test', password: 'client-test-password-1234' } });
  const user = register.json();
  const shelf = await app.inject({ method: 'POST', url: '/api/v1/shelves', headers: { authorization: `Bearer ${user.token}` }, payload: { name: 'Client test' } });
  const context = { endpoint, token: user.token, userId: user.user.id, unauthorized: () => assert.fail('Unexpected 401') };
  const file = new File([makePdf()], 'test.pdf', { type: 'application/pdf', lastModified: 123456 });
  const progress = [];
  const first = createResumableUpload(context, shelf.json().id, [file], 'Lost response', value => progress.push(value));
  assert.equal((await first.promise).item.kind, 'pdf');
  assert.equal(lost, true);
  assert.equal(requests.filter(index => index === 0).length, 2);
  assert.equal(progress.at(-1), 100);
  assert.equal(memory.size, 0);

  mode = 'outage'; requests.length = 0;
  const interrupted = createResumableUpload(context, shelf.json().id, [file], 'Resume', () => {});
  await assert.rejects(interrupted.promise, /通信が途切れ/);
  assert.equal(memory.size, 1);
  const saved = JSON.parse([...memory.values()][0]);
  const received = await app.inject({ url: `/api/v1/uploads/${saved.id}`, headers: { authorization: `Bearer ${user.token}` } });
  assert.deepEqual(received.json().files[0].receivedParts, [0]);
  mode = 'normal'; requests.length = 0;
  const resumed = createResumableUpload(context, shelf.json().id, [file], 'Resume', () => {});
  assert.equal((await resumed.promise).item.id, saved.id);
  assert.equal(requests.includes(0), false);
  assert.equal(memory.size, 0);

  mode = 'outage'; outage = false;
  const cancelled = createResumableUpload(context, shelf.json().id, [file], 'Cancel', () => {});
  // Abort during the first asynchronous fingerprint operation: no session leaks.
  cancelled.abort();
  await assert.rejects(cancelled.promise, /キャンセル/);
  assert.equal(memory.size, 0);
});
