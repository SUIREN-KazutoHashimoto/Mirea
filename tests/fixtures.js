import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import ffmpeg from 'ffmpeg-static';

export function makePdf() {
  const text = 'BT /F1 24 Tf 50 700 Td (Mirea thumbnail test) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${pdf}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

export async function makeMp4(filename, { duration = 0.2, width = 64, height = 64, audio = false } = {}) {
  await promisify(execFile)(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${width}x${height}:d=${duration}`,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`, '-c:a', 'aac', '-shortest'] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', filename
  ], { timeout: 15_000, windowsHide: true });
  return readFile(filename);
}
