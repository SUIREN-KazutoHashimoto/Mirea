// Keep document parsing and image decoding off the API event loop.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { stat } from 'node:fs/promises';

sharp.cache(false);
sharp.concurrency(1);

const { source, destination, mode } = workerData;
// Image uploads are limited by encoded file size, not dimensions (owner-approved
// policy). Preserve strict decoding and the separate worker/time/concurrency limits.
const imageOptions = { limitInputPixels: false, failOn: 'warning' };
try {
  if (mode === 'epub-thumbnail') {
    const { compileEpub } = await import('./epub.js');
    parentPort.postMessage(await compileEpub(source,destination,workerData.bundlePath));
  } else if (mode === 'validate-image') {
    const metadata = await sharp(source, imageOptions).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) > 1) {
      throw new Error('JPEG・PNG・WebPの静止画像を選択してください。');
    }
    // Fully decode for integrity checking, but preserve original page bytes and quality.
    await sharp(source, imageOptions).stats();
    const swap = [5, 6, 7, 8].includes(metadata.orientation);
    parentPort.postMessage({ width: swap ? metadata.height : metadata.width, height: swap ? metadata.width : metadata.height, size: (await stat(source)).size });
  } else if (mode === 'image-thumbnail') {
    await sharp(source, imageOptions).rotate().flatten({ background: '#ffffff' })
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 }).toFile(destination);
    parentPort.postMessage({ pageCount: 1 });
  } else if (mode === 'pdf-thumbnail') {
    const { createCanvas, DOMMatrix, ImageData, Path2D } = await import('@napi-rs/canvas');
    globalThis.DOMMatrix ??= DOMMatrix;
    globalThis.ImageData ??= ImageData;
    globalThis.Path2D ??= Path2D;
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const require = createRequire(import.meta.url);
    const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
    const assetDirectory = name => join(pdfRoot, name).replaceAll('\\', '/') + '/';
    const document = await getDocument({
      url: pathToFileURL(source).href,
      cMapUrl: assetDirectory('cmaps'), cMapPacked: true,
      standardFontDataUrl: assetDirectory('standard_fonts'),
      wasmUrl: assetDirectory('wasm'),
      isEvalSupported: false, useSystemFonts: true, maxImageSize: 40_000_000,
      disableAutoFetch: true, disableStream: true
    }).promise;
    try {
      const page = await document.getPage(1);
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1024 / original.width, 1024 / original.height, 1) });
      const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
      await sharp(canvas.toBuffer('image/png')).jpeg({ quality: 82 }).toFile(destination);
      parentPort.postMessage({ pageCount: document.numPages });
    } finally { await document.destroy(); }
  } else throw new Error('Unsupported media operation');
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
