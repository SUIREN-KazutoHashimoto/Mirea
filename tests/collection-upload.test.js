import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionEntries} from '../web/src/library-collection.js';
import {planUploads,validateUploadPlan,createUploadBatch} from '../web/src/upload-batch.js';
const asset=(id,seriesId,position,kind='pdf')=>({id,title:id,kind,createdAt:position,shelfName:'本棚',...(seriesId?{series:{id:seriesId,title:'同じ名前',position}}:{})});
const config={maxUploadBytes:1000,maxBookPages:3,maxImageBytes:100,maxEpubBytes:100};
const file=(name,size=10,type='',at=1)=>new File(['x'.repeat(size)],name,{type,lastModified:at});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('series collapse by ID, retain canonical cover/count/progress and do not mutate or merge equal titles across shelves',()=>{
 const all=[asset('later','s1',2,'video'),asset('first','s1',1),asset('other','s2',3),asset('standalone',null,4),{...asset('pending','s1',5),pending:true}];all[1].progress={completed:true};
 const before=JSON.stringify(all),rows=collectionEntries(all,[{id:'s1',title:'同じ名前',coverId:'first'},{id:'s2',title:'同じ名前'}],{allItems:all});
 assert.equal(rows.length,4);assert.equal(rows.filter(r=>r.type==='series').length,2);const first=rows.find(r=>r.id==='s1');assert.equal(first.assetCount,2);assert.equal(first.cover.id,'first');assert.equal(first.completed,1);assert.equal(JSON.stringify(all),before);
 const video=collectionEntries([all[0]],[],{allItems:all,filter:'video'});assert.equal(video.length,1);assert.equal(video[0].matchedCount,1);assert.equal(video[0].assetCount,2);assert.equal(video[0].cover.id,'first');
 assert.deepEqual(collectionEntries([all[1],all[0]],[],{group:false}).map(r=>r.item.id),['first','later']);
});
test('empty authorized series remain manageable, obey search/type filters and never manufacture unavailable assets',()=>{
 const series=[{id:'empty',title:'空のシリーズ',role:'owner',createdAt:10,shelfName:'棚'}];const rows=collectionEntries([],series);assert.equal(rows.length,1);assert.equal(rows[0].assetCount,0);assert.equal(rows[0].cover,undefined);assert.equal(rows[0].role,'owner');
 assert.equal(collectionEntries([],series,{filter:'video'}).length,0);assert.equal(collectionEntries([],series,{search:'別'}).length,0);assert.equal(collectionEntries([],series,{search:'シリーズ'}).length,1);
 assert.equal(collectionEntries([asset('only','s',1)],[],{allItems:[asset('only','s',1)]})[0].assetCount,1);
});
test('mixed selections create one job per document/media and a numerically ordered image book with independent titles',()=>{
 const jobs=planUploads([file('b.PDF'),file('10.png'),file('a.mp3'),file('2.jpg'),file('movie.mkv'),file('podcast.webm',10,'audio/webm')]);
 assert.equal(jobs.length,5);assert.deepEqual(jobs[1].files.map(f=>f.name),['2.jpg','10.png']);assert.equal(jobs[1].imageBook,true);assert.equal(jobs[0].files[0].type,'application/pdf');assert.equal(jobs.at(-1).files[0].type,'audio/webm');assert.equal(jobs[4].title,'podcast');assert.equal(new Set(jobs.map(j=>j.key)).size,jobs.length);assert.equal(validateUploadPlan(jobs,config),'');
 const big=planUploads([file('a.mp4',800),file('b.mp4',800)]);assert.equal(validateUploadPlan(big,config),'','size cap applies per asset, not entire batch');
});
test('batch validation bounds per-asset sizes/pages/titles, rejects unsupported/empty/duplicate files before starting any request',()=>{
 for(const files of [[file('a.svg')],[file('empty.pdf',0)],[file('huge.pdf',1001)],[file('a.png',101)],[file('x.epub',101)],[file('1.png'),file('2.png'),file('3.png'),file('4.png')],[file('a.pdf'),file('a.pdf')]])assert(validateUploadPlan(planUploads(files),config),files.map(f=>f.name).join(','));
 const jobs=planUploads([file('a.pdf')]);jobs[0].title=' ';assert.match(validateUploadPlan(jobs,config),/タイトル/);assert(validateUploadPlan([],config));assert(validateUploadPlan(Array.from({length:101},(_,i)=>({...jobs[0],title:String(i)})),config));
});
test('legacy task fallback obeys configured three slots, advances on completion and isolates failures',async()=>{
 const jobs=planUploads(Array.from({length:6},(_,i)=>file(i+'.pdf'))),started=[],pending=[],changes=[];let current=0,max=0;
 const batch=createUploadBatch(jobs,{concurrency:3,changed:rows=>changes.push(rows),start:(job,onProgress)=>{const d=deferred();pending.push(d);started.push(job.key);max=Math.max(max,++current);onProgress(100,{stage:'thumbnail'});return {promise:d.promise.finally(()=>current--)};}});
 await tick();assert.equal(started.length,3);assert.equal(max,3);assert(changes.at(-1).slice(0,3).every(r=>r.state==='processing'));
 pending[0].resolve({item:{}});await tick();assert.equal(started.length,4);pending[1].reject(Error('fixture failure'));await tick();assert.equal(started.length,5);pending[2].resolve();await tick();assert.equal(started.length,6);pending.slice(3).forEach(d=>d.resolve());const result=await batch.promise;assert.equal(max,3);assert.equal(result.rows.filter(r=>r.state==='complete').length,5);assert.equal(result.rows[1].state,'failed');assert.match(result.rows[1].error,/fixture/);
 const retries=[];await createUploadBatch(result.rows.filter(r=>r.state!=='complete').map(r=>r.job),{start:job=>{retries.push(job.key);return {promise:Promise.resolve()};}}).promise;assert.deepEqual(retries,[jobs[1].key]);
});
test('explicit cancellation aborts processing too, identity changes stop starts, and a failed batch admission does not discard later queued assets',async()=>{
 const jobs=planUploads(Array.from({length:5},(_,i)=>file(i+'.pdf'))),pending=[],actions=[];
 const batch=createUploadBatch(jobs,{start:job=>{const d=deferred();pending.push(d);const processing=pending.length===1;return {processing,promise:d.promise,detach(){actions.push('detach');d.reject(Error('detached'));},abort(){actions.push('abort');d.reject(Error('aborted'));}};}});
 await tick();batch.cancel();const result=await batch.promise;assert.deepEqual(actions,['abort','abort','abort']);assert.equal(pending.length,3);assert.equal(result.cancelled,true);assert.equal(result.rows[0].state,'cancelled');assert.equal(result.rows[3].state,'queued');
 let started=0;const full=await createUploadBatch(jobs,{concurrency:1,start:()=>{started++;return {promise:Promise.reject(Object.assign(Error('busy'),{status:429}))};}}).promise;assert.equal(started,5);assert.equal(full.halted,false);assert(full.rows.every(row=>row.state==='failed'));
 let valid=true;const late=await createUploadBatch(jobs,{isCurrent:()=>valid,changed:rows=>{if(rows[0].state==='uploading')valid=false;},start:()=>assert.fail('changed account must never start')}).promise;assert.equal(late.cancelled,true);
});
test('UI groups only display entries while retaining real assets for downloads, and freezes successful uploads on retry',async()=>{
 const main=await readFile(new URL('../web/src/main.js',import.meta.url),'utf8'),ui=await readFile(new URL('../web/src/upload-ui.js',import.meta.url),'utf8');assert(main.includes('collectionEntries(selected,series'));assert(main.includes('displayedItems=selected'));assert(main.includes('data-open-series'));assert(main.includes('seriesReturnView'));
 assert(ui.includes("results.get(job.key)?.state!=='complete'"));assert(ui.includes('eager:nativeTransfersAvailable(),isCurrent'));assert(ui.includes('activeBatch?.cancel()'));assert(ui.includes('retainOriginal:requested.retainOriginal'));assert(ui.includes('maxUploadBytes'));assert(ui.includes('data-page-up'));
});
