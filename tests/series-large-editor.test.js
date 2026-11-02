import test from 'node:test';
import assert from 'node:assert/strict';
import {appendSeriesAssets} from '../web/src/series-ui.js';
test('series editor supports cumulative additions beyond a single upload batch and rejects only the catalog bound',()=>{
 const entries=Array.from({length:1000},(_,i)=>({assetId:String(i),label:''})),assets=new Map([['999',{}],['1000',{}]]);const next=appendSeriesAssets(entries,['999','1000','1000'],assets);assert.equal(next.length,1001);assert.equal(entries.length,1000);
 const full=Array.from({length:100000},(_,i)=>({assetId:String(i),label:''}));assert.throws(()=>appendSeriesAssets(full,['new'],new Map([['new',{}]])),/100,000/);
});
