import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaBinary } from '../server/media-binary.js';
test('Linux uses the system media pair, Windows/macOS retain bundles, and explicit paths win',()=>{
  for(const name of ['ffmpeg','ffprobe']){
    assert.equal(mediaBinary(name,'bundled','linux',{}),`/usr/bin/${name}`);
    assert.equal(mediaBinary(name,'bundled','win32',{}),'bundled');assert.equal(mediaBinary(name,'bundled','darwin',{}),'bundled');
    const env={[name==='ffmpeg'?'FFMPEG_PATH':'FFPROBE_PATH']:'/custom/'+name};assert.equal(mediaBinary(name,'bundled','linux',env),'/custom/'+name);
  }
  assert.throws(()=>mediaBinary('../other','bundled','linux',{}));
});
