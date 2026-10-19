import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PROJECT_ROOT, runtimeConfig, loadEnvironment,loadTlsOptions } from '../server/runtime.js';
import { makePdf } from './fixtures.js';

const entry = join(PROJECT_ROOT, 'server', 'index.js');
const runFile = promisify(execFile);

test('runtime defaults and relative storage are independent of the launch directory', () => {
  assert.deepEqual(runtimeConfig({}), { host: '127.0.0.1', port: 3000, dataDir: join(PROJECT_ROOT, 'data') });
  assert.equal(runtimeConfig({ DATA_DIR: './library' }).dataDir, join(PROJECT_ROOT, 'library'));
  const docker = runtimeConfig({ HOST: '0.0.0.0', PORT: '3000', DATA_DIR: '/data' });
  assert.deepEqual(docker, { host: '0.0.0.0', port: 3000, dataDir: resolve('/data') });
});

test('invalid bind/storage configuration fails before creating or opening a database', () => {
  for (const port of ['-1', '65536', '1.2', '1e3', '', 'wrong']) assert.throws(() => runtimeConfig({ PORT: port }), /PORT/);
  assert.equal(runtimeConfig({ PORT: '0' }).port, 0);
  assert.equal(runtimeConfig({ PORT: '65535' }).port, 65535);
  assert.throws(() => runtimeConfig({ HOST: ' ' }), /HOST/);
  assert.throws(() => runtimeConfig({ DATA_DIR: '' }), /DATA_DIR/);
});

test('direct HTTPS is opt-in, requires both files and never silently falls back to HTTP',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mirea-tls-config-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  assert.equal(await loadTlsOptions({}),undefined);
  await assert.rejects(loadTlsOptions({HTTPS_KEY_FILE:'key.pem'},directory),/configured together/);
  await assert.rejects(loadTlsOptions({HTTPS_CERT_FILE:'cert.pem'},directory),/configured together/);
  await assert.rejects(loadTlsOptions({HTTPS_KEY_FILE:'missing',HTTPS_CERT_FILE:'missing'},directory),{code:'ENOENT'});
  await writeFile(join(directory,'key.pem'),'test key');await writeFile(join(directory,'cert.pem'),'test chain');
  const tls=await loadTlsOptions({HTTPS_KEY_FILE:'key.pem',HTTPS_CERT_FILE:'cert.pem'},directory);
  assert.equal(tls.key.toString(),'test key');assert.equal(tls.cert.toString(),'test chain');assert.equal(tls.minVersion,'TLSv1.2');
});

test('optional env file loads values without overriding explicit process variables', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mirea-env-'));
  const filename = join(directory, 'test.env');
  const oldValue = process.env.MIREA_TEST_EXISTING;
  const oldLoaded = process.env.MIREA_TEST_LOADED;
  t.after(async () => {
    if (oldValue === undefined) delete process.env.MIREA_TEST_EXISTING; else process.env.MIREA_TEST_EXISTING = oldValue;
    if (oldLoaded === undefined) delete process.env.MIREA_TEST_LOADED; else process.env.MIREA_TEST_LOADED = oldLoaded;
    await rm(directory, { recursive: true, force: true });
  });
  process.env.MIREA_TEST_EXISTING = 'process';
  delete process.env.MIREA_TEST_LOADED;
  await writeFile(filename, 'MIREA_TEST_EXISTING=file\nMIREA_TEST_LOADED="from file"\n');
  loadEnvironment(filename);
  assert.equal(process.env.MIREA_TEST_EXISTING, 'process');
  assert.equal(process.env.MIREA_TEST_LOADED, 'from file');
  assert.doesNotThrow(() => loadEnvironment(join(directory, 'missing.env')));
  assert.throws(() => loadEnvironment(directory));
});

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function startNative(t, directory, dataDir) {
  const child = spawn(process.execPath, [entry], {
    cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, ALLOW_REGISTRATION: 'true' }
  });
  t.after(() => stop(child));
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Native server startup timed out: ${output.slice(-2000)}`)), 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Native server exited (${code}): ${output.slice(-2000)}`)); });
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return { child, url };
}

test('direct Node entry serves built web, uploads/streams a PDF and retains accounts/files after restart', async t => {
  await access(join(PROJECT_ROOT, 'dist', 'index.html')).catch(() => assert.fail('Run pnpm build before pnpm test:startup'));
  const directory = await mkdtemp(join(tmpdir(), 'mirea-native-'));
  const dataDir = join(directory, 'library data');
  const children = [];
  t.after(async () => { for (const child of children) await stop(child); await rm(directory, { recursive: true, force: true }); });
  const first = await startNative(t, directory, dataDir);
  children.push(first.child);
  const request = (server, path, options = {}) => fetch(`${server}${path}`, { ...options, signal: AbortSignal.timeout(15000) });
  assert.equal((await request(first.url, '/api/health')).status, 200);
  const html = await request(first.url, '/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(await html.text(), /Mirea/);
  const registered = await request(first.url, '/api/v1/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Native runtime', email: 'native@example.test', password: 'native-runtime-password-1234' })
  });
  assert.equal(registered.status, 201);
  const user = await registered.json();
  const headers = { authorization: `Bearer ${user.token}` };
  const json = { ...headers, 'content-type': 'application/json' };
  const shelfResponse = await request(first.url, '/api/v1/shelves', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Native shelf' }) });
  const shelf = await shelfResponse.json();
  const pdf = makePdf();
  const uploadResponse = await request(first.url, `/api/v1/shelves/${shelf.id}/uploads`, {
    method: 'POST', headers: json, body: JSON.stringify({ title: 'Native PDF', files: [{ filename: 'test.pdf', mime: 'application/pdf', size: pdf.length }] })
  });
  assert.equal(uploadResponse.status, 201);
  const upload = await uploadResponse.json();
  const part = await request(first.url, `/api/v1/uploads/${upload.id}/files/0/parts/0`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-chunk-sha256': createHash('sha256').update(pdf).digest('hex') }, body: pdf
  });
  assert.equal(part.status, 204);
  assert.equal((await request(first.url, `/api/v1/uploads/${upload.id}/complete`, { method: 'POST', headers })).status, 202);
  let status;
  for (let attempts = 0; attempts < 100; attempts++) {
    status = await (await request(first.url, `/api/v1/uploads/${upload.id}`, { headers })).json();
    if (status.state !== 'processing') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(status.state, 'complete', JSON.stringify(status));
  const thumb = await request(first.url, status.item.thumbnailUrl, { headers });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  await thumb.arrayBuffer();
  await stop(first.child);
  const second = await startNative(t, directory, dataDir);
  children.push(second.child);
  assert.equal((await request(second.url, '/api/v1/auth/me', { headers })).status, 200);
  const range = await request(second.url, `/api/v1/items/${upload.id}/content`, { headers: { ...headers, range: 'bytes=5-20' } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), pdf.subarray(5, 21));
  await access(join(dataDir, 'mirea.sqlite'));
  await access(join(dataDir, 'uploads', upload.id));
});

test('invalid PORT exits with a clear error and does not initialize data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mirea-invalid-start-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'untouched');
  await assert.rejects(runFile(process.execPath, [entry], {
    cwd: directory, windowsHide: true, timeout: 10000,
    env: { ...process.env, PORT: 'not-a-port', DATA_DIR: dataDir }
  }), error => /PORT must be an integer/.test(error.stderr));
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
});
