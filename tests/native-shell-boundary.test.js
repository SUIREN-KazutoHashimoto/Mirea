import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('APK startup bypasses a legacy worker shell without deleting media, keys or browser caches',async()=>{
  const config=JSON.parse(await readFile(new URL('../capacitor.config.json',import.meta.url),'utf8'));
  const start=new URL(config.server.appStartPath,'https://localhost');
  assert.equal(start.pathname,'/index.html');assert(start.search);
  // The existing worker deliberately does not handle query-bearing page URLs.
  // This continues to work on the first launch, before a worker update activates.
  const source=(await readFile(new URL('../web/src/download-sw.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  const handlers=new Map();let claimed=false;
  const forbidden=()=>{throw Error('Startup must leave offline media and shell caches untouched');};
  vm.runInNewContext(source,{URL,Set,MessageChannel,self:{location:{origin:start.origin},addEventListener:(name,fn)=>handlers.set(name,fn)},DOWNLOAD_PATH:'/__mirea_download__/',shellResponse:forbidden,openDownloadDb:forbidden,caches:new Proxy({},{get:forbidden})});
  handlers.get('fetch')({request:{url:start.href,method:'GET',mode:'navigate'},respondWith:()=>{claimed=true;}});
  assert.equal(claimed,false);
});
