import test from 'node:test';
import assert from 'node:assert/strict';
import {mountUploadLeaveGuard} from '../web/src/upload-leave-guard.js';
test('leaving prompts only while local uploads are pending and releases the guard as soon as transfer completes',()=>{
 const win=new EventTarget();let pending=false;const dispose=mountUploadLeaveGuard({win,hasPending:()=>pending});
 const attempt=()=>{const event=new Event('beforeunload',{cancelable:true});win.dispatchEvent(event);return event.defaultPrevented;};
 assert.equal(attempt(),false);pending=true;win.dispatchEvent(new Event('mirea:transferchange'));assert.equal(attempt(),true);
 pending=false;win.dispatchEvent(new Event('mirea:transferchange'));assert.equal(attempt(),false);
 pending=true;win.dispatchEvent(new Event('mirea:transferchange'));dispose();assert.equal(attempt(),false);
});
