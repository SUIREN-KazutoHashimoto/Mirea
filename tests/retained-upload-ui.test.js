import test from 'node:test';
import assert from 'node:assert/strict';
import {canRetryRetainedUpload,serverUploadTransfer} from '../web/src/transfer-manager.js';
test('retained failed source supports retry until expiry without offering retry for deleted or running uploads',()=>{
 const row=serverUploadTransfer({id:'upload-id',title:'Book',state:'failed',sourceRetained:true,sourceExpiresAt:2000});assert.equal(row.sourceExpiresAt,2000);assert.equal(canRetryRetainedUpload(row,1999),true);assert.equal(canRetryRetainedUpload(row,2000),false);
 assert.equal(canRetryRetainedUpload({...row,state:'running'},1000),false);assert.equal(canRetryRetainedUpload({...row,sourceRetained:false},1000),false);assert.equal(canRetryRetainedUpload(undefined),false);
});
