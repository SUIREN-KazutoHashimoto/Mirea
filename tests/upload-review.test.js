import test from 'node:test';
import assert from 'node:assert/strict';
import {applyUploadReview,uploadReviewRequest} from '../web/src/upload-review.js';

test('review names for a new series remain one hierarchy component even when a title contains slashes',()=>{
  const body=uploadReviewRequest([{key:'a',title:' A ',folderPath:'Folder/Child'}],{shelf:'s',choice:'new',title:'2025/2026',parentId:'parent'},{folderMode:true});
  assert.deepEqual(body.assets,[{key:'a',title:'A',shelfId:'s',seriesId:'parent',newSeriesTitle:'2025/2026',folderPath:'Folder/Child'}]);
  assert.throws(()=>uploadReviewRequest([{key:'a',title:'A'}],{shelf:'s',choice:'new',title:'2025/2026',parentId:'parent'},{seriesRows:[{id:'existing',title:'2025/2026',parentId:'parent'}]}),/既存のシリーズ/);
});
test('ambiguous destinations cannot be renamed into and selection decisions never mutate source jobs',()=>{
  const jobs=[{key:'a',title:'A'},{key:'b',title:'B'}],rows=[{key:'a',conflict:true,reason:'ambiguous-series',suggestedTitle:null},{key:'b',conflict:false}];
  const result=applyUploadReview(jobs,rows);assert.deepEqual(result.selected,[jobs[1]]);assert.deepEqual(result.skipped,[jobs[0]]);assert.deepEqual(jobs,[{key:'a',title:'A'},{key:'b',title:'B'}]);
  assert.throws(()=>applyUploadReview(jobs,rows,new Map([['a','rename']])),/同名シリーズ/);assert.throws(()=>applyUploadReview(jobs,rows.slice(0,1)),/もう一度/);
});
