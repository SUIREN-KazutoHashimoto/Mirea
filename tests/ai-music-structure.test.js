import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeMusicStructure,shortOpeningHint} from '../server/ai-music-structure.js';
import {aiHash,validateAiResult} from '../server/ai-validation.js';

const r=(start,end,label)=>({start,end,label});

test('timing is bounded, deterministic and locally salvages valid sections before validation',()=>{
  const segments=[r(15,32,'chorus'),r(7.5,15.5,'verse'),r(-.2,7.5,'intro'),r(31,32,'outro'),
    r(-9,-.2,'intro'),r(14,14.0001,'break'),r(NaN,20,'solo'),r(19,20,'not-a-model-label')];
  const normalized=normalizeMusicStructure({segments,bpm:120.2},30_000);
  assert.deepEqual(normalized.segments.map(({startMs,endMs,kind})=>[startMs,endMs,kind]),
    [[0,7500,'intro'],[7500,15500,'verse'],[15500,30000,'chorus']]);
  assert.equal(normalized.summary,'テンポの目安: 120 BPM');
  assert.deepEqual(normalizeMusicStructure({segments:[...segments].reverse(),bpm:120.2},30_000),normalized);
  assert.equal(validateAiResult('structure',normalized,{durationMs:30_000}).segments.length,3);
});

test('unambiguous original edit IDs are retained; rounded IDs never collide on valid short spans',()=>{
  const input=[r(0,2,'intro'),r(2.01,2.12,'verse'),r(2.15,2.31,'chorus'),r(2.36,2.46,'verse')];
  const {segments}=normalizeMusicStructure({segments:input},3000);
  assert.equal(segments.length,4);
  assert.equal(segments[0].id,'music:'+aiHash({start:0,label:'intro'}).slice(0,20));
  assert.match(segments[1].id,/^music:v2:/);assert.match(segments[3].id,/^music:v2:/);
  assert.equal(new Set(segments.map(s=>s.id)).size,segments.length);
});

test('adjacent same label rejoins small jitter without erasing actual gaps or inventing choice on ambiguous start',()=>{
  const input=[r(0,1,'intro'),r(1.08,2,'intro'),r(3,4,'verse'),r(3,5,'chorus'),r(6,9,'outro')];
  assert.deepEqual(normalizeMusicStructure({segments:input,bpm:999},10_000).segments.map(s=>[s.startMs,s.endMs,s.kind]),
    [[0,2000,'intro'],[6000,9000,'outro']]);
  assert.equal(normalizeMusicStructure({segments:input,bpm:999},10_000).summary,'');
  assert.deepEqual(normalizeMusicStructure({segments:Array.from({length:2001},()=>input[0])},10_000).segments,[]);
});

test('only an intact opening followed by a useful, contiguous section supplies a short pacing hint',()=>{
  const pair=(end=7500,next=end,kind='intro')=>[{startMs:0,endMs:end,kind},{startMs:next,endMs:28000,kind:'verse'}];
  assert.equal(shortOpeningHint(pair(),30_000),'short');
  assert.equal(shortOpeningHint(pair(8999),30_000),'short');
  for(const suspect of [pair(9000),pair(400),pair(7500,7250),pair(7500,8000),pair(7500,7500,'inst'),
    [pair()[0]], [{...pair()[0],startMs:251},pair()[1]], [...pair(),{startMs:29000,endMs:30001,kind:'end'}],
    [pair()[0],{...pair()[1],kind:'end'}]])assert.equal(shortOpeningHint(suspect,30_000),null);
});
