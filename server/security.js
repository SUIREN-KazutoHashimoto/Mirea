import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const hashToken = token => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw httpError(416, '無効な再生範囲です。');
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw httpError(416, '無効な再生範囲です。');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      throw httpError(416, '無効な再生範囲です。');
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function matchesFileType(mime, head) {
  if (['audio/mp4','audio/x-m4a'].includes(mime)) return matchesFileType('video/mp4',head);
  if (['audio/mpeg','audio/mp3'].includes(mime)) return head.subarray(0,3).toString()==='ID3' || head.length>=2 && head[0]===0xff && (head[1]&0xe0)===0xe0 && (head[1]&0x06)!==0;
  if (mime==='audio/aac') return head.length>=2 && head[0]===0xff && (head[1]&0xf6)===0xf0;
  if (['audio/wav','audio/x-wav','audio/wave'].includes(mime)) return head.length>=12 && ['RIFF','RF64'].includes(head.subarray(0,4).toString()) && head.subarray(8,12).toString()==='WAVE';
  if (['audio/flac','audio/x-flac'].includes(mime)) return head.subarray(0,4).toString()==='fLaC' || head.subarray(0,3).toString()==='ID3';
  if (['audio/ogg','audio/opus'].includes(mime)) return head.subarray(0,4).toString()==='OggS';
  if (['audio/aiff','audio/x-aiff'].includes(mime)) return head.length>=12 && head.subarray(0,4).toString()==='FORM' && ['AIFF','AIFC'].includes(head.subarray(8,12).toString());
  if (mime==='audio/x-ms-wma') return matchesFileType('video/x-ms-asf',head);
  if (mime==='audio/webm') return matchesFileType('video/webm',head);
  if (mime === 'application/epub+zip') return head.length >= 4 && head.subarray(0,4).equals(Buffer.from([0x50,0x4b,3,4]));
  if (mime === 'application/pdf') return head.subarray(0, 5).toString() === '%PDF-';
  if (mime === 'video/mp4') return head.length >= 12 && head.subarray(4, 8).toString() === 'ftyp';
  if (mime === 'video/webm') return head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === 'video/x-matroska') return matchesFileType('video/webm',head);
  if (mime === 'video/quicktime') return head.length>=8 && ['ftyp','moov','mdat','wide','free'].includes(head.subarray(4,8).toString());
  if (mime === 'video/x-msvideo') return head.length>=12 && head.subarray(0,4).toString()==='RIFF' && head.subarray(8,12).toString()==='AVI ';
  if (['video/x-ms-wmv','video/x-ms-asf'].includes(mime)) return head.length>=16 && head.subarray(0,16).equals(Buffer.from('3026b2758e66cf11a6d900aa0062ce6c','hex'));
  if (mime === 'video/mp2t') return head[0]===0x47 || head[4]===0x47;
  if (mime === 'video/x-flv') return head.subarray(0,3).toString()==='FLV';
  if (mime === 'video/mpeg') return head.length>=4 && head[0]===0 && head[1]===0 && head[2]===1 && [0xba,0xb3].includes(head[3]);
  if (mime === 'image/jpeg') return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mime === 'image/png') return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/webp') return head.length >= 12 && head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP';
  return false;
}
