import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePlayerPreferences,playerPreferences} from '../web/src/player-preferences.js';
test('playback control changes persist immediately across player instances and isolate accounts/endpoints',()=>{
 const rows=new Map(),storage={getItem:key=>rows.get(key),setItem:(key,value)=>rows.set(key,value)};
 const one=playerPreferences('https://one|alice',storage);one.save({volume:.35,muted:true,rate:1.5});
 assert.deepEqual(playerPreferences('https://one|alice',storage).value,{volume:.35,muted:true,rate:1.5});
 assert.deepEqual(playerPreferences('https://one|bob',storage).value,{volume:1,muted:false,rate:1});assert.deepEqual(playerPreferences('https://two|alice',storage).value,{volume:1,muted:false,rate:1});
 one.save({muted:false});assert.equal(playerPreferences('https://one|alice',storage).value.volume,.35);
});
test('invalid stored controls and unavailable browser storage keep safe usable defaults',()=>{
 assert.deepEqual(normalizePlayerPreferences({volume:-1,muted:'true',rate:Infinity}),{volume:1,muted:false,rate:1});assert.deepEqual(normalizePlayerPreferences(null),{volume:1,muted:false,rate:1});
 const broken={getItem(){throw Error('unavailable');},setItem(){throw Error('unavailable');}},scope='blocked-storage';playerPreferences(scope,broken).save({volume:.4,rate:1.25});assert.equal(playerPreferences(scope,broken).value.volume,.4);
 const corrupt={getItem:()=>'{bad'};assert.equal(playerPreferences('corrupt',corrupt).value.rate,1);
 const readonly={getItem:()=>'{"volume":1,"rate":1}',setItem(){throw Error('readonly');}};playerPreferences('readonly',readonly).save({volume:.2,rate:1.75});assert.equal(playerPreferences('readonly',readonly).value.volume,.2,'failed writes must not resurrect the old stored settings within the current page');
});
