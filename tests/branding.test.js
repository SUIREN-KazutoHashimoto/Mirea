import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {SaxesParser} from 'saxes';
import {brandMarkup,BRAND_ASSETS} from '../web/src/brand.js';
import {validShellManifest} from '../web/src/offline-shell.js';

const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
test('adopted orbit brand has matching light/dark geometry, accessible lockups and allowlisted offline assets',async()=>{
  const markup=brandMarkup();assert(markup.includes('Mirea'));assert(!markup.includes('brand-mark">m'));assert.equal((markup.match(/alt=""/g)||[]).length,2);
  const [light,dark,icon,head,main,style]=await Promise.all([read('web/public'+BRAND_ASSETS.mark),read('web/public'+BRAND_ASSETS.inverse),read('web/public'+BRAND_ASSETS.icon),read('web/index.html'),read('web/src/main.js'),read('web/src/brand.css')]);
  const paths=svg=>[...svg.matchAll(/ d="([^"]+)"/g)].map(match=>match[1]);assert.deepEqual(paths(light),paths(dark));assert.deepEqual(paths(light),paths(icon));assert.equal(paths(light).length,2);
  for(const svg of [light,dark,icon]){new SaxesParser({xmlns:true}).write(svg).close();assert(!/script|foreignObject|href=|url\(/i.test(svg));}
  assert(head.includes('href="'+BRAND_ASSETS.icon+'"'));assert(main.includes('brandMarkup()'));assert(!main.includes('<span class="brand-mark">m</span>'));
  assert(style.includes('[data-theme="dark"]'));assert(style.includes('max-width:760px'));assert(style.includes('object-fit:contain'));
  for(const path of Object.values(BRAND_ASSETS))assert(validShellManifest({version:'a'.repeat(64),files:[path]}),path);
  for(const path of ['/brand/private.svg','/brand/orbit-icon.svg?key=bad','/brand/../secret.svg'])assert(!validShellManifest({version:'a'.repeat(64),files:[path]}));
});
test('mark/icon vectors remain legible when rasterized small and retain real transparency',async()=>{
  for(const [path,size,opaqueTile] of [[BRAND_ASSETS.mark,48,false],[BRAND_ASSETS.inverse,48,false],[BRAND_ASSETS.icon,48,true]]){
    const svg=await read('web/public'+path),{data,info}=await sharp(Buffer.from(svg)).resize(size,size,{fit:'contain',background:'#00000000'}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(info.channels,4);let visible=0,transparent=0;
    for(let n=3;n<data.length;n+=4){if(data[n]>200)visible++;if(data[n]===0)transparent++;}
    assert(visible>size*size*(opaqueTile?.6:.15));assert(transparent>0);assert.equal(data[3],0,'top-left corner must be transparent');
  }
});
test('Android launcher, splash and monochrome notification reuse the approved orbit geometry without altering security settings',async()=>{
  const root='android/app/src/main/',mark=await read('web/public/brand/orbit-mark.svg'),paths=[...mark.matchAll(/ d="([^"]+)"/g)].map(m=>m[1]);
  for(const name of ['mirea_icon','mirea_launcher','mirea_launcher_foreground','mirea_splash_icon']){
    const xml=await read(root+'res/drawable/'+name+'.xml');new SaxesParser({xmlns:true}).write(xml).close();for(const path of paths)assert(xml.includes(path),name);
    if(name==='mirea_icon'){assert(!xml.includes('#4026DF'));assert.equal((xml.match(/android:fillColor="#FFFFFF"/g)||[]).length,2);}
  }
  const manifest=await read(root+'AndroidManifest.xml'),styles=await read(root+'res/values/styles.xml');
  assert(manifest.includes('android:icon="@drawable/mirea_launcher"'));assert(manifest.includes('android:roundIcon="@drawable/mirea_launcher"'));assert(styles.includes('@drawable/mirea_splash_icon'));
  assert(manifest.includes('android:allowBackup="false"'));assert(manifest.includes('android:usesCleartextTraffic="false"'));
  for(const qualifier of ['v26','v33']){const xml=await read(root+'res/drawable-anydpi-'+qualifier+'/mirea_launcher.xml');assert(xml.includes('@drawable/mirea_launcher_foreground'));if(qualifier==='v33')assert(xml.includes('<monochrome'));}
});
