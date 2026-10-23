import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {checkHealth} from '../server/healthcheck.mjs';
import pkg from '../package.json' with {type:'json'};
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
test('container context is source-only and excludes attachments, keys, production data and generated files',async()=>{
 const lines=(await read('.dockerignore')).split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));assert.equal(lines[0],'**');const allowed=path=>lines.slice(1).some(l=>l.startsWith('!')&&(l.endsWith('/**')?path.startsWith(l.slice(1,-2)):path===l.slice(1)));
 for(const path of ['scripts/prepare-media-storage.mjs','web/src/main.js','web/public/brand/orbit-icon.svg','server/app.js','package.json','pnpm-lock.yaml','Dockerfile'])assert(allowed(path),path);
 for(const path of ['.git/config','.env','.local/signing.properties','.codex-remote-attachments/file.mp4','data/mirea.sqlite','releases/package.apk','android/keystore.p12','certificate.key','dist/index.html'])assert(!allowed(path),path);
 const docker=await read('Dockerfile');for(const v of ['USER 1000:1000','server/healthcheck.mjs','fonts-noto-cjk ffmpeg','org.opencontainers.image.revision','mkdir -p /data /media'])assert(docker.includes(v));assert(!docker.includes('COPY . '));assert(docker.includes('org.opencontainers.image.licenses="Apache-2.0"'));assert((await read('LICENSE')).includes('Apache License'));
});
test('release and TrueNAS configurations pin image, isolate data and avoid privileged updates',async()=>{
 for(const path of ['compose.release.yaml','deploy/truenas/compose.yaml']){const yaml=await read(path);for(const v of ['ghcr.io/suiren-kazutohashimoto/mirea:0.14.0beta','user: "1000:1000"','read_only: true','no-new-privileges:true','cap_drop:','stop_grace_period: 2m','DATA_DIR: /data','host_ip:'])assert(yaml.includes(v),path+' '+v);assert(!yaml.includes('privileged: true'));assert(!yaml.includes('docker.sock'));assert(!yaml.includes(':latest'));}
 const nas=await read('deploy/truenas/compose.yaml');for(const v of ['create_host_path: false','host_ip: 127.0.0.1','mem_limit: 4g','pids_limit: 256','published: "13000"'])assert(nas.includes(v));
 const ci=await read('.github/workflows/verify.yml');for(const v of ['needs: [web-and-api, container, android]','scripts/check-container.mjs prepare','scripts/check-container.mjs verify','--force-recreate','packages: write'])assert(ci.includes(v));
});
test('health probe is local-only, version checked, bounded and does not bypass TLS or follow redirects',async t=>{
 let code=200,body={status:'ok',version:pkg.version};const server=http.createServer((req,res)=>{assert.equal(req.url,'/api/health');res.writeHead(code,{'content-type':'application/json',location:'http://evil.test/'});res.end(JSON.stringify(body));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const env={PORT:String(server.address().port)};
 assert.equal((await checkHealth(env)).version,pkg.version);body={...body,version:'other'};await assert.rejects(()=>checkHealth(env));body={status:'ok',version:pkg.version};code=302;await assert.rejects(()=>checkHealth(env));for(const value of ['0','-1','65536','bad'])await assert.rejects(()=>checkHealth({PORT:value}));await assert.rejects(()=>checkHealth({...env,HTTPS_KEY_FILE:'key'}));await assert.rejects(()=>checkHealth({...env,HTTPS_KEY_FILE:'key',HTTPS_CERT_FILE:'cert'}));
 const source=await read('server/healthcheck.mjs');assert(source.includes('rejectUnauthorized:true'));assert(!source.includes('rejectUnauthorized:false'));assert(!source.includes('NODE_TLS_REJECT_UNAUTHORIZED'));
});
