export async function openAiEditHistory({item,feature,data,api,dialog,valid,onSaved}){
 const modal=dialog('訂正の履歴','<div class="modal-body ai-edit-history"><p>以前の訂正を確認して戻せます。戻した操作も新しい履歴として保存します。</p><div class="ai-history-list"></div><section class="ai-history-preview"></section><p role="status"></p></div>','ai-modal'),box=modal.querySelector('.ai-history-list'),preview=modal.querySelector('.ai-history-preview'),status=modal.querySelector('[role=status]');let offset=0,epoch=0,busy=false;
 const current=()=>modal.isConnected&&valid();
 const button=(text,work)=>{const b=document.createElement('button');b.type='button';b.className='button secondary';b.textContent=text;b.onclick=()=>work().catch(error=>{if(current())status.textContent=error.message;});return b;};
 async function select(revision){
  const generation=++epoch;preview.replaceChildren();const chosen=await api('/items/'+item.id+'/ai/'+feature+'/edits?revision='+revision);if(!current()||generation!==epoch)return;
  const heading=document.createElement('h3');heading.textContent=revision?'訂正 '+revision:'現在の解析結果（訂正なし）';preview.append(heading);
  const changes=[];for(const kind of ['blocks','segments','splits'])for(const value of Object.values(chosen.patch[kind]??{})){const values=Array.isArray(value)?value:[value];for(const row of values)changes.push(row.text||row.label||(row.hidden?'非表示に変更':row.hidden===false?'表示に戻す':'認識範囲・読む順・時刻を調整'));}
  let shown=0;const entries=document.createElement('div'),more=button('続きの訂正を見る',async()=>append());function append(){for(const value of changes.slice(shown,shown+100)){const p=document.createElement('p');p.textContent=value;entries.append(p);}shown+=100;more.hidden=shown>=changes.length;}preview.append(entries,more);append();if(!changes.length)entries.textContent='手動の訂正はありません。';
  const restore=button('この訂正に戻す',async()=>{if(busy||!current())return;busy=true;restore.disabled=true;try{await api('/items/'+item.id+'/ai/'+feature+'/edits',{method:'POST',body:{requestId:crypto.randomUUID(),revision:data.editRevision,resultRevision:data.revision,restoreRevision:revision}});if(current()){modal.close();await onSaved();}}finally{busy=false;restore.disabled=false;}});preview.append(restore);
 }
 async function load(){
  const value=await api('/items/'+item.id+'/ai/'+feature+'/edits?offset='+offset);if(!current())return;
  for(const row of value.edits)box.append(button(new Date(row.createdAt).toLocaleString()+' · 訂正 '+row.revision,()=>select(row.revision)));
  if(value.hasMore){const more=button('以前の履歴を表示',async()=>{more.disabled=true;offset=value.nextOffset;more.remove();await load();});box.append(more);}
 }
 box.append(button('現在の解析結果（訂正なし）',()=>select(0)));try{await load();}catch(error){if(current())status.textContent=error.message;}
}
