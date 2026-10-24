import { defineConfig } from 'vite';
import { cpSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import {createHash} from 'node:crypto';
import { resolve } from 'node:path';
import {buildPwaIcons} from './scripts/pwa-icons.mjs';

export default defineConfig({
  root: 'web',
  envDir: '..',
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022',rollupOptions:{input:{index:resolve('web/index.html'),'download-sw':resolve('web/src/download-sw.js')},output:{entryFileNames:chunk=>chunk.name==='download-sw'?'download-sw.js':'assets/[name]-[hash].js'}} },
  server: { headers:{'Service-Worker-Allowed':'/'},proxy: { '/api': 'http://127.0.0.1:3000' } },
  plugins: [{
    name: 'pdf-fonts-and-codecs',
    async closeBundle() {
      await buildPwaIcons();
      mkdirSync('dist/pdf-assets', { recursive: true });
      for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
        cpSync(resolve('node_modules/pdfjs-dist', dir), resolve('dist/pdf-assets', dir), { recursive: true });
      }
      const files=[];
      function walk(folder){for(const entry of readdirSync(folder,{withFileTypes:true})){const path=folder+'/'+entry.name;if(entry.isDirectory())walk(path);else if(!path.endsWith('/offline-assets.json'))files.push('/'+path.slice('dist/'.length));}}
      walk('dist');
      const revision=createHash('sha256');for(const file of files.sort())revision.update(file).update(readFileSync('dist'+file));
      const version=revision.digest('hex');
      // SW byte identity must change with the UI build, not just SW source.
      // Otherwise register() considers it unchanged and keeps an old shell.
      writeFileSync('dist/download-sw.js',readFileSync('dist/download-sw.js','utf8')+'\n// Mirea offline shell '+version+'\n');
      writeFileSync('dist/offline-assets.json',JSON.stringify({version,files}));
    }
  }]
});
