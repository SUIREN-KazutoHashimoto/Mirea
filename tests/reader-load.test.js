import test from 'node:test';
import assert from 'node:assert/strict';
import {createReaderLoad} from '../web/src/reader-load.js';
test('initial reader failures expose a repeatable retry without overlapping requests',async()=>{
  let attempts=0,starts=0,error,release;
  const loader=createReaderLoad({onStart(){starts++;},onError(value){error=value;},async load(){attempts++;if(attempts<3)throw Error('network unavailable');await new Promise(resolve=>release=resolve);}});
  await loader.run();assert.equal(attempts,1);assert.equal(typeof error.retry,'function');await error.retry();assert.equal(attempts,2);
  const request=error.retry();await Promise.resolve();assert.equal(loader.run(),request);assert.equal(attempts,3);release();await request;assert.equal(starts,3);loader.dispose();await loader.run();assert.equal(attempts,3);
});
test('closed readers suppress a late failure and cannot be reopened by an old retry',async()=>{
  let reject,errors=0;const loader=createReaderLoad({onError(){errors++;},load:()=>new Promise((_,fail)=>reject=fail)});
  const request=loader.run();await Promise.resolve();loader.dispose();reject(Error('late'));await request;assert.equal(errors,0);await loader.run();assert.equal(errors,0);
});
