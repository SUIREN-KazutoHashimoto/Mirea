import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createMediaProcessor, ffmpegPath } from '../server/media.js';
import { makeMp4, withOutOfRangeEditList } from './fixtures.js';

const run = promisify(execFile);
const options = { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true };
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mirea-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, media: createMediaProcessor(), source: join(directory, 'source.mp4') };
}
async function inspectPreview(path) {
  const { stderr } = await run(ffmpegPath(), [
    '-hide_banner', '-abort_on', 'empty_output', '-i', path, '-map', '0:v:0', '-f', 'null', '-'
  ], options);
  assert.match(stderr, /Video: h264/);
  assert.doesNotMatch(stderr, /Audio:/);
  const duration = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  assert.ok(duration, stderr);
  return Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
}

test('short videos use their available frames, including one-frame and low-frame-rate clips', async t => {
  for (const clip of [
    { duration: 0.01, fps: 25, color: 'red', channel: 0 },
    { duration: 0.04, fps: 25, color: 'blue', channel: 2 },
    { duration: 0.2, fps: 25, color: 'green', channel: 1 },
    { duration: 0.5, fps: 2, color: 'red', channel: 0 },
    { duration: 2, fps: 24, color: 'blue', channel: 2 }
  ]) await t.test(`${clip.duration}s at ${clip.fps}fps`, async t => {
    const { directory, source, media } = await setup(t);
    const original = await makeMp4(source, clip);
    const thumbnail = join(directory, 'thumbnail.jpg'), preview = join(directory, 'preview.mp4');
    const chosen=await media.thumbnail(source, 'video/mp4', thumbnail);assert.equal(chosen.pageCount,1);assert(chosen.seekSeconds>=0);
    const metadata = await sharp(thumbnail).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 64);
    const { channels } = await sharp(thumbnail).stats();
    assert.ok(channels[clip.channel].mean > 80, 'thumbnail must contain this video, not a placeholder');
    assert.ok(channels.filter((_, index) => index !== clip.channel).every(channel => channel.mean < 20));
    await media.preview(source, preview, 'video/mp4');
    const duration = await inspectPreview(preview);
    assert.ok(duration > 0 && duration <= Math.max(clip.duration, 1 / clip.fps) + 0.15, `Unexpected preview duration: ${duration}`);
    assert.deepEqual(await readFile(source), original, 'source video must remain unchanged');
  });
});

test('out-of-range MP4 edits retry only empty results and generate real image/video thumbnails', async t => {
  const { directory, source, media } = await setup(t);
  const original = withOutOfRangeEditList(await makeMp4(source, { duration: 0.2 }));
  await writeFile(source, original);
  await assert.rejects(run(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-abort_on', 'empty_output', '-i', source,
    '-map', '0:v:0', '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-f', 'image2pipe', 'pipe:1'
  ], options), error => /Output file is empty/.test(error.stderr));
  const thumbnail = join(directory, 'thumbnail.jpg'), preview = join(directory, 'preview.mp4');
  await media.thumbnail(source, 'video/mp4', thumbnail);
  assert.equal((await sharp(thumbnail).metadata()).format, 'jpeg');
  await media.preview(source, preview, 'video/mp4');
  assert.ok(await inspectPreview(preview) < 0.5, 'do not pad a short video to ten seconds');
  assert.deepEqual(await readFile(source), original);
});

test('WebM short clips use the ordinary decoder without MP4-only options', async t => {
  const { directory, media } = await setup(t);
  const source = join(directory, 'source.webm'), thumbnail = join(directory, 'thumbnail.jpg'), preview = join(directory, 'preview.mp4');
  await run(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.04', '-c:v', 'libvpx-vp9', source], options);
  await media.thumbnail(source, 'video/webm', thumbnail);
  assert.equal((await sharp(thumbnail).metadata()).format, 'jpeg');
  await media.preview(source, preview, 'video/webm');
  assert.ok(await inspectPreview(preview) > 0);
});

test('normal MP4 edits keep their authored start instead of always enabling the compatibility path', async t => {
  const { directory, source, media } = await setup(t);
  const uncut = join(directory, 'uncut.mp4');
  await run(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=25:d=3',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=25:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', uncut
  ], options);
  await run(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-ss', '3', '-i', uncut, '-t', '0.5', '-c', 'copy', source], options);
  const thumbnail = join(directory, 'thumbnail.jpg');
  await media.thumbnail(source, 'video/mp4', thumbnail);
  const { channels } = await sharp(thumbnail).stats();
  assert.ok(channels[2].mean > 200 && channels[0].mean < 20, 'respect the edit that starts on blue, not the red preroll');
});

test('missing sources and videos without picture frames are not reported as missing FFmpeg', async t => {
  const { directory, source, media } = await setup(t);
  const thumbnail = join(directory, 'thumbnail.jpg'), preview = join(directory, 'preview.mp4');
  for (const convert of [() => media.thumbnail(source, 'video/mp4', thumbnail), () => media.preview(source, preview, 'video/mp4')]) {
    await assert.rejects(convert(), error => error.statusCode === 422 && !error.message.includes('FFmpeg'));
  }
  await run(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.2', '-c:a', 'aac', source], options);
  await writeFile(thumbnail, 'stale thumbnail');
  await writeFile(preview, 'stale preview');
  for (const convert of [() => media.thumbnail(source, 'video/mp4', thumbnail), () => media.preview(source, preview, 'video/mp4')]) {
    await assert.rejects(convert(), error => error.statusCode === 422 && !error.message.includes('FFmpeg'));
  }
  for (const path of [thumbnail, preview]) await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('an actually missing FFmpeg executable is reported as a server configuration error', async t => {
  const { directory, source, media } = await setup(t);
  const previous = process.env.FFMPEG_PATH;
  t.after(() => { if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous; });
  process.env.FFMPEG_PATH = join(directory, 'missing-ffmpeg-executable');
  for (const convert of [
    () => media.thumbnail(source, 'video/mp4', join(directory, 'thumbnail.jpg')),
    () => media.preview(source, join(directory, 'preview.mp4'), 'video/mp4')
  ]) await assert.rejects(convert(), error => error.statusCode === 503 && error.message.includes('FFmpeg') && error.cause.code === 'ENOENT');
});
