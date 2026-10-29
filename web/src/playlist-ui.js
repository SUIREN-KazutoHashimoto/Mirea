import {playlistKind} from '../../server/playlist-kind.js';
export function playlistEntries(playlists,items,{search='',sort,compare}={}){
  const assets=new Map(items.map(i=>[i.id,i]));
  return playlists.filter(p=>p.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(p=>{
    const members=p.assetIds.map(id=>assets.get(id)).filter(Boolean);return {type:'playlist',...p,cover:members[0],assetCount:members.length,size:members.reduce((n,i)=>n+i.size,0)};
  }).sort((a,b)=>compare(a,b,sort));
}
// The editor lives in the collection, not a modal. Drafts survive polling and
// layout changes; stale revisions fail instead of overwriting another device.
export function mountPlaylistEditor({container,playlist,draft,items,api,esc,onChanged,onCancel,current=()=>true}){
  container.innerHTML=`<form class="playlist-editor"><h3>${playlist?'プレイリストを編集':'プレイリストを作成'}</h3><p class="muted">自分専用のリストです。本棚・シリーズや元の作品は変更しません。最大1,000作品。</p><label>名前<input name="title" maxlength="200" required value="${esc(draft.title)}"></label><label>作品を検索<input name="query" type="search" placeholder="タイトル・本棚で検索"></label><div class="playlist-picker"></div><ol class="playlist-order"></ol><p class="form-error" role="alert" hidden></p><div class="modal-actions"><button class="button secondary playlist-cancel" type="button">キャンセル</button>${playlist?'<button class="button danger playlist-delete" type="button">リストだけ削除</button>':''}<button class="button primary" type="submit">${playlist?'保存':'作成'}</button></div></form>`;
  const form=container.querySelector('form'),picker=form.querySelector('.playlist-picker'),order=form.querySelector('.playlist-order'),byId=new Map(items.filter(i=>!i.pending).map(i=>[i.id,i]));
  const error=e=>{if(container.isConnected&&current()){const box=form.querySelector('.form-error');box.textContent=e.message;box.hidden=false;}};
  form.elements.title.oninput=e=>draft.title=e.target.value;
  function render(){
    const query=form.elements.query.value.toLocaleLowerCase(),selectedKinds=new Set(draft.assetIds.map(id=>playlistKind(byId.get(id))).filter(Boolean)),selectedKind=selectedKinds.size===1?[...selectedKinds][0]:null,available=[...byId.values()].filter(i=>(i.title+' '+i.shelfName).toLocaleLowerCase().includes(query)&&(!selectedKind||playlistKind(i)===selectedKind||draft.assetIds.includes(i.id)));
    picker.innerHTML=available.map(i=>`<label><input type="checkbox" value="${i.id}" ${draft.assetIds.includes(i.id)?'checked':''}>${esc(i.title)}<small>${esc(i.shelfName)}</small></label>`).join('')||'<p class="muted">該当する作品がありません。</p>';
    picker.querySelectorAll('input').forEach(el=>el.onchange=()=>{if(el.checked&&draft.assetIds.length>=1000){el.checked=false;error(Error('1,000作品までです。'));return;}if(el.checked&&selectedKinds.size&&(!selectedKinds.has(playlistKind(byId.get(el.value)))||selectedKinds.size>1)){el.checked=false;error(Error('同じ種類の作品だけを選んでください。'));return;}draft.assetIds=el.checked?[...draft.assetIds,el.value]:draft.assetIds.filter(id=>id!==el.value);render();});
    order.innerHTML=draft.assetIds.map((id,index)=>`<li><span>${index+1}. ${esc(byId.get(id)?.title??'現在閲覧できない作品（保存時に除外）')}</span><button type="button" data-up="${index}" ${index===0?'disabled':''} aria-label="${index+1}番目を前へ">↑</button><button type="button" data-down="${index}" ${index===draft.assetIds.length-1?'disabled':''} aria-label="${index+1}番目を後ろへ">↓</button><button type="button" data-remove="${index}" aria-label="${index+1}番目をリストから外す">外す</button></li>`).join('');
    order.querySelectorAll('[data-up],[data-down],[data-remove]').forEach(b=>b.onclick=()=>{const index=Number(b.dataset.up??b.dataset.down??b.dataset.remove);if(b.dataset.remove!==undefined)draft.assetIds.splice(index,1);else{const next=index+(b.dataset.up===undefined?1:-1);[draft.assetIds[index],draft.assetIds[next]]=[draft.assetIds[next],draft.assetIds[index]];}render();});
  }
  form.elements.query.oninput=render;render();form.querySelector('.playlist-cancel').onclick=onCancel;
  if(draft.busy)form.querySelectorAll('button,input').forEach(e=>e.disabled=true);
  async function busy(work){if(!current()||draft.busy)return;draft.busy=true;const buttons=form.querySelectorAll('button,input');buttons.forEach(e=>e.disabled=true);try{await work();}catch(e){error(e);buttons.forEach(e=>e.disabled=false);render();}finally{draft.busy=false;}}
  form.onsubmit=e=>{e.preventDefault();busy(async()=>{
    let p=playlist??(draft.id?{id:draft.id,revision:draft.revision}:null);if(!p){draft.requestId??=crypto.randomUUID();p=(await api('/playlists',{method:'POST',body:{title:draft.title.trim(),requestId:draft.requestId}})).playlist;}
    // Retain a created identity if saving its contents fails; retry never creates
    // another list and never rolls back successfully created user data.
    draft.id=p.id;draft.revision??=p.revision;
    const result=await api('/playlists/'+p.id,{method:'PUT',body:{revision:draft.revision,title:draft.title.trim(),assetIds:draft.assetIds.filter(id=>byId.has(id))}});
    if(current())await onChanged(result.playlist);
  });};
  if(playlist)form.querySelector('.playlist-delete').onclick=()=>{if(!window.confirm('プレイリストだけを削除します。アセットは削除しません。'))return;busy(async()=>{await api('/playlists/'+playlist.id,{method:'DELETE',body:{revision:playlist.revision}});if(current())await onChanged(null);});};
}
