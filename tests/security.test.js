import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, matchesFileType, hashPassword, verifyPassword } from '../server/security.js';

test('byte ranges support seek, suffix and open-ended requests, rejecting invalid ranges', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=20-39', 100), { start: 20, end: 39 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-200', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=90-200', 100), { start: 90, end: 99 });
  for (const range of ['bytes=-', 'bytes=-0', 'bytes=100-', 'bytes=9-2', 'bytes=0-1,3-4', 'words=0-1', 'bytes=999999999999999999999-']) {
    assert.throws(() => parseRange(range, 100), { statusCode: 416 });
  }
});
test('file signatures reject files disguised as a PDF or video', () => {
  assert.ok(matchesFileType('application/pdf', Buffer.from('%PDF-1.7')));
  assert.ok(matchesFileType('video/mp4', Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom')])));
  assert.ok(matchesFileType('video/webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
  assert.equal(matchesFileType('application/pdf', Buffer.from('<script>')), false);
  assert.equal(matchesFileType('image/svg+xml', Buffer.from('<svg>')), false);
});
test('passwords use independently salted scrypt hashes', async () => {
  const first = await hashPassword('a long password 123');
  const second = await hashPassword('a long password 123');
  assert.notEqual(first, second);
  assert.ok(await verifyPassword('a long password 123', first));
  assert.equal(await verifyPassword('incorrect', first), false);
});
