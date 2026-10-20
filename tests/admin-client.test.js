import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createExportWriter} from '../web/src/file-export-core.js';
import {partitionJobs,jobStateClass} from '../web/src/job-presentation.js';

test('current jobs and immutable history are separated, with semantic success/failure styling',()=>{
  const states=['queued','running','processing','uploading','complete','failed','cancelled'];
  const split=partitionJobs(states.map(state=>({state})));assert.deepEqual(split.current.map(r=>r.state),states.slice(0,4));assert.deepEqual(split.history.map(r=>r.state),states.slice(4));assert.equal(jobStateClass('complete'),'job-complete');assert.equal(jobStateClass('failed'),'job-failed');assert.notEqual(jobStateClass('complete'),jobStateClass('failed'));
});

test('native exports preserve exact bytes in bounded 256KiB bridge chunks, close once and refuse writes after completion',async()=>{
  const source=randomBytes(1024*1024+79),chunks=[];let finished=0;
  const plugin={async begin(value){assert.equal(value.size,source.length);return {handle:'isolated-test-handle'};},async append({handle,data}){assert.equal(handle,'isolated-test-handle');const chunk=Buffer.from(data,'base64');assert(chunk.length<=256*1024);chunks.push(chunk);},async finish(){finished++;},async abort(){throw Error('Unexpected abort');}};
  const writer=await createExportWriter(plugin,'mirea.ndjson','application/x-ndjson',source.length);await writer.write(source);await writer.close();await writer.close();assert.equal(finished,1);assert.deepEqual(Buffer.concat(chunks),source);await assert.rejects(writer.write(source));
});
test('native export cancellation is idempotent and rejects further writes; selection failures never start a transfer',async()=>{
  let aborted=0;const plugin={async begin(){return {handle:'one'};},async append(){throw Error('Unexpected transfer');},async finish(){throw Error('Unexpected finish');},async abort({handle}){assert.equal(handle,'one');aborted++;}};
  const writer=await createExportWriter(plugin,'backup','application/octet-stream',100);await writer.abort();await writer.abort();assert.equal(aborted,1);await assert.rejects(writer.write(new Uint8Array(100)));
  await assert.rejects(createExportWriter({...plugin,begin:async()=>{throw Error('Picker cancelled');}},'backup','application/octet-stream',100),/cancelled/);
});
