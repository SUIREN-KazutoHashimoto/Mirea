// Deterministic, self-contained two-page PDF fixture for manual upload/reader QA.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputDir = resolve('test-results');
await mkdir(outputDir, { recursive: true });
const stream = text => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  stream('0.286 0.408 0.929 rg\n45 620 505 160 re f\nBT /F1 40 Tf 1 1 1 rg 70 700 Td (Mirea) Tj 0 -50 Td /F1 18 Tf (Your shared media library.) Tj ET\nBT /F1 14 Tf 0.3 0.35 0.45 rg 50 570 Td (This is a local PDF reader verification document.) Tj 0 -28 Td (Page 1 of 2 - use the next arrow to continue.) Tj ET'),
  stream('BT /F1 30 Tf 0.286 0.408 0.929 rg 50 750 Td (A place for your stories.) Tj 0 -65 Td /F1 14 Tf 0.3 0.35 0.45 rg (Page 2 of 2.) Tj 0 -28 Td (PDF upload, font loading, zoom and navigation.) Tj ET')
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
for (const [index, content] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${content}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const filename = resolve(outputDir, 'mirea-reader-test.pdf');
await writeFile(filename, pdf);
console.log(filename);
