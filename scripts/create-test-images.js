import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('test-results', { recursive: true });
for (const [number, color] of [[1, '#4968ed'], [2, '#d68850'], [10, '#6a9c83']]) {
  const filename = resolve('test-results', `page-${number}.png`);
  await sharp({ create: { width: 600, height: 840, channels: 3, background: color } })
    .composite([{ input: Buffer.from(`<svg width="600" height="840"><text x="65" y="140" font-family="sans-serif" font-size="66" fill="white">Mirea</text><text x="65" y="225" font-family="sans-serif" font-size="38" fill="white">Page ${number}</text><path d="M65 310H535M65 350H450M65 390H500" stroke="white" stroke-width="5" opacity=".5"/></svg>`) }])
    .png().toFile(filename);
  console.log(filename);
}
