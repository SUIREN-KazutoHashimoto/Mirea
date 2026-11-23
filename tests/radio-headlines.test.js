import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {eligibleRadioHeadlines as read,createRadioBulletin} from '../server/radio-headlines.js';

const date='2026-11-23', at=Date.parse(date+'T18:00:00+09:00');
const domain='bulletin.example.test', opts={approvedSourceHosts:[domain]};
const base={sourceName:'検証用機関',sourceUrl:'https://'+domain+'/2026/example',
  publishedAt:date+'T08:00:00+09:00',expiresAt:'2026-11-24T00:00:00+09:00',
  summaryJa:'これは実在しない試験用のニュースです。',editorialStatus:'verified-paraphrase'};
const json=(items=[base],over={})=>JSON.stringify({version:1,dateJst:date,items,...over});
const get=(raw=json(),now=at,prev=[],extra={})=>read(raw,now,prev,{...opts,...extra});
test('offline curated source, clear provenance and strict bounds',()=>{
  const [n]=get(new TextEncoder().encode(json()));
  assert.equal(n.text,base.summaryJa);
  assert.equal(n.sourceUrl,base.sourceUrl);
  assert.equal(n.dateJst,date);
  assert.equal(n.expiresMs,Date.parse(base.expiresAt));
  assert.match(n.id,/^[0-9a-f]{32}$/);
  assert.deepEqual(read(json(),at),[]); // operator allowlist or official defaults required
});
test('real boundary: expiration exclusive, cross-midnight fallback, future publication rejected',()=>{
  const end=Date.parse(base.expiresAt);
  assert.equal(get(json(),end-1).length,1);
  assert.equal(get(json(),at,[],{latestAirEndMs:end-1}).length,1);
  assert.deepEqual(get(json(),at,[],{latestAirEndMs:end}),[]);
  assert.deepEqual(get(json(),end),[]);
  assert.deepEqual(get(json(),Date.parse(base.publishedAt)-1),[]);
  assert.deepEqual(get(json([{...base,expiresAt:date+'T18:00:00+09:00'}])),[]);
});
test('reject yesterday source, invalid civil timestamp, and expiry beyond date',()=>{
  for (const x of [
    {...base,publishedAt:'2026-11-22T23:59:50+09:00'},
    {...base,publishedAt:date+'T24:00:00+09:00'},
    {...base,publishedAt:'2026-11-31T08:00:00+09:00'},
    {...base,expiresAt:'2026-11-24T00:00:01+09:00'},
    {...base,editorialStatus:'unreviewed'},
  ])assert.deepEqual(get(json([x])),[]);
});
test('duplicates and replay after source metadata edits',()=>{
  const [first]=get();
  const second={...base,summaryJa:'編集後の試験用情報です。'};
  assert.equal(get(json([base,second])).length,1);
  assert.equal(get(json([base,{...base,sourceUrl:'https://'+domain+'/different'}])).length,1);
  assert.deepEqual(get(json([second]),at,[first.id]),[]);
  assert.deepEqual(get(json(),at,['malformed']),[]);
});
test('unapproved URL, credential, tracking query, terminal controls, and overlong voice input rejected',()=>{
  for (const sourceUrl of [
    'http://'+domain+'/x','https://bad.example.test/x','https://'+domain+'.evil.test/x',
    'https://secret@'+domain+'/x','https://'+domain+'/x?token=opaque','https://'+domain+'/x#token',
    'https://'+domain+'/%0a','https://'+domain+':9443/x',
  ])assert.deepEqual(get(json([{...base,sourceUrl}])),[]);
  for(const summaryJa of ['あ'.repeat(56),'日本語\u202e危険','日本語<script>','日本語 https://example.test','English only'])
    assert.deepEqual(get(json([{...base,summaryJa}])),[]);
});
test('empty, oversized, bad utf8, mismatched version/date or invalid options safely produce no news',()=>{
  for (const x of ['', 'x', ' '.repeat(17*1024),new Uint8Array([0xff]),json([]),
    json(Array(9).fill(base)),json([base],{version:2}),json([base],{dateJst:'2026-11-22'}),
  ])assert.deepEqual(get(x),[]);
  assert.deepEqual(get(json(),at,[],{latestAirEndMs:at-1}),[]);
  assert.deepEqual(get(json(),at,[],{approvedSourceHosts:'invalid'}),[]);
  const many=Array.from({length:8},(_,i)=>({...base,summaryJa:'試験用情報その'+i,sourceUrl:'https://'+domain+'/'+i}));
  assert.equal(get(json(many)).length,4);
});

test('configured local file supplies only spoken source and short text, and fails closed',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'mirea-bulletin-fixture-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const file=join(folder,'manual.json'), local=createRadioBulletin(file);
  const slot={scheduledAt:at,until:at+20000,previousIds:[]};
  assert.equal(await local(slot),null);
  await writeFile(file,json([{...base,sourceUrl:'https://www.jma.go.jp/example-fixture-not-a-real-bulletin'}]));
  const result=await local(slot);
  assert.match(result.id,/^[a-f0-9]{32}$/);
  assert.equal(result.speech,'短いニュースです。'+base.sourceName+'によると、'+base.summaryJa);
  assert.equal(await local({...slot,previousIds:[result.id]}),null);
  await writeFile(file,Buffer.alloc(16*1024+1));
  assert.equal(await local(slot),null);
});
