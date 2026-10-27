import test from 'node:test';
import assert from 'node:assert/strict';
import {progressPercent,displayTime} from '../web/src/management-ui.js';
import {filterJobRows} from '../web/src/job-presentation.js';
import {filterTransfers,transferSummary,clearTransferRecords,trackTransfer,transferRows} from '../web/src/transfer-manager.js';

test('untrusted progress and dates cannot produce invalid meters or exceptions',()=>{
 for(const [input,output]of [[-5,0],[300,100],[42.6,43],['51',51],[NaN,0],[Infinity,0],[undefined,0]])assert.equal(progressPercent(input),output);
 for(const value of [undefined,0,-1,NaN,Infinity,8640000000000001,'invalid'])assert.equal(displayTime(value),'—');
 assert.notEqual(displayTime(Date.now()),'—');
});
test('job filters preserve originals, group active states, and sort records deterministically',()=>{
 const rows=[{id:'b',kind:'thumbnail',title:'表紙 B',state:'queued',createdAt:100},{id:'a',kind:'transcode',title:'動画 A',state:'running',createdAt:200},{id:'c',kind:'preview',title:'動画 C',state:'complete',createdAt:300},{id:'d',kind:'processor',state:'processing',createdAt:200}];
 assert.deepEqual(filterJobRows(rows,{query:'動画'}).map(r=>r.id),['c','a']);
 assert.deepEqual(filterJobRows(rows,{state:'running'}).map(r=>r.id),['a','d']);
 assert.deepEqual(filterJobRows(rows,{sort:'oldest'}).map(r=>r.id),['b','a','d','c']);
 assert.deepEqual(rows.map(r=>r.id),['b','a','c','d']);
});
test('transfer views filter states, direction and title without discarding recoverable records',()=>{
 const rows=[{id:1,title:'PDF',direction:'download',state:'complete'},{id:2,title:'Music',direction:'upload',state:'running'},{id:3,title:'VIDEO',direction:'download',state:'paused'},{id:4,title:'Book',direction:'upload',state:'failed'}];
 assert.deepEqual(transferSummary(rows),{active:1,attention:2,complete:1,total:4});
 assert.deepEqual(filterTransfers(rows,{view:'attention'}).map(r=>r.id),[4,3]);
 assert.deepEqual(filterTransfers(rows,{direction:'download',query:'video'}).map(r=>r.id),[3]);
 assert.deepEqual(filterTransfers(rows,{view:'complete'}).map(r=>r.id),[1]);assert.equal(rows.length,4);
});
test('clearing account transfer records cannot be undone by late completion or progress',async()=>{
 let report,finish;const row=trackTransfer({direction:'upload',title:'previous account',notifications:false,work:update=>{report=update;return new Promise(resolve=>finish=resolve);}});
 await Promise.resolve();clearTransferRecords();report({percent:42});finish();await row.promise;assert.deepEqual(transferRows(),[]);
});
