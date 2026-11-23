import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDynamicRadio,dynamicLimit,isMcBoundary} from '../server/radio-dynamic.js';

const station={id:'station',name:'Example walk',epoch:1000,revision:4};
const tracks=[{id:'a',title:'Alpha',durationMs:10000},{id:'b',title:'Beta',durationMs:10000},{id:'c',title:'Gamma',durationMs:10000}];
const plan={owner:'owner',revision:1,tracks};
const prefs={mc:'enhanced',jingle:'standard'};
const clip=(text,durationMs=3400)=>({durationMs,bytes:Buffer.from(text),credit:'Synthetic renderer fixture'});
const scan=()=>[{station,plan,prefs}];

test('prepares distinct audio every two tracks across odd rounds outside GET and keeps a shared cycle fixed',async()=>{
  let time=1000;
  const prepared=[];
  const radio=createDynamicRadio({scan,now:()=>time,scheduler:false,analyze:async tr=>tr.id==='b'?'short':null,
    render:async requests=>{
      prepared.push(requests);
      return new Map(requests.map(row=>[row.id,clip(row.text)]));
    }});
  try{
    assert.equal(radio.current(station,plan).audible,false);
    assert.equal(prepared.length,0,'listener does not trigger background work');
    await radio.pump();
    assert.equal(radio.current(station,plan).audible,false);
    assert.equal(prepared[0].length,2);
    assert.equal(prepared[0][0].quality,'standard');
    assert.ok(prepared[0][0].text.includes('Beta'));
    assert.ok(prepared[0][1].text.includes('Alpha'),'last track leads into next cycle');
    time=31001;
    const first=radio.current(station,plan);
    assert.equal(first.anchor,31000);
    assert.deepEqual(first.segments.map(s=>s.id),['a','link-0','b','c','link-2']);
    time+=9200;
    assert.deepEqual(radio.current(station,plan),first);
    await radio.pump();
    assert.notEqual(prepared[1][0].text,prepared[0][0].text);
    assert.deepEqual(radio.current(station,plan),first,'next render does not change an ongoing cycle');
    time=67799;
    const second=radio.current(station,plan);
    assert.equal(second.anchor,31000); // ongoing until all measured clips finish
    time=67810;
    assert.equal(radio.current(station,plan).anchor,67800);
    assert.notDeepEqual(radio.current(station,plan).signature,first.signature);
    const edit={...station,revision:5}, editedPlan={...plan,revision:2,tracks:[tracks[1]]};
    assert.equal(radio.current(edit,editedPlan).audible,false,'old cycle cannot expose revoked/edited tracks');
  }finally{await radio.close();}
});

test('late/inaccessible outputs stay dry for an entire ready-less cycle and quotas are bounded',async()=>{
  let time=1000,done,started;
  const began=new Promise(resolve=>{started=resolve;});
  const many={...plan,tracks:Array.from({length:51},(_,i)=>({id:'song-'+i,title:'日本語 '+i,durationMs:1000}))};
  const r=createDynamicRadio({now:()=>time,scheduler:false,scan:()=>[{station,plan:many,prefs}],
    render:(requests)=>{assert.equal(requests.length,dynamicLimit.clips);started();return new Promise(resolve=>{done=()=>resolve(new Map(requests.map(row=>[row.id,clip(row.text)])));});}});
  try{
    const pending=r.pump();
    await began;
    time=52001;
    const dry=r.current(station,many);
    assert.equal(dry.anchor,52000);assert.equal(dry.audible,false);
    done();await pending;
    time=64500;
    assert.deepEqual(r.current(station,many),dry,'stale output never pops into the current dry cycle');
  }finally{await r.close();}
});

test('continuous parity across cycles for one, odd, even and long plans',()=>{
  for(const count of [1,2,3,4,5,199,200]){
    for(let sequence=0;sequence<7;sequence++)for(let index=0;index<count;index++)
      assert.equal(isMcBoundary(sequence,count,index),(sequence*count+index+1)%2===0);
  }
});

test('one editorial bulletin is rendered once for a shared prepared slot or replaced by chat',async()=>{
  let time=station.epoch;
  const renders=[], reads=[];
  const radio=createDynamicRadio({scan,now:()=>time,scheduler:false,
    bulletin:async slot=>{
      reads.push(slot);
      return {id:'one-verified-item',speech:'編集部の短いお知らせです。'};
    },
    render:async requests=>{
      renders.push(requests);return new Map(requests.map(row=>[row.id,clip(row.text)]));
    }});
  try{
    await radio.pump();
    assert.equal(reads.length,1);
    assert.equal(reads[0].scheduledAt,station.epoch+40000);
    assert.equal(reads[0].until,station.epoch+80000);
    assert.equal(renders[0].filter(row=>row.text.includes('編集部')).length,1);
    time=station.epoch+31000;
    const current=radio.current(station,plan);
    assert.equal(current.segments.filter(row=>row.kind==='mc').length,2);
    assert.deepEqual(radio.current(station,plan),current);
    assert.equal(reads.length,1);
    await radio.pump();
    assert.deepEqual(reads[1].previousIds,['one-verified-item']);
    assert.equal(renders[1].length,1);
    assert.ok(!renders[1][0].text.includes('編集部'));
    assert.ok(renders[1][0].text.includes('Gamma'));
  }finally{await radio.close();}
});

test('bulletin file read finishing after commit cutoff does not rewrite live dry cycle',async()=>{
  let time=station.epoch,finish;
  const ready=new Promise(resolve=>{finish=resolve;});
  const radio=createDynamicRadio({scan,now:()=>time,scheduler:false,
    bulletin:async()=>ready,render:async()=>assert.fail('late bulletin must not reach renderer')});
  try{
    const preparation=radio.pump();
    await Promise.resolve();
    time=station.epoch+30001;
    const dry=radio.current(station,plan);
    finish({id:'late',speech:'間に合わなかった原稿'});
    await preparation;
    assert.ok(!dry.audible);assert.deepEqual(radio.current(station,plan),dry);
  }finally{await radio.close();}
});
