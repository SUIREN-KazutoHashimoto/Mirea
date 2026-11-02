import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import ffmpeg from 'ffmpeg-static';

export function makePdf(pageCount=1) {
  if(!Number.isInteger(pageCount)||pageCount<1||pageCount>100)throw Error('Invalid synthetic page count');
  const text = 'BT /F1 24 Tf 50 700 Td (Mirea thumbnail test) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
  ];
  for(let page=1;page<pageCount;page++)objects.push(objects[2]);
  objects[1]=`<< /Type /Pages /Kids [${[3,...Array.from({length:pageCount-1},(_,index)=>6+index)].map(id=>id+' 0 R').join(' ')}] /Count ${pageCount} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

export async function makeMp4(filename, { duration = 0.2, width = 64, height = 64, audio = false, fps = 25, color = 'blue' } = {}) {
  await promisify(execFile)(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:r=${fps}:d=${duration}`,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`, '-c:a', 'aac', '-shortest'] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', filename
  ], { timeout: 15_000, windowsHide: true });
  return readFile(filename);
}

// Reproduce an out-of-range MP4 edit without retaining any user media in Git.
export function withOutOfRangeEditList(original) {
  const bytes = Buffer.from(original);
  function boxes(start, end) {
    const result = [];
    for (let offset = start; offset + 8 <= end;) {
      let size = bytes.readUInt32BE(offset), header = 8;
      if (size === 1) { size = Number(bytes.readBigUInt64BE(offset + 8)); header = 16; }
      if (size === 0) size = end - offset;
      if (size < header || offset + size > end) throw new Error('Invalid fixture MP4 box');
      result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), start: offset + header, end: offset + size });
      offset += size;
    }
    return result;
  }
  const child = (parent, type) => boxes(parent.start, parent.end).find(box => box.type === type);
  const movie = child({ start: 0, end: bytes.length }, 'moov');
  let edits = 0;
  for (const track of boxes(movie.start, movie.end).filter(box => box.type === 'trak')) {
    const list = child(child(track, 'edts'), 'elst');
    if (bytes.readUInt32BE(list.start + 4) !== 1) throw new Error('Expected one fixture edit');
    if (bytes[list.start] === 1) bytes.writeBigInt64BE(1_000_000_000n, list.start + 16);
    else bytes.writeInt32BE(1_000_000_000, list.start + 12);
    edits++;
  }
  if (!edits) throw new Error('Fixture has no edit list');
  return bytes;
}
