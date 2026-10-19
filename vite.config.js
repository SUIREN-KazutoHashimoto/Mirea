import { defineConfig } from 'vite';
import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'web',
  envDir: '..',
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022',rollupOptions:{input:{index:resolve('web/index.html'),'download-sw':resolve('web/src/download-sw.js')},output:{entryFileNames:chunk=>chunk.name==='download-sw'?'download-sw.js':'assets/[name]-[hash].js'}} },
  server: { headers:{'Service-Worker-Allowed':'/'},proxy: { '/api': 'http://127.0.0.1:3000' } },
  plugins: [{
    name: 'pdf-fonts-and-codecs',
    closeBundle() {
      mkdirSync('dist/pdf-assets', { recursive: true });
      for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
        cpSync(resolve('node_modules/pdfjs-dist', dir), resolve('dist/pdf-assets', dir), { recursive: true });
      }
    }
  }]
});
