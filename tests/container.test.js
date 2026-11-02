import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {checkHealth} from '../server/healthcheck.mjs';
import pkg from '../package.json' with {type:'json'};
import {upgradeBaseline,verifyUpgradeBaseline,upgradeProjects,fixtureProject,ownedUpgradeVolume,restoredUpgradeConfig} from '../scripts/container-upgrade-policy.mjs';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');

test('published-image upgrade fixtures pin the old identity and reject existing or external volume ownership',()=>{
 const metadata={...upgradeBaseline,schemaVersion:1,platform:'linux/amd64',nonRoot:'1000:1000',testedImagePromoted:true,readOnlyRoot:true,separateStorageVerified:true,containerRecreationAndEncryptionVerified:true};
 assert.equal(verifyUpgradeBaseline(metadata),upgradeBaseline);assert.match(upgradeBaseline.digestReference,/@sha256:[a-f0-9]{64}$/);
 for(const key of ['tag','version','commit','image','digestReference'])assert.throws(()=>verifyUpgradeBaseline({...metadata,[key]:'changed'}));
 assert.throws(()=>upgradeProjects({GITHUB_ACTIONS:'false',COMPOSE_PROJECT_NAME:'mirea-ci-1-1'}));assert.throws(()=>upgradeProjects({GITHUB_ACTIONS:'true',COMPOSE_PROJECT_NAME:'production'}));
 const plans=upgradeProjects({GITHUB_ACTIONS:'true',COMPOSE_PROJECT_NAME:'mirea-ci-1-1'});assert.deepEqual(plans.map(p=>p.layout),['combined','separated']);
 for(const plan of plans){assert(fixtureProject(plan.source));assert(fixtureProject(plan.restored));}
 const project=plans[0].source,volume={Name:project+'_mirea-data',Driver:'local',Options:null,Labels:{'com.docker.compose.project':project,'com.docker.compose.volume':'mirea-data'}};
 assert.equal(ownedUpgradeVolume(volume,project,'mirea-data'),volume.Name);
 assert.throws(()=>ownedUpgradeVolume({...volume,Labels:{...volume.Labels,'com.docker.compose.project':'another'}},project,'mirea-data'));
 assert.throws(()=>ownedUpgradeVolume({...volume,Options:{type:'none',device:'/outside',o:'bind'}},project,'mirea-data'));
 assert.throws(()=>ownedUpgradeVolume(volume,'production','mirea-data'));
});
test('rollback uses saved configuration but can only remap fixture volumes and loopback ports',()=>{
 const config={name:'mirea-ci-1-1-upgrade-separated',services:{mirea:{image:upgradeBaseline.digestReference,build:{context:'.'},environment:{MEDIA_DIR:'/media',MAX_CONCURRENT_JOBS:'5'},read_only:true,volumes:[{type:'volume',source:'mirea-data',target:'/data'},{type:'volume',source:'mirea-media',target:'/media'}],ports:[{host_ip:'127.0.0.1',target:3000,published:'31302'}]}},volumes:{'mirea-data':{name:'old-data'},'mirea-media':{name:'old-media'}},networks:{default:{name:'old-default'}}};
 const restored=restoredUpgradeConfig(config,'mirea-ci-1-1-restore-separated',31304);
 assert.equal(restored.services.mirea.image,upgradeBaseline.digestReference);assert.deepEqual(restored.services.mirea.environment,config.services.mirea.environment);assert.equal(restored.services.mirea.read_only,true);assert.equal(restored.services.mirea.build,undefined);
 assert.equal(restored.volumes['mirea-media'].name,'mirea-ci-1-1-restore-separated_mirea-media');assert.equal(restored.services.mirea.ports[0].published,'31304');assert.equal(config.services.mirea.ports[0].published,'31302');
 const bind=structuredClone(config);bind.services.mirea.volumes[0].type='bind';assert.throws(()=>restoredUpgradeConfig(bind,'mirea-ci-1-1-restore-separated',31304));
 const external=structuredClone(config);external.volumes['mirea-data'].external=true;assert.throws(()=>restoredUpgradeConfig(external,'mirea-ci-1-1-restore-separated',31304));
 assert.throws(()=>restoredUpgradeConfig(config,'production',31304));
});
test('container upgrade CI covers both layouts, stopped PAX backup and existing-key verification before rollback',async()=>{
 const script=await read('scripts/check-container-upgrade.mjs'),fixture=await read('scripts/check-container.mjs'),ci=await read('.github/workflows/verify.yml');
 for(const value of ['upgradeProjects(process.env)',"fixture('prepare',env);stopped(env)","fixture('verify',next);stopped(next)","fixture('verify',restored);stopped(restored)","'--format=pax'","'--interactive'","'1000:1000'","'--network','none'",'ownedUpgradeVolume','Restore volume must be empty','compose-resolved.json','compose-restored.json'])assert(script.includes(value),value);
 assert(fixture.includes('downloadKeyHash'));assert(fixture.includes('s.downloadKeyHash'));assert(fixture.includes('HostPort===String(port)'));
 assert(ci.includes('node scripts/check-container-upgrade.mjs'));assert(ci.includes('node scripts/check-container-upgrade.mjs --cleanup'));
 assert(!script.includes("'down','-v'"));assert(!script.includes("'--privileged'"));assert(!script.includes('docker.sock'));
});
test('container context is source-only and excludes attachments, keys, production data and generated files',async()=>{
 const lines=(await read('.dockerignore')).split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));assert.equal(lines[0],'**');const allowed=path=>lines.slice(1).some(l=>l.startsWith('!')&&(l.endsWith('/**')?path.startsWith(l.slice(1,-2)):path===l.slice(1)));
 for(const path of ['container/launcher.c','scripts/prepare-media-storage.mjs','web/src/main.js','web/public/brand/orbit-icon.svg','server/app.js','package.json','pnpm-lock.yaml','Dockerfile'])assert(allowed(path),path);
 for(const path of ['.git/config','.env','.local/signing.properties','.codex-remote-attachments/file.mp4','data/mirea.sqlite','releases/package.apk','android/keystore.p12','certificate.key','dist/index.html'])assert(!allowed(path),path);
 assert(allowed('scripts/pwa-icons.mjs'));assert((await read('Dockerfile')).includes('COPY scripts/pwa-icons.mjs ./scripts/pwa-icons.mjs'));
 assert(allowed('patches/@capacitor__android@8.5.3.patch'));assert.equal((await read('Dockerfile')).match(/COPY patches \.\/patches/g)?.length,2,'both dependency install stages need the pinned package patch');
 const docker=await read('Dockerfile');for(const v of ['USER 1000:1000','server/healthcheck.mjs','fonts-noto-cjk ffmpeg','org.opencontainers.image.revision','mkdir -p /data /media'])assert(docker.includes(v));assert(!docker.includes('COPY . '));assert(docker.includes('org.opencontainers.image.licenses="Apache-2.0"'));assert((await read('LICENSE')).includes('Apache License'));
});
test('release and TrueNAS configurations pin image, isolate data and avoid privileged updates',async()=>{
 const docker=await read('Dockerfile');assert.equal(docker.match(/^ARG VERSION=(.+)$/m)?.[1].trim(),pkg.version,'Default container version label must match package.json');
 for(const path of ['compose.release.yaml','deploy/truenas/compose.yaml']){const yaml=await read(path);for(const v of ['ghcr.io/suiren-kazutohashimoto/mirea:'+pkg.version.replace('-beta','beta'),'user: "1000:1000"','read_only: true','no-new-privileges:true','cap_drop:','stop_grace_period: 2m','DATA_DIR: /data','host_ip:'])assert(yaml.includes(v),path+' '+v);assert(!yaml.includes('privileged: true'));assert(!yaml.includes('docker.sock'));assert(!yaml.includes(':latest'));}
 const nas=await read('deploy/truenas/compose.yaml');for(const v of ['create_host_path: false','host_ip: 127.0.0.1','mem_limit: 4g','pids_limit: 256','published: "13000"'])assert(nas.includes(v));
  const ci=await read('.github/workflows/verify.yml');for(const v of ['needs: [web-and-api, web-ui, container, android]','scripts/check-container.mjs prepare','scripts/check-container.mjs verify','--force-recreate','packages: write','pnpm test:ui'])assert(ci.includes(v));
 assert(ci.includes('mirea /usr/local/bin/node --input-type=module < scripts/check-storage-runtime.mjs'));
 assert(ci.includes('scripts/check-container-sandbox.mjs'));
});

test('image starts through the mandatory pre-thread sandbox and code is not runtime-owned',async()=>{
 const docker=await read('Dockerfile');assert(docker.includes('ENTRYPOINT ["/usr/local/bin/mirea-launch"]'));assert(docker.includes('/app/server/container-entry.mjs'));assert(!docker.includes('--chown=node:node'));assert(docker.includes('-Werror'));
 const launcher=await read('container/launcher.c');for(const v of ['PR_SET_NO_NEW_PRIVS','SYS_landlock_restrict_self','LANDLOCK_ACCESS_FS_TRUNCATE','LANDLOCK_ACCESS_FS_REFER','SYS_close_range','abi < 3','PR_GET_SECCOMP','execv(argv[1]'])assert(launcher.includes(v));
 assert(launcher.includes('setenv("SQLITE_TMPDIR", "/tmp", 1)'));
 assert(launcher.indexOf('setenv("SQLITE_TMPDIR"')<launcher.indexOf('SYS_landlock_restrict_self, fd'));
 assert(docker.includes('SQLITE_TMPDIR=/tmp'));
 const entry=await read('server/container-entry.mjs');assert(entry.indexOf('await preflightTrueNas()')<entry.indexOf("await import('./index.js')"));
});
test('health probe is local-only, version checked, bounded and does not bypass TLS or follow redirects',async t=>{
 let code=200,body={status:'ok',version:pkg.version};const server=http.createServer((req,res)=>{assert.equal(req.url,'/api/health');res.writeHead(code,{'content-type':'application/json',location:'http://evil.test/'});res.end(JSON.stringify(body));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const env={PORT:String(server.address().port)};
 assert.equal((await checkHealth(env)).version,pkg.version);body={...body,version:'other'};await assert.rejects(()=>checkHealth(env));body={status:'ok',version:pkg.version};code=302;await assert.rejects(()=>checkHealth(env));for(const value of ['0','-1','65536','bad'])await assert.rejects(()=>checkHealth({PORT:value}));await assert.rejects(()=>checkHealth({...env,HTTPS_KEY_FILE:'key'}));await assert.rejects(()=>checkHealth({...env,HTTPS_KEY_FILE:'key',HTTPS_CERT_FILE:'cert'}));
 const source=await read('server/healthcheck.mjs');assert(source.includes('rejectUnauthorized:true'));assert(!source.includes('rejectUnauthorized:false'));assert(!source.includes('NODE_TLS_REJECT_UNAUTHORIZED'));
});
