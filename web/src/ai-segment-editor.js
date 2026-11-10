const fields=row=>({startMs:row.startMs,endMs:row.endMs,label:row.label??'区間',text:row.text??'',kind:row.kind??'section'});
export async function openAiSegmentEditor({item,feature,data,row,next,api,dialog,valid,onSaved}){
 const full=await api('/items/'+item.id+'/ai/'+feature+'?offset='+(data.offset??0));if(!valid())return;
 const parent=row.manualParentId??row.id,parts=full.patch?.splits?.[parent]?structuredClone(full.patch.splits[parent]):[fields(row)],index=row.manualPartIndex??0;
 const modal=dialog('区間を訂正','<form class="modal-body ai-edit"><label>区間の名前<input name="label" maxlength="160" required></label><label>開始位置（秒）<input name="start" type="number" min="0" step=".001" required></label><label>終了位置（秒）<input name="end" type="number" min="0" step=".001" required></label><label>説明<textarea name="text" maxlength="16000" rows="3"></textarea></label><label class="ai-check"><input type="checkbox" name="hidden">この区間を非表示にする</label><button class="button primary" data-action="save">保存</button><details><summary>区間を分割・結合</summary><label>分割する位置（秒）<input name="split" type="number" min="0" step=".001"></label><label>分割後の後半の名前<input name="secondLabel" maxlength="160"></label><div class="ai-actions"><button class="button secondary" data-action="split">分割して保存</button><button class="button secondary" data-action="merge">次の区間と結合</button></div></details><p role="status"></p></form>');
 const form=modal.querySelector('form'),status=form.querySelector('[role=status]');form.elements.label.value=row.label??'';form.elements.start.value=row.startMs/1000;form.elements.end.value=row.endMs/1000;form.elements.text.value=row.text??'';form.elements.split.value=(row.startMs+row.endMs)/2000;form.elements.secondLabel.value=row.label??'区間';
 const canMerge=next&&(row.manualParentId&&row.manualParentId===next.manualParentId||!row.manualParentId&&!next.manualParentId);form.querySelector('[data-action=merge]').disabled=!canMerge;let busy=false;
 form.onsubmit=async event=>{event.preventDefault();if(busy||!valid())return;busy=true;form.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{
   const value={...fields(row),label:form.elements.label.value,text:form.elements.text.value,startMs:Math.round(Number(form.elements.start.value)*1000),endMs:Math.round(Number(form.elements.end.value)*1000)},action=event.submitter?.dataset.action??'save';let patch;
   if(action==='split'){
    const at=Math.round(Number(form.elements.split.value)*1000);if(!Number.isSafeInteger(at)||at<=value.startMs||at>=value.endMs)throw Error('分割位置は区間の開始と終了の間にしてください。');
    parts.splice(index,1,{...value,endMs:at},{...value,startMs:at,label:form.elements.secondLabel.value||value.label});patch={splits:{[parent]:parts}};
   }else if(action==='merge'){
    if(!canMerge)throw Error('結合できる次の区間がありません。');const merged={...value,endMs:next.endMs,text:[value.text,next.text].filter(Boolean).join('\n')};
    if(row.manualParentId){parts.splice(index,2,merged);patch={splits:{[parent]:parts}};}else patch={segments:{[row.id]:merged,[next.id]:{hidden:true}}};
   }else if(row.manualParentId){
    if(form.elements.hidden.checked)parts.splice(index,1);else parts[index]=value;
    patch=parts.length?{splits:{[parent]:parts}}:{segments:{[parent]:{hidden:true}}};
   }else patch={segments:{[row.id]:{...value,hidden:form.elements.hidden.checked}}};
   await api('/items/'+item.id+'/ai/'+feature,{method:'PATCH',body:{requestId:crypto.randomUUID(),revision:data.editRevision,resultRevision:data.revision,patch}});
   if(!valid())return;modal.close();await onSaved();
  }catch(error){if(modal.isConnected)status.textContent=error.message;}finally{busy=false;form.querySelectorAll('button').forEach(b=>b.disabled=b.dataset.action==='merge'&&!canMerge);}
 };
}
export async function openAiHidden({item,feature,data,api,dialog,valid,onSaved}){
 const full=await api('/items/'+item.id+'/ai/'+feature+'?offset='+(data.offset??0)+'&original=true');if(!valid())return;
 const modal=dialog('非表示にした箇所','<div class="modal-body ai-hidden-results"></div>'),box=modal.querySelector('.ai-hidden-results');let count=0;
 for(const kind of ['blocks','segments'])for(const row of full.original?.[kind]??[]){if(!full.patch?.[kind]?.[row.id]?.hidden)continue;count++;const text=document.createElement('p');text.textContent=full.patch[kind][row.id].text??row.text??row.label;const b=document.createElement('button');b.type='button';b.className='button secondary';b.textContent='表示に戻す';b.onclick=async()=>{if(!valid())return;b.disabled=true;try{await api('/items/'+item.id+'/ai/'+feature,{method:'PATCH',body:{requestId:crypto.randomUUID(),revision:full.editRevision,resultRevision:full.revision,patch:{[kind]:{[row.id]:{hidden:false}}}}});modal.close();await onSaved();}catch(error){text.textContent=error.message;b.disabled=false;}};box.append(text,b);}
 if(!count)box.textContent='この範囲に非表示の箇所はありません。';
}
