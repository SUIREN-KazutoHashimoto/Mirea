import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {waitForMediaWorker} from '../server/media-worker-lifecycle.js';
import {createJobPool} from '../server/job-pool.js';

class ControlledWorker extends EventEmitter {
  terminations = 0;
  terminate() {
    this.terminations++;
    return new Promise(resolve => this.once('exit', resolve));
  }
}

test('a result keeps the job pool occupied until worker cleanup and natural exit finish', async () => {
  const worker = new ControlledWorker(), pool = createJobPool(() => 1);
  let settled = false, nextStarted = false;
  const first = pool.run(() => waitForMediaWorker(worker)).then(result => { settled = true; return result; });
  const next = pool.run(() => { nextStarted = true; });
  await delay(0);
  worker.emit('message', {pageCount: 1});
  await delay(0);
  assert.equal(settled, false); assert.equal(nextStarted, false); assert.equal(worker.terminations, 0);
  worker.emit('exit', 0);
  assert.deepEqual(await first, {pageCount: 1}); await next;
  assert.equal(nextStarted, true);
});

test('a success message cannot hide an abnormal exit or a worker error', async () => {
  for (const error of [null, new Error('Synthetic worker failure')]) {
    const worker = new ControlledWorker(), promise = waitForMediaWorker(worker);
    const rejected = assert.rejects(promise, actual => error ? actual === error : actual.code === 'MEDIA_WORKER_FAILED');
    worker.emit('message', {pageCount: 1});
    if (error) worker.emit('error', error);
    worker.emit('exit', 1);
    await rejected; assert.equal(worker.terminations, 0);
  }
});

test('exit without a result fails and worker errors do not release the job before exit', async () => {
  const worker = new ControlledWorker(), error = new Error('Synthetic decoder failure');
  let settled = false;
  const promise = waitForMediaWorker(worker).finally(() => { settled = true; });
  const rejected = assert.rejects(promise, actual => actual === error);
  worker.emit('error', error); await delay(0); assert.equal(settled, false);
  worker.emit('exit', 1); await rejected;
  const empty = new ControlledWorker(), missing = assert.rejects(waitForMediaWorker(empty), {code: 'MEDIA_WORKER_FAILED'});
  empty.emit('exit', 0); await missing;
});

test('the deadline includes cleanup after a result and waits for forced exit', async () => {
  const worker = new ControlledWorker();
  let settled = false;
  const promise = waitForMediaWorker(worker, {timeoutMs: 10}).finally(() => { settled = true; });
  const rejected = assert.rejects(promise, {code: 'MEDIA_PROCESSING_TIMEOUT'});
  worker.emit('message', {pageCount: 1}); await delay(30);
  assert.equal(worker.terminations, 1); assert.equal(settled, false);
  worker.emit('exit', 1); await rejected;
});

test('cancellation preserves its reason and waits for forced exit, even after a result', async () => {
  for (const alreadyAborted of [false, true]) {
    const worker = new ControlledWorker(), controller = new AbortController(), reason = new Error('Synthetic cancellation');
    if (alreadyAborted) controller.abort(reason);
    let settled = false;
    const promise = waitForMediaWorker(worker, {signal: controller.signal}).finally(() => { settled = true; });
    const rejected = assert.rejects(promise, actual => actual === reason);
    worker.emit('message', {pageCount: 1}); controller.abort(reason); await delay(0);
    assert.equal(worker.terminations, 1); assert.equal(settled, false);
    worker.emit('exit', 1); await rejected;
  }
});

test('real ESM workers finish asynchronous module cleanup before callers may remove source files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mirea-worker-lifecycle-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const marker = join(directory, 'cleanup.txt');
  const source = `import {parentPort,workerData} from 'node:worker_threads';
    import {setTimeout as delay} from 'node:timers/promises';
    import {writeFile} from 'node:fs/promises';
    try { parentPort.postMessage({pageCount:1}); }
    finally { await delay(30); await writeFile(workerData.marker,'cleanup finished'); parentPort.close(); }`;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(source)), {workerData: {marker}});
  assert.deepEqual(await waitForMediaWorker(worker), {pageCount: 1});
  assert.equal(await readFile(marker, 'utf8'), 'cleanup finished');
  assert.equal(worker.threadId, -1);
});

test('real workers that keep running after a result remain subject to timeout and cancellation', async () => {
  const source = `import {parentPort} from 'node:worker_threads'; parentPort.postMessage({pageCount:1}); parentPort.close(); setInterval(()=>{},1000);`;
  for (const cancel of [false, true]) {
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(source)));
    const controller = new AbortController(), reason = new Error('Synthetic cancellation');
    const promise = waitForMediaWorker(worker, {signal: controller.signal, timeoutMs: 1000});
    const rejected = assert.rejects(promise, error => cancel ? error === reason : error.code === 'MEDIA_PROCESSING_TIMEOUT');
    if (cancel) worker.once('message', () => controller.abort(reason));
    await rejected; assert.equal(worker.threadId, -1);
  }
});
