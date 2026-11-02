import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { selectPreviewTarget, allowAutomaticPreview, mountVideoPreviews } from '../web/src/video-previews.js';

const rect = (top, left = 300, width = 400, height = 200) => ({ top, left, width, height, right: left + width, bottom: top + height });

test('scroll target is mostly visible and near the center, with hysteresis against small jitter', () => {
  const viewport = { width: 1000, height: 1000 };
  assert.equal(selectPreviewTarget([{ id: 'edge', rect: rect(-100) }, { id: 'middle', rect: rect(400) }, { id: 'lower', rect: rect(700) }], viewport), 'middle');
  assert.equal(selectPreviewTarget([{ id: 'outside', rect: rect(1000) }, { id: 'sliver', rect: rect(-150) }], viewport), null);
  const adjacent = [{ id: 'old', rect: rect(350) }, { id: 'new', rect: rect(400) }];
  assert.equal(selectPreviewTarget(adjacent, viewport, 'old'), 'old');
  adjacent[0].rect = rect(100);
  assert.equal(selectPreviewTarget(adjacent, viewport, 'old'), 'new');
});

test('automatic previews respect reduced motion, data saver and very slow connections', () => {
  assert.equal(allowAutomaticPreview(), true);
  assert.equal(allowAutomaticPreview({ reducedMotion: true }), false);
  assert.equal(allowAutomaticPreview({ saveData: true }), false);
  assert.equal(allowAutomaticPreview({ effectiveType: '2g' }), false);
  assert.equal(allowAutomaticPreview({ effectiveType: 'slow-2g' }), false);
  assert.equal(allowAutomaticPreview({ effectiveType: '4g' }), true);
});

class Element extends EventTarget {
  constructor(type = 'div') {
    super(); this.type = type; this.children = []; this.attributes = new Map(); this.isConnected = true;
    const classes = new Set();
    this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) };
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  append(child) { this.children.push(child); child.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }
  getBoundingClientRect() { return this.rect; }
  pause() { this.paused = true; this.pauseCount = (this.pauseCount ?? 0) + 1; }
  load() { this.loads = (this.loads ?? 0) + 1; }
  play() {
    if (this.rejectPlay) return Promise.reject(new Error('Autoplay blocked'));
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
}

function harness(t, { native = false, savedData = false, reducedMotion = false, rejectPlay = false, blobRequest } = {}) {
  const buttons = ['a', 'b'].map((id, index) => {
    const button = new Element('button'), cover = new Element();
    button.dataset = { previewId: id };
    cover.rect = rect(index === 0 ? 400 : 700);
    button.cover = cover;
    button.querySelector = () => cover;
    return button;
  });
  const win = new EventTarget();
  win.innerWidth = 1000; win.innerHeight = 1000;
  const reduce = new EventTarget(), hover = new EventTarget();
  reduce.matches = reducedMotion; hover.matches = true;
  win.matchMedia = query => query.includes('reduced-motion') ? reduce : hover;
  const doc = new EventTarget();
  doc.hidden = false;
  doc.querySelector = () => null;
  const videos = [];
  doc.createElement = type => {
    const element = new Element(type);
    if (type === 'video') { videos.push(element); element.rejectPlay = rejectPlay; }
    return element;
  };
  const connection = new EventTarget();
  connection.saveData = savedData; connection.effectiveType = '4g';
  const requested = [], blobs = [], revoked = [], created = [];
  const root = { querySelectorAll: () => buttons };
  const controller = mountVideoPreviews(root, {
    native, win, doc, nav: { connection },
    api: async (path, options) => { requested.push({ path, options }); return { state: 'ready' }; },
    authenticatedBlob: async (path, signal) => { blobs.push({ path, signal }); return blobRequest ? blobRequest(path, signal) : new Blob(['preview'], { type: 'video/mp4' }); },
    urls: { createObjectURL: blob => { const url = `blob:test-${created.length}`; created.push({ blob, url }); return url; }, revokeObjectURL: url => revoked.push(url) },
    hoverDelay: 15, scrollDelay: 20, idleDelay: 10
  });
  t.after(() => controller.dispose());
  return { controller, win, doc, reduce, connection, buttons, videos, requested, blobs, revoked, created };
}
const enter = element => element.dispatchEvent(Object.assign(new Event('pointerenter'), { pointerType: 'mouse' }));
const leave = element => element.dispatchEvent(new Event('pointerleave'));
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), 'Preview condition timed out');
}

test('desktop hover dwells, plays only one muted clip, and returns immediately to the image on leave', async t => {
  const h = harness(t);
  enter(h.buttons[0]); leave(h.buttons[0]);
  await delay(35);
  assert.equal(h.requested.length, 0, 'passing the cursor must not fetch a preview');
  enter(h.buttons[0]);
  await until(() => h.buttons[0].cover.classList.contains('preview-playing'));
  const first = h.videos[0];
  assert.equal(first.muted, true); assert.equal(first.volume, 0); assert.equal(first.loop, true);
  assert.equal(first.playsInline, true); assert.equal(first.controls, false);
  assert.equal(first.attributes.get('aria-hidden'), 'true');
  assert.equal(h.blobs[0].path, '/api/v1/items/a/preview/content');
  assert.ok(h.requested.every(request => request.path.endsWith('/preview')));
  enter(h.buttons[1]);
  assert.equal(first.paused, true);
  assert.equal(first.src, '');
  assert.equal(h.buttons[0].cover.classList.contains('preview-playing'), false);
  await until(() => h.buttons[1].cover.classList.contains('preview-playing'));
  assert.equal(h.videos.filter(video => !video.paused).length, 1);
  leave(h.buttons[1]);
  assert.equal(h.buttons[1].cover.classList.contains('preview-playing'), false);
  assert.deepEqual(h.revoked, h.created.map(entry => entry.url));
});

test('native scrolling stops playback immediately, waits for settling and selects the centered card', async t => {
  const h = harness(t, { native: true });
  await until(() => h.buttons[0].cover.classList.contains('preview-playing'));
  const first = h.videos[0];
  h.buttons[0].cover.rect = rect(-300);
  h.buttons[1].cover.rect = rect(400);
  for (let index = 0; index < 5; index++) { h.win.dispatchEvent(new Event('scroll')); await delay(5); }
  assert.equal(first.paused, true);
  assert.equal(h.requested.length, 1, 'scrolling must not start successive downloads');
  await until(() => h.buttons[1].cover.classList.contains('preview-playing'));
  assert.equal(h.requested.at(-1).path, '/items/b/preview');
  h.controller.setPaused('native', true);
  assert.ok(h.videos.every(video => video.paused));
  const count = h.requested.length;
  h.win.dispatchEvent(new Event('scroll'));
  await delay(50);
  assert.equal(h.requested.length, count);
  h.controller.setPaused('native', false);
  await until(() => h.buttons[1].cover.classList.contains('preview-playing'));
});

test('modal/background/visibility and data preferences stop or suppress automatic playback', async t => {
  const h = harness(t, { native: true });
  await until(() => h.videos.length === 1);
  h.controller.setPaused('dialog', true);
  h.controller.setPaused('native', true);
  h.controller.setPaused('dialog', false);
  const count = h.requested.length;
  await delay(50);
  assert.equal(h.requested.length, count, 'closing a modal must not override inactive app state');
  h.controller.setPaused('native', false);
  await until(() => h.videos.length === 2);
  h.doc.hidden = true; h.doc.dispatchEvent(new Event('visibilitychange'));
  assert.ok(h.videos.every(video => video.paused));
  h.doc.hidden = false; h.connection.saveData = true;
  h.doc.dispatchEvent(new Event('visibilitychange'));
  await delay(50);
  assert.equal(h.videos.length, 2);
  h.connection.saveData = false; h.reduce.matches = true; h.reduce.dispatchEvent(new Event('change'));
  await delay(50);
  assert.equal(h.videos.length, 2);
});

test('leaving during a download aborts it and ignores a late response without leaking object URLs', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const h = harness(t, { blobRequest: () => pending });
  enter(h.buttons[0]);
  await until(() => h.blobs.length === 1);
  leave(h.buttons[0]);
  assert.equal(h.blobs[0].signal.aborted, true);
  finish(new Blob(['late preview'], { type: 'video/mp4' }));
  await delay(20);
  assert.equal(h.created.length, 0);
  assert.equal(h.videos.length, 0);
  assert.equal(h.buttons[0].cover.classList.contains('preview-loading'), false);
});

test('autoplay rejection retains the image; disposal releases clips and all event subscriptions', async t => {
  const blocked = harness(t, { rejectPlay: true });
  enter(blocked.buttons[0]);
  await until(() => blocked.revoked.length === 1);
  assert.equal(blocked.buttons[0].cover.classList.contains('preview-playing'), false);
  assert.equal(blocked.buttons[0].cover.classList.contains('preview-loading'), false);
  const h = harness(t);
  enter(h.buttons[0]);
  await until(() => h.buttons[0].cover.classList.contains('preview-playing'));
  h.controller.dispose();
  assert.ok(h.videos.every(video => video.paused));
  assert.deepEqual(h.revoked, h.created.map(entry => entry.url));
  const count = h.requested.length;
  enter(h.buttons[1]); h.win.dispatchEvent(new Event('scroll'));
  await delay(40);
  assert.equal(h.requested.length, count);
});
