import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
test('late paused-player restoration cannot expose another account or autoplay',async()=>{
 const value=await promisify(execFile)(process.execPath,['--experimental-vm-modules','--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./playback-resume-fixture.mjs',import.meta.url))],{windowsHide:true,timeout:10000});assert.match(value.stdout,/preserves account isolation/);
});
