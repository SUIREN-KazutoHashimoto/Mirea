import test from 'node:test';
import assert from 'node:assert/strict';
import {trackTransfer,transferRows,stopTransfers} from '../web/src/transfer-manager.js';
import {runBulkDownloads} from '../web/src/bulk-downloads.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('transfer lifetime does not depend on any menu, and explicit stop reaches active work',async()=>{
 const d=deferred();let cancel=0;const row=trackTransfer({direction:'download',title:'Encrypted fixture',cancel:()=>{cancel++;d.reject(new DOMException('paused','AbortError'));},work:update=>{update({percent:42,message:'working'});return d.promise;}});
 await Promise.resolve();assert.equal(row.percent,42);assert(transferRows().includes(row));stopTransfers();await assert.rejects(row.promise,{name:'AbortError'});assert.equal(cancel,1);assert.equal(row.state,'paused');
 const finished=trackTransfer({direction:'upload',title:'complete',work:()=>Promise.resolve('done')});assert.equal(await finished.promise,'done');assert.equal(finished.state,'complete');assert.equal(finished.percent,100);
});
test('native bulk queues all non-downloaded assets before awaiting completion, with no series duplicates',async()=>{
 const pending=[],started=[];const done=runBulkDownloads([{id:'a'},{id:'b'},{id:'a'},{id:'c',pending:true},{id:'saved'}],{list:async()=>[{assetId:'saved',state:'ready'}],eager:true,download:async item=>{started.push(item.id);const d=deferred();pending.push(d);return d.promise;}});
 await Promise.resolve();assert.deepEqual(started,['a','b']);pending.forEach(d=>d.resolve());const result=await done;assert.equal(result.total,3);assert.equal(result.completed,2);assert.equal(result.skipped,1);
});
