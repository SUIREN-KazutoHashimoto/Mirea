import {playlistKind} from '../../server/playlist-kind.js';
import {reorderPlaylist,movePlaylistEntry} from './playlist-order.js';
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
  let visibleLimit=200,matching=[];
  const controls=document.createElement('div');controls.className='playlist-bulk-controls';controls.innerHTML='<span class="playlist-match-count" role="status"></span><button type="button" class="button secondary playlist-add-matching">検索結果をまとめて追加</button><button type="button" class="button secondary playlist-more">さらに200件を表示</button>';picker.before(controls);
  const ordering=document.createElement('div');ordering.className='playlist-bulk-controls';ordering.innerHTML='<span>リストの並び順</span><button type="button" class="button secondary" data-playlist-sort="asc">名前の昇順</button><button type="button" class="button secondary" data-playlist-sort="desc">名前の降順</button><button type="button" class="button secondary" data-playlist-sort="reverse">逆順</button>';order.before(ordering);
  ordering.querySelectorAll('button').forEach(button=>button.onclick=()=>{draft.assetIds=reorderPlaylist(draft.assetIds,[...byId.values()],button.dataset.playlistSort);render();});
  controls.querySelector('.playlist-more').onclick=()=>{visibleLimit+=200;render();};
  controls.querySelector('.playlist-add-matching').onclick=()=>{
    const ids=[...new Set([...draft.assetIds,...matching.map(item=>item.id)])];
    if(ids.length>1000){error(Error('1,000作品を超えます。検索条件を絞ってください。'));return;}
    if(new Set(ids.map(id=>playlistKind(byId.get(id))).filter(Boolean)).size>1){error(Error('音声・動画・本のいずれか1種類に絞るため、まず作品を1つ選んでください。'));return;}
    draft.assetIds=ids;render();
  };
  form.elements.title.oninput=e=>draft.title=e.target.value;
  function render(){
    const focused=document.activeElement,focusId=focused?.closest('[data-playlist-asset]')?.dataset.playlistAsset,focusAction=focused?.dataset.up!==undefined?'up':focused?.dataset.down!==undefined?'down':focused?.dataset.remove!==undefined?'remove':focused?.closest('.playlist-position')?'position':null,focusCheck=focused?.closest('.playlist-picker')?focused.value:null;
    const focusIndex=[...order.children].indexOf(focused?.closest('[data-playlist-asset]'));
    const query=form.elements.query.value.toLocaleLowerCase(),selectedKinds=new Set(draft.assetIds.map(id=>playlistKind(byId.get(id))).filter(Boolean)),selectedKind=selectedKinds.size===1?[...selectedKinds][0]:null,available=[...byId.values()].filter(i=>(i.title+' '+i.shelfName).toLocaleLowerCase().includes(query)&&(!selectedKind||playlistKind(i)===selectedKind||draft.assetIds.includes(i.id)));
    matching=available;controls.querySelector('.playlist-match-count').textContent=`${Math.min(visibleLimit,available.length)} / ${available.length}作品 · リストに${draft.assetIds.length}作品`;controls.querySelector('.playlist-more').hidden=available.length<=visibleLimit;
    picker.innerHTML=available.slice(0,visibleLimit).map(i=>`<label><input type="checkbox" value="${i.id}" ${draft.assetIds.includes(i.id)?'checked':''}>${esc(i.title)}<small>${esc(i.shelfName)}</small></label>`).join('')||'<p class="muted">該当する作品がありません。</p>';
    picker.querySelectorAll('input').forEach(el=>el.onchange=()=>{if(el.checked&&draft.assetIds.length>=1000){el.checked=false;error(Error('1,000作品までです。'));return;}if(el.checked&&selectedKinds.size&&(!selectedKinds.has(playlistKind(byId.get(el.value)))||selectedKinds.size>1)){el.checked=false;error(Error('同じ種類の作品だけを選んでください。'));return;}draft.assetIds=el.checked?[...draft.assetIds,el.value]:draft.assetIds.filter(id=>id!==el.value);render();});
    order.innerHTML=draft.assetIds.map((id,index)=>`<li data-playlist-asset="${esc(id)}"><span>${index+1}. ${esc(byId.get(id)?.title??'現在詳細を表示できない作品（リストに保持）')}</span><button type="button" class="button secondary" data-up="${index}" ${index===0?'disabled':''} aria-label="${index+1}番目を前へ">↑</button><button type="button" class="button secondary" data-down="${index}" ${index===draft.assetIds.length-1?'disabled':''} aria-label="${index+1}番目を後ろへ">↓</button><button type="button" class="button secondary" data-remove="${index}" aria-label="${index+1}番目をリストから外す">外す</button></li>`).join('');
    order.querySelectorAll('[data-up],[data-down],[data-remove]').forEach(b=>b.onclick=()=>{const index=Number(b.dataset.up??b.dataset.down??b.dataset.remove);if(b.dataset.remove!==undefined)draft.assetIds.splice(index,1);else{const next=index+(b.dataset.up===undefined?1:-1);[draft.assetIds[index],draft.assetIds[next]]=[draft.assetIds[next],draft.assetIds[index]];}render();});
    order.querySelectorAll('li').forEach((li,index)=>{const label=document.createElement('label');label.className='playlist-position';label.textContent='位置 ';const input=document.createElement('input');input.type='number';input.min='1';input.max=String(draft.assetIds.length);input.value=String(index+1);input.setAttribute('aria-label',`${index+1}番目の作品の移動先`);input.onchange=()=>{try{draft.assetIds=movePlaylistEntry(draft.assetIds,index,Number(input.value));render();}catch(e){error(e);input.value=String(index+1);}};input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();input.dispatchEvent(new Event('change'));}};label.append(input);li.append(label);});
    if(focusCheck)[...picker.querySelectorAll('input')].find(input=>input.value===focusCheck)?.focus({preventScroll:true});
    if(focusId&&focusAction){const row=[...order.children].find(li=>li.dataset.playlistAsset===focusId)??order.children[Math.max(0,Math.min(focusIndex,order.children.length-1))],control=row?.querySelector(focusAction==='position'?'input':`[data-${focusAction}]`);(control&&!control.disabled?control:row?.querySelector('input')??form.elements.query).focus({preventScroll:true});}
  }
  form.elements.query.oninput=()=>{visibleLimit=200;render();};render();form.querySelector('.playlist-cancel').onclick=onCancel;
  form.elements.query.onkeydown=e=>{if(e.key==='Enter')e.preventDefault();};
  if(draft.busy)form.querySelectorAll('button,input').forEach(e=>e.disabled=true);
  async function busy(work){if(!current()||draft.busy)return;draft.busy=true;const buttons=form.querySelectorAll('button,input');buttons.forEach(e=>e.disabled=true);try{await work();}catch(e){error(e);buttons.forEach(e=>e.disabled=false);render();}finally{draft.busy=false;}}
  form.onsubmit=e=>{e.preventDefault();busy(async()=>{
    let p=playlist??(draft.id?{id:draft.id,revision:draft.revision}:null);if(!p){draft.requestId??=crypto.randomUUID();p=(await api('/playlists',{method:'POST',body:{title:draft.title.trim(),requestId:draft.requestId}})).playlist;}
    // Retain a created identity if saving its contents fails; retry never creates
    // another list and never rolls back successfully created user data.
    draft.id=p.id;draft.revision??=p.revision;
    const result=await api('/playlists/'+p.id,{method:'PUT',body:{revision:draft.revision,title:draft.title.trim(),assetIds:draft.assetIds}});
    if(current())await onChanged(result.playlist);
  });};
  if(playlist)form.querySelector('.playlist-delete').onclick=()=>{if(!window.confirm('プレイリストだけを削除します。アセットは削除しません。'))return;busy(async()=>{await api('/playlists/'+playlist.id,{method:'DELETE',body:{revision:playlist.revision}});if(current())await onChanged(null);});};
}
