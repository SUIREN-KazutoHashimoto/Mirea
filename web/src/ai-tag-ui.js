import {aiIdentity,sameAiIdentity} from './ai-ui.js';
export function openAiTagBulk({items,api,dialog,esc}){
  const actor=aiIdentity(),current=()=>sameAiIdentity(actor)&&node.isConnected;
  const assets=items.filter(item=>!item.pending);if(!assets.length)return;
  const node=dialog('一覧のタグを編集','<form class="modal-body ai-tag-bulk"><p class="ai-target-count"></p><label>保存先<select name="scope"><option value="personal">自分だけのタグ</option><option value="shared">共有タグ</option></select></label><label>操作<select name="action"><option value="add">タグを追加</option><option value="remove">タグを解除・再提案を非表示</option></select></label><label>タグ<textarea name="tags" rows="3" maxlength="6000" placeholder="改行で区切って入力" required></textarea></label><label class="ai-check"><input name="confirmed" type="checkbox" required>対象と操作を確認しました</label><p role="status"></p><button class="button primary">タグを更新</button></form>');
  const form=node.querySelector('form');form.querySelector('.ai-target-count').textContent='現在の一覧に含まれる '+assets.length+'作品が対象です。シリーズは中のアセットを対象とします。';
  form.onsubmit=async e=>{e.preventDefault();if(!current())return;const button=form.querySelector('button');button.disabled=true;const status=form.querySelector('[role=status]'),tags=form.elements.tags.value.split(/[\n,、]/).map(t=>t.trim()).filter(Boolean);
    try{for(let offset=0;offset<assets.length&&current();offset+=1000){const group=assets.slice(offset,offset+1000);await api('/ai/tags/bulk',{method:'POST',body:{assetIds:group.map(i=>i.id),scope:form.elements.scope.value,action:form.elements.action.value,tags}});status.textContent=Math.min(offset+1000,assets.length)+' / '+assets.length+'作品を更新しました。';}button.textContent='更新しました';}
    catch(error){status.textContent=error.message;button.disabled=false;}
  };
}
export async function openAiTagDictionary({shelfId,api,dialog}){
  const node=dialog('タグを整理','<div class="modal-body ai-tag-dictionary"><label>対象<select class="ai-dictionary-scope"><option value="personal">自分だけのタグ</option><option value="shared">共有タグ</option></select></label><label>タグを検索<input class="ai-tag-query" type="search" maxlength="80"></label><div class="ai-tag-choices"></div><form><p class="ai-tag-selection"></p><label>変更先のタグ名<input name="to" maxlength="80" required></label><label class="ai-check"><input name="confirmed" type="checkbox" required>対象作品のタグ名を変更・統合することを確認しました</label><p role="status"></p><button class="button primary">タグを整理</button></form></div>','ai-modal');
  const panel=node.querySelector('.ai-tag-dictionary'),select=panel.querySelector('select'),form=panel.querySelector('form'),query=panel.querySelector('.ai-tag-query'),choices=panel.querySelector('.ai-tag-choices');
  const actor=aiIdentity();let data,selected,disposed=false,epoch=0;node.addEventListener('close',()=>disposed=true,{once:true});
  if(!shelfId)select.querySelector('[value=shared]').disabled=true;
  const status=e=>{if(!disposed)form.querySelector('[role=status]').textContent=e.message??e;};
  async function load(){const generation=++epoch;selected=null;const value=await api('/ai/tags?scope='+select.value+(shelfId?'&shelfId='+shelfId:''));if(disposed||!sameAiIdentity(actor)||generation!==epoch)return;data=value;render();form.querySelector('.ai-tag-selection').textContent='整理するタグを選んでください。';}
  function render(){choices.replaceChildren();for(const tag of data.tags.filter(t=>t.label.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())).slice(0,100)){const button=document.createElement('button');button.type='button';button.className='button secondary';button.textContent=tag.label+' · '+tag.count+'作品';button.onclick=()=>{selected=tag;form.elements.to.value=tag.label;form.elements.confirmed.checked=false;form.querySelector('.ai-tag-selection').textContent='「'+tag.label+'」の '+tag.count+'作品が対象です。変更先が既存タグと同じ場合は統合します。';};choices.append(button);}}
  query.oninput=()=>data&&render();select.onchange=()=>load().catch(status);
  form.onsubmit=async e=>{e.preventDefault();if(disposed||!sameAiIdentity(actor))return;if(!selected){status('整理するタグを選んでください。');return;}const button=form.querySelector('button');button.disabled=true;try{const result=await api('/ai/tags/rename',{method:'POST',body:{scope:select.value,shelfId,revision:data.revision,from:selected.label,to:form.elements.to.value}});await load();status(result.updated+'作品のタグを整理しました。');}catch(error){status(error);}finally{button.disabled=false;}};
  try{await load();}catch(error){status(error);}
}
