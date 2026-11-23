import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rotationTracks} from '../server/radio-autodj.js';

for(const n of [2,3,4,5,37,200])test('shuffle has no consecutive repeats across round boundaries with '+n+' tracks',()=>{
  const station={id:'seam-fixture-'+n,epoch:123};
  const tracks=Array.from({length:n},(_,i)=>({id:'song-'+i}));
  const plan={rotation:'shuffle',sources:[['source',1]],tracks};
  const ids=round=>rotationTracks(station,plan,round).map(track=>track.id);
  for(let round=100;round>=0;round--){
    const current=ids(round), next=ids(round+1);
    assert.equal(new Set(current).size,n);
    assert.notEqual(current.at(-1),next[0]);
    if(n===2)assert.deepEqual(current,next);else assert.notDeepEqual(current,next);
  }
  const distant=ids(137475);
  for(let round=0;round<100;round++)ids(round);
  assert.deepEqual(ids(137475),distant);
});
