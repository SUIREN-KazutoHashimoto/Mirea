// Run on stdin in the read-only, non-root release container with its real 64MiB
// /tmp. Only use generated fixtures in a unique directory; never inspect DBs.
import {mkdtemp,rm,readFile,statfs,writeFile,readdir} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const {createMediaProcessor}=await import(pathToFileURL(join(process.cwd(),'server/media.js')));
sharp.cache(false);sharp.concurrency(1);
const directory=await mkdtemp('/data/mirea-image-integrity-check-'),source=join(directory,'generated.jpg'),media=createMediaProcessor();
const used=async()=>{const s=await statfs(tmpdir());return (s.blocks-s.bfree)*s.bsize;};
const hash=async()=>createHash('sha256').update(await readFile(source)).digest('hex');
try {
 assert.equal(process.platform,'linux');
 const initial=await used(),width=5197,height=7252;
 // The reported dimensions decode to >100MiB despite a much smaller JPEG.
 // Generate scanlines with texture, keeping the fixture independent of users.
 let raw=Buffer.allocUnsafe(width*height*3);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=(y*width+x)*3;raw[i]=(x+y)%256;raw[i+1]=(x*3+y*7)%256;raw[i+2]=(x*11+y*5)%256;
 }
 await sharp(raw,{raw:{width,height,channels:3}}).jpeg({quality:80,progressive:true}).toFile(source);raw=null;
 const original=await hash();
 // Prove the former code really fails on this bounded scratch filesystem.
 const old=`import sharp from 'sharp';sharp.cache(false);try{await sharp(process.argv[1],{limitInputPixels:false,failOn:'warning'}).stats();throw Error('Old path unexpectedly passed');}catch(e){if(!/no space left on device/i.test(e.message))throw e;console.log('oldStatsENOSPC');}`;
 const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',old,source],{timeout:30000,maxBuffer:16384});
 assert.match(result.stdout,/oldStatsENOSPC/);
 for(let page=1;page<=106;page++){
  const info=await media.validateImage(source);assert.equal(info.width,width);assert.equal(info.height,height);
  assert((await used())-initial<8*1024*1024,'pixel validation must not accumulate decoded scratch files');
 }
 assert.equal(await hash(),original);
 const complete=await readFile(source),broken=join(directory,'missing-pixels.jpg');
 await writeFile(broken,Buffer.concat([complete.subarray(0,Math.floor(complete.length*.8)),Buffer.from([0xff,0xd9])]));
 await assert.rejects(media.validateImage(broken),e=>e.statusCode===422);
 const before=await readdir(directory),cover=join(directory,'cover.jpg');
 await media.thumbnail(source,'image/jpeg',cover);
 assert.equal((await sharp(cover).metadata()).width,734);
 assert.equal(await hash(),original);
 assert.deepEqual((await readdir(directory)).sort(),[...before,'cover.jpg'].sort());
 console.log(JSON.stringify({success:true,pages:106,oldStatsENOSPC:true,fullDecode:true,originalUnchanged:true,noScratchAccumulation:true,corruptPixelsRejected:true}));
}finally{
 if(dirnameCheck(directory))await rm(directory,{recursive:true,force:true});else throw Error('Unsafe synthetic fixture cleanup');
}
function dirnameCheck(path){return resolve(path).startsWith(resolve('/data')+sep+'mirea-image-integrity-check-')&&resolve(path).split(sep).length===resolve('/data').split(sep).length+1;}
