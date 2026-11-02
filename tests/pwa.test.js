import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,mkdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {buildPwaIcons} from '../scripts/pwa-icons.mjs';
import {createPwaInstall,installPresentation} from '../web/src/pwa-install.js';
import {validShellManifest,shellResponse} from '../web/src/offline-shell.js';
import {createApp} from '../server/app.js';
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
function browser({secure=true,standalone=false,online=true}={}){const win=new EventTarget(),display=new EventTarget();display.matches=standalone;win.matchMedia=()=>display;win.navigator={serviceWorker:{},onLine:online};win.isSecureContext=secure;return {win,display};}
function offer(win,prompt){const event=new Event('beforeinstallprompt',{cancelable:true});event.prompt=prompt;win.dispatchEvent(event);return event;}
test('manifest has stable origin-local identity, standalone launch, approved icons and exact offline allowlist',async()=>{
 const manifest=JSON.parse(await read('web/public/manifest.webmanifest'));assert.equal(manifest.id,'/');assert.equal(manifest.start_url,'/');assert.equal(manifest.scope,'/');assert.equal(manifest.display,'standalone');assert.equal(manifest.orientation,'any');assert.equal(manifest.prefer_related_applications,false);assert.equal(manifest.short_name,'Mirea');
 for(const size of [192,512])assert(manifest.icons.some(i=>i.sizes===`${size}x${size}`&&i.purpose==='any'&&i.type==='image/png'));assert(manifest.icons.some(i=>i.purpose==='maskable'&&i.sizes==='512x512'));
 for(const file of ['/manifest.webmanifest','/pwa/apple-touch-icon.png',...manifest.icons.map(i=>i.src)])assert(validShellManifest({version:'a'.repeat(64),files:[file]}),file);
 for(const file of ['/pwa/private.png','/pwa/../secret','/pwa/icon-512.png?token=abc','/manifest.webmanifest?user=abc','/api/v1/auth/remember'])assert(!validShellManifest({version:'a'.repeat(64),files:[file]}),file);
 const head=await read('web/index.html');assert(head.includes('rel="manifest" href="/manifest.webmanifest"'));assert(head.includes('rel="apple-touch-icon"'));const sw=await read('web/src/download-sw.js');assert(sw.includes("url.pathname==='/manifest.webmanifest'"));assert(sw.includes("url.pathname.startsWith('/api/')"));assert(sw.includes('encryptedRangeResponse'));
});
test('approved vector builds correct PNG sizes, transparent regular icons and opaque maskable/apple tiles',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'mirea-pwa-icons-'));t.after(()=>rm(folder,{recursive:true,force:true}));await buildPwaIcons({destination:folder});
 for(const [file,size,opaque]of [['icon-192.png',192,false],['icon-512.png',512,false],['maskable-512.png',512,true],['apple-touch-icon.png',180,true]]){const {data,info}=await sharp(join(folder,file)).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(info.width,size);assert.equal(info.height,size);assert.equal(data[3],opaque?255:0);let visible=0;for(let n=0;n<data.length;n+=4)if(data[n]>150&&data[n+1]>150&&data[n+2]>150)visible++;assert(visible>size*size*.06,'white mark must remain visible');if(opaque)for(let n=3;n<data.length;n+=4)assert.equal(data[n],255);}
});
test('install is user-triggered, single-use and single-flight; cancel/error do not cause automatic prompts',async()=>{
 const {win,display}=browser();let calls=0,resolve;const controller=createPwaInstall({win});let latest;const unsubscribe=controller.subscribe(s=>latest=s);
 const event=offer(win,()=>{calls++;return new Promise(r=>resolve=r);});assert(event.defaultPrevented);assert(latest.available);assert.equal(calls,0);
 const request=controller.install();assert.equal(calls,1);assert(latest.pending);assert.equal((await controller.install()).outcome,'busy');resolve({outcome:'dismissed'});assert.equal((await request).outcome,'dismissed');assert.equal((await controller.install()).outcome,'manual');assert.equal(calls,1);assert(installPresentation(latest).message.includes('キャンセル'));
 offer(win,()=>{throw Error('Denied');});assert.equal((await controller.install()).outcome,'failed');assert(!latest.available);assert.equal((await controller.install()).outcome,'manual');
 offer(win,async()=>({outcome:'accepted'}));await controller.install();assert.equal(latest.installed,false,'wait for actual browser install event');win.dispatchEvent(new Event('appinstalled'));assert(latest.installed);assert(!installPresentation(latest).button);display.matches=true;display.dispatchEvent(new Event('change'));assert.equal((await controller.install()).outcome,'installed');unsubscribe();controller.dispose();
 const later=offer(win,()=>{calls++;});assert(!later.defaultPrevented);
});
test('native/insecure/standalone browsers never get install prompts; offline preparation is non-blocking and retries after reconnect',async()=>{
 for(const [options,native]of [[{secure:false},false],[{},true],[{standalone:true},false]]){const {win}=browser(options);let prepared=0,called=0;const p=createPwaInstall({win,native,ensureWorker:()=>{prepared++;}});offer(win,()=>{called++;});await p.install();assert.equal(called,0);if(native||options.secure===false){await p.prepare();assert.equal(prepared,0);}p.dispose();}
 const {win}=browser({online:false});let attempts=0;const p=createPwaInstall({win,ensureWorker:()=>{if(++attempts===1)throw Error('TLS failure');}});await p.prepare();assert.equal(attempts,0);win.navigator.onLine=true;await p.prepare();assert.equal(attempts,1);assert.equal(p.state().notice,'offline-shell');await p.prepare();assert.equal(attempts,2);assert.equal(p.state().notice,'');p.dispose();
 const response=await shellResponse(new Request('https://mirea.test/manifest.webmanifest'),{navigate:false,online:false,findCached:async()=>new Response('saved manifest'),network:()=>{throw Error('must not connect');}});assert.equal(await response.text(),'saved manifest');
});
test('server serves manifest/icons with correct MIME, no auth requirement and existing CSP and worker scope protections',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'mirea-pwa-server-')),webRoot=join(folder,'web');await mkdir(webRoot);await buildPwaIcons({destination:join(webRoot,'pwa')});for(const [source,target]of [['web/index.html','index.html'],['web/public/manifest.webmanifest','manifest.webmanifest'],['web/src/download-sw.js','download-sw.js']])await copyFile(new URL('../'+source,import.meta.url),join(webRoot,target));const app=await createApp({dataDir:join(folder,'data'),webRoot,rateLimit:false});t.after(async()=>{await app.close();await rm(folder,{recursive:true,force:true});});
 const response=await app.inject('/manifest.webmanifest');assert.equal(response.statusCode,200);assert.match(response.headers['content-type'],/^application\/manifest\+json/);assert.equal(response.headers['cache-control'],'no-cache');assert.equal(response.json().id,'/');assert.match(response.headers['content-security-policy'],/default-src 'self'/);assert.equal((await app.inject('/pwa/icon-192.png')).headers['content-type'],'image/png');
 const worker=await app.inject('/download-sw.js');assert.equal(worker.headers['cache-control'],'no-store');assert.equal(worker.headers['service-worker-allowed'],'/');assert.equal((await app.inject('/api/v1/account')).statusCode,401);
});
