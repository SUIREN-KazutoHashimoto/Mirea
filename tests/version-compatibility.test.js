import test from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions} from '../web/src/version-compatibility.js';
test('native startup updates compare numeric versions and any differing major blocks content',()=>{
 assert.deepEqual(compareVersions('0.23.0-beta','0.23.0-beta'),{known:true,majorMismatch:false,update:false});assert.equal(compareVersions('0.9.0-beta','0.23.0beta').update,true);assert.equal(compareVersions('0.23.0-beta','1.0.0').majorMismatch,true);assert.equal(compareVersions('2.0.0','1.99.0').majorMismatch,true);assert.equal(compareVersions('0.23.1-beta','0.23.0-beta').update,false);assert.equal(compareVersions('invalid','1.0.0').known,false);
});
