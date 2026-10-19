import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import ffmpeg from 'ffmpeg-static';

await mkdir('test-results', { recursive: true });
const destination = resolve('test-results/hover-preview.mp4');
await promisify(execFile)(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=8',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
  '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', destination
], { windowsHide: true, timeout: 30000 });
console.log(destination);
