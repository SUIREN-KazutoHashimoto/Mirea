import test from 'node:test';
import assert from 'node:assert/strict';
import {transferRetryDelay,abortableDelay} from '../web/src/transfer-retry.js';
import {shellResponse} from '../web/src/offline-shell.js';

test('transfers honor rate-limit waits, retry temporary failures, and stop on auth/integrity/storage errors',async()=>{
  assert.equal(transferRetryDelay({status:429,retryAfter:'90'},0),90000);
  assert.equal(transferRetryDelay({status:503,retryAfter:new Date(100000).toUTCString()},0,{now:()=>10000}),90000);
  assert.equal(transferRetryDelay(new TypeError('Failed to fetch'),10),30000);
  for(const error of [{status:401},{status:403},{status:409},{code:'DOWNLOAD_INTEGRITY_FAILED'},{name:'QuotaExceededError'},new Error('unexpected')])assert.equal(transferRetryDelay(error,0),null);
  const controller=new AbortController(),waiting=abortableDelay(300000,controller.signal);controller.abort();await assert.rejects(waiting,{name:'AbortError'});
});
test('saved PWA opens during proxy/server errors but does not hide an explicit access denial',async()=>{
  for(const status of [500,502,503,504]){
    const r=await shellResponse(new Request('https://local/'),{navigate:true,findCached:async()=>new Response('saved shell'),network:async()=>new Response('proxy failed',{status})});
    assert.equal(await r.text(),'saved shell');assert.equal(r.status,200);
  }
  const denied=await shellResponse(new Request('https://local/'),{navigate:true,findCached:async()=>new Response('saved shell'),network:async()=>new Response('denied',{status:403})});assert.equal(denied.status,403);
});
