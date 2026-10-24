export function openSeriesBulk({dialog,api,esc,shelves,activeShelf,onChanged,isCurrent=()=>true}){
  const editable=shelves.filter(s=>s.role!=='viewer');
  const node=dialog('シリーズをまとめて整理',`<form class="modal-body"><label>本棚<select name="shelf">${editable.map(s=>`<option value="${s.id}" ${s.id===activeShelf?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><div class="series-bulk-list"></div><label>移動先<select name="parent"></select></label><label><input name="deep" type="checkbox">削除時に配下のシリーズとアセット・原本も削除する</label><div class="modal-actions"><button class="button secondary" type="submit" name="move">選択したシリーズを移動</button><button class="button danger" type="submit" name="delete">選択したシリーズを削除</button></div><p class="form-error" role="alert" hidden></p></form>`);
  const form=node.querySelector('form');let generation=0;
  const error=err=>{const box=form.querySelector('.form-error');box.hidden=false;box.textContent=err.message;};
  async function load(){const own=++generation;try{const {series}=await api('/shelves/'+form.elements.shelf.value+'/series');if(!node.isConnected||generation!==own)return;
    form.querySelector('.series-bulk-list').innerHTML=series.map(s=>`<label><input type="checkbox" value="${s.id}" data-series-selected>${esc(s.title)} · ${s.assetCount}アセット</label>`).join('')||'<p>シリーズはありません。</p>';
    form.elements.parent.innerHTML='<option value="">最上位</option>'+series.map(s=>`<option value="${s.id}">${esc(s.title)}</option>`).join('');
  }catch(err){error(err);}}
  form.elements.shelf.onchange=load;
  form.onsubmit=async event=>{event.preventDefault();if(!isCurrent()||!node.isConnected)return;const ids=[...form.querySelectorAll('[data-series-selected]:checked')].map(e=>e.value);if(!ids.length)return error(Error('シリーズを選択してください。'));
    const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
    try{const preview=await api('/series/bulk/preview',{method:'POST',body:{ids}}),action=event.submitter.name==='delete'?'delete':'move',deep=form.elements.deep.checked;
      if(!confirm(action==='delete'?`${ids.length}シリーズを削除します。${deep?'配下のシリーズ'+preview.seriesCount+'件、アセット'+preview.assetCount+'件と原本も削除します。元に戻せません。':'アセットは残します。'}実行しますか？`:'選択したシリーズを移動しますか？'))return;
      if(!isCurrent()||!node.isConnected)return;
      await api('/series/bulk',{method:'POST',body:{ids,action,parentId:form.elements.parent.value||null,deleteContents:deep,previewHash:preview.previewHash}});node.close();await onChanged();
    }catch(err){error(err);}finally{buttons.forEach(b=>b.disabled=false);}
  };load();return node;
}
