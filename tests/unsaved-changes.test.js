import test from 'node:test';
import assert from 'node:assert/strict';
import {formHasChanges,requestDialogClose} from '../web/src/unsaved-changes.js';
test('draft form detection includes text, toggles, and default select values',()=>{
 const text={name:'title',value:'Original',defaultValue:'Original'},toggle={name:'private',type:'checkbox',checked:false,defaultChecked:false},select={name:'parent',options:[{selected:true,defaultSelected:false},{selected:false,defaultSelected:false}]},form={elements:[text,toggle,select]};
 assert.equal(formHasChanges(form),false);text.value='Edited';assert.equal(formHasChanges(form),true);text.value='Original';toggle.checked=true;assert.equal(formHasChanges(form),true);toggle.checked=false;select.options[0].selected=false;select.options[1].selected=true;assert.equal(formHasChanges(form),true);
});
test('dismissal preserves a rejected draft and closes non-editing dialogs without a confirmation',()=>{
 let closed=0,asked=0;const node={hasUnsavedChanges:()=>true,querySelectorAll:()=>[],close:()=>closed++};
 assert.equal(requestDialogClose(node,()=>{asked++;return false;}),false);assert.equal(closed,0);assert.equal(requestDialogClose(node,()=>true),true);node.hasUnsavedChanges=()=>false;requestDialogClose(node,()=>{asked++;return false;});assert.equal(closed,2);assert.equal(asked,1);
});
