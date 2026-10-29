import sharp from 'sharp';
import {devNull} from 'node:os';

// stats() forces random access and spills large decoded images to scratch disk.
// Validate every pixel once in scanline order instead. The uncompressed PNG
// encoder writes directly to the OS null device, not a JS buffer or temp file.
// No resize/shrink, orientation, original rewrite or failOn relaxation occurs.
export async function validateImagePixels(source, options) {
  await sharp(source, {...options, sequentialRead: true})
    .png({compressionLevel: 0, adaptiveFiltering: false, progressive: false})
    .toFile(devNull);
}
