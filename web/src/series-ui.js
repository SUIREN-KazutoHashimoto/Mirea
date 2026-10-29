import { createSeriesContinuation,bindContinuationVideo } from './series-continuation.js';
import {seriesPathLabel,isInSeries} from './series-tree.js';

export function appendSeriesAssets(entries,ids,assets){
  const added=[...new Set(ids)].filter(id=>assets.has(id)&&!entries.some(e=>e.assetId===id));
  if(entries.length+added.length>1000)throw Error('1シリーズに追加できるアセットは1,000件までです。');
  return [...entries,...added.map(assetId=>({assetId,label:''}))];
}
// Ordering/ACL stay server-authoritative; unsaved checkbox changes are local.
export function openSeriesManager({dialog,api,esc,shelves,initialShelfId,initialSeriesId,initialParentId,onChanged,isCurrent}){
  const editable=shelves.filter(s=>s.role!=='viewer');if(!editable.length)return;
  const node=dialog(initialSeriesId?'シリーズを編集':'シリーズを追加','<div class="modal-body series-manager"><p role="status">読み込んでいます…</p></div>','series-modal'),body=node.querySelector('.modal-body');
  let shelfId=initialShelfId??editable[0].id,generation=0,creation;
  const alive=()=>node.isConnected&&isCurrent(),error=err=>{if(!alive())return;const box=body.querySelector('.form-error');if(box){box.textContent=err.message;box.hidden=false;}else body.textContent=err.message;};
  const options=(rows,selected='',exclude)=>'<option value="">なし（最上位）</option>'+rows.filter(s=>!exclude||!isInSeries(rows,s.id,exclude)).map(s=>`<option value="${esc(s.id)}" ${s.id===selected?'selected':''}>${esc(seriesPathLabel(rows,s.id))}</option>`).join('');
  node.addEventListener('close',()=>{if(isCurrent())onChanged();},{once:true});
  async function list(){
    const revision=++generation;body.innerHTML='<p role="status">シリーズを読み込んでいます…</p>';
    try{
      const rows=(await api(`/shelves/${shelfId}/series`)).series;if(!alive()||revision!==generation)return;
      body.innerHTML=`<label>本棚<select class="series-shelf">${editable.map(s=>`<option value="${s.id}" ${s.id===shelfId?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><p class="muted">同じ本棚の中でシリーズを入れ子にできます。作品は1つのシリーズに所属します。</p><form class="series-create"><label>新しいシリーズ名<input name="title" maxlength="200" required></label><label>親シリーズ<select name="parentId">${options(rows,initialParentId)}</select></label><button class="button primary" type="submit">シリーズを作成</button></form><p class="form-error" role="alert" hidden></p>`;
      body.querySelector('.series-shelf').onchange=e=>{shelfId=e.target.value;list();};
      body.querySelector('form').onsubmit=async e=>{
        e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;
        const values={title:form.elements.title.value.trim(),parentId:form.elements.parentId.value||null},key=JSON.stringify([shelfId,values]);
        if(creation?.key!==key)creation={key,requestId:crypto.randomUUID()};
        try{const created=await api(`/shelves/${shelfId}/series`,{method:'POST',body:{...values,requestId:creation.requestId}});if(alive())edit(created.series.id);}
        catch(err){error(err);button.disabled=false;}
      };
    }catch(err){if(revision===generation)error(err);}
  }
  async function edit(id){
    const revision=++generation;body.innerHTML='<p role="status">内容を読み込んでいます…</p>';
    try{
      const detail=await api(`/series/${id}`),library=await api(`/shelves/${detail.series.shelfId}/items`);if(!alive()||revision!==generation)return;
      shelfId=detail.series.shelfId;let entries=detail.items.map(item=>({assetId:item.id,label:item.series.label}));
      const assets=new Map(library.items.map(i=>[i.id,i])),rows=library.series;let orderMode=detail.series.orderMode??'name';const names=new Intl.Collator('ja',{numeric:true,sensitivity:'variant'});
      const sortNames=()=>entries.sort((a,b)=>names.compare(assets.get(a.assetId).title,assets.get(b.assetId).title)||a.assetId.localeCompare(b.assetId));
      const children=rows.filter(s=>s.id!==id&&(!s.parentId||s.parentId===id)&&!isInSeries(rows,id,s.id));
      body.innerHTML=`<button class="text-button series-back" type="button">← シリーズを追加</button><form class="series-edit"><fieldset><label>シリーズ名<input name="title" maxlength="200" required value="${esc(detail.series.title)}"></label><label>説明<textarea name="description" maxlength="2000" rows="2">${esc(detail.series.description)}</textarea></label><label>親シリーズ<select name="parentId">${options(rows,detail.series.parentId,id)}</select></label><details class="series-child-picker" open><summary>子シリーズを追加・解除</summary><p class="muted">チェックしたシリーズを中に入れます。解除してもシリーズや作品は削除されません。</p>${children.map(s=>`<label class="series-child-choice"><input type="checkbox" data-child-series="${esc(s.id)}" ${s.parentId===id?'checked':''}>${esc(s.title)}</label>`).join('')||'<p class="muted">追加できるシリーズはありません。先にシリーズを作成してください。</p>'}</details><p class="muted">以下はこのシリーズに直接所属する作品です。別のシリーズの作品は保存時にここへ移動します。上から再生／閲覧する順で、子シリーズの作品とは別に管理します。最大1,000件。</p><label>作品の並び順<select class="series-order-mode"><option value="name">名前の昇順（追加・名前変更時も自動）</option><option value="manual">手動で指定</option></select></label><div class="series-order-tools"><button type="button" class="button secondary series-sort-name">名前の昇順にまとめて並べる</button></div><ol class="series-order"></ol><div class="series-add"><label>追加するアセット（複数選択）<select class="series-candidate" multiple size="6" aria-label="追加するアセット（複数選択）"></select></label><div><button class="text-button select-all-assets" type="button">すべて選択</button><button class="button secondary" type="button" id="series-add">選択した作品をまとめて追加</button></div></div><p class="form-error" role="alert" hidden></p><div class="modal-actions"><button class="text-button series-delete" type="button">シリーズを削除</button><button class="button primary" type="submit">シリーズを保存</button></div><button class="text-button series-reload" type="button">保存せず最新の内容を読み直す</button></fieldset></form>`;
      const form=body.querySelector('form'),order=body.querySelector('.series-order'),candidate=body.querySelector('.series-candidate');
      const mode=body.querySelector('.series-order-mode');mode.value=orderMode;mode.onchange=()=>{orderMode=mode.value;renderOrder();};body.querySelector('.series-sort-name').onclick=()=>{orderMode='name';mode.value=orderMode;renderOrder();};
      function renderOrder(){
        if(orderMode==='name')sortNames();
        order.innerHTML=entries.map((entry,index)=>`<li><span class="series-entry-title"><small>${index+1}番目</small>${esc(assets.get(entry.assetId).title)}</span><input data-label="${index}" aria-label="${index+1}番目の巻・話ラベル" maxlength="80" placeholder="例：第1巻" value="${esc(entry.label)}"><div class="series-order-actions"><button type="button" class="icon-button" data-up="${index}" aria-label="${index+1}番目を前へ" ${index===0?'disabled':''}>↑</button><button type="button" class="icon-button" data-down="${index}" aria-label="${index+1}番目を後ろへ" ${index===entries.length-1?'disabled':''}>↓</button><button type="button" class="text-button" data-remove="${index}" aria-label="${index+1}番目をシリーズから外す">外す</button></div></li>`).join('');
        order.querySelectorAll('[data-label]').forEach(input=>input.oninput=()=>entries[Number(input.dataset.label)].label=input.value);
        order.querySelectorAll('[data-up],[data-down]').forEach(button=>button.onclick=()=>{orderMode='manual';mode.value=orderMode;const index=Number(button.dataset.up??button.dataset.down),target=index+(button.dataset.up===undefined?1:-1);[entries[index],entries[target]]=[entries[target],entries[index]];renderOrder();});
        order.querySelectorAll('[data-remove]').forEach(button=>button.onclick=()=>{entries.splice(Number(button.dataset.remove),1);renderOrder();});
        const available=library.items.filter(item=>!item.pending&&!entries.some(e=>e.assetId===item.id));
        candidate.innerHTML=available.map(item=>`<option value="${item.id}">${esc(item.title)}${item.series&&item.series.id!==id?' 【'+esc(item.series.title)+'から移動】':''} (${item.kind==='video'?'動画':item.kind==='audio'?'音声':'本'})</option>`).join('');
        body.querySelector('#series-add').disabled=!available.length||entries.length>=1000;
      }
      renderOrder();
      body.querySelector('.select-all-assets').onclick=()=>{for(const option of candidate.options)option.selected=true;};
      body.querySelector('#series-add').onclick=()=>{try{entries=appendSeriesAssets(entries,[...candidate.selectedOptions].map(o=>o.value),assets);renderOrder();}catch(err){error(err);}};
      body.querySelector('.series-back').onclick=list;body.querySelector('.series-reload').onclick=()=>edit(id);
      form.onsubmit=async e=>{
        e.preventDefault();const fieldset=form.querySelector('fieldset');fieldset.disabled=true;
        try{await api(`/series/${id}`,{method:'PUT',body:{revision:detail.series.revision,title:form.elements.title.value.trim(),description:form.elements.description.value.trim(),parentId:form.elements.parentId.value||null,children:[...body.querySelectorAll('[data-child-series]')].filter(e=>e.checked).map(e=>e.dataset.childSeries),items:entries,orderMode,moveAssets:true}});if(alive())node.close();}
        catch(err){error(err);fieldset.disabled=false;}
      };
      body.querySelector('.series-delete').onclick=async()=>{
        let preview;try{preview=await api(`/series/${id}/delete-preview`);}catch(err){error(err);return;}
        const confirm=dialog('シリーズを削除',`<div class="modal-body"><p>「${esc(detail.series.title)}」を削除します。配下はシリーズ${preview.seriesCount}件・アセット${preview.assetCount}件・未完了アップロード${preview.pendingCount}件です。<br>チェックしない場合は、このシリーズだけを削除し、子シリーズとアセットは残します。</p><label><input type="checkbox" class="delete-series-contents">配下のシリーズ・アセット・原本もすべて削除する（元に戻せません）</label><p</p><p class="form-error" role="alert" hidden></p><button class="button danger" type="button">選んだ内容で削除する</button></div>`);
        confirm.querySelector('.button').onclick=async e=>{e.currentTarget.disabled=true;try{await api(`/series/${id}`,{method:'DELETE',body:{revision:detail.series.revision,deleteContents:confirm.querySelector('.delete-series-contents').checked,previewHash:preview.previewHash}});confirm.close();if(alive())node.close();}catch(err){const box=confirm.querySelector('.form-error');box.hidden=false;box.textContent=err.message;confirm.querySelector('.button').disabled=false;}};
      };
    }catch(err){if(revision===generation)error(err);}
  }
  if(initialSeriesId)edit(initialSeriesId);else list();return node;
}

const activeNavigations=new Set();
export function seriesNativeState(active){for(const update of activeNavigations)update(active);}

export function mountSeriesNavigation({node,body,item,api,esc,open,isCurrent,isActive=()=>!document.hidden,enabled=true,onEnabled=()=>{},beforeMove=async()=>{},order,onModes=()=>{}}){
  const bar=document.createElement('nav');bar.className='series-reader-nav';bar.setAttribute('aria-label','シリーズ内の移動');bar.hidden=true;(node.querySelector('.viewer-meta')??node).append(bar);
  const footer=document.createElement('div');footer.className='series-book-end';footer.hidden=true;
  const subscribers=new Set();let disposed=false,book=null,videoCleanup,signature='',pendingEnd,video,loopEpoch=0;
  const alive=()=>!disposed && node.isConnected && node.open && isCurrent();
  const backgroundCapable=['video','audio'].includes(item.kind);
  const active=()=>alive() && isActive() && (backgroundCapable || !document.hidden);
  const core=createSeriesContinuation({assetId:item.id,enabled,order,loadContext:()=>api(`/items/${item.id}/series`),isActive:active,changed:render,
    move:async(target,options,allowed)=>{
      await beforeMove();
      if(!active() || !allowed())return false;
      return new Promise(resolve=>{
        const background=Boolean(node.isMinimized);
        node.addEventListener('close',()=>{if(isCurrent() && isActive() && (backgroundCapable || !document.hidden))open(target,{...options,playbackOrder:order,background:options.autoplay&&background});resolve();},{once:true});
        node.close();
      });
    }
  });
  function render(state=core.state){
    if(!alive())return;
    const {context,enabled,busy,message,countdown,canContinue}=state;
    const next=context?.items?.[context.currentIndex+1];
    if(context?.series){
      const {items,currentIndex,series}=context;
      bar.hidden=false;
      const key=JSON.stringify([series.id,series.title,currentIndex,items.map(i=>[i.id,i.title,i.series.label])]);
      if(key!==signature){
        signature=key;
        bar.innerHTML=`<strong>${esc(series.title)}</strong><span>${currentIndex+1} / ${items.length} · ${esc(items[currentIndex].series.label)}</span><div><button class="button secondary series-prev">← 前のアセット</button><select aria-label="シリーズ内のアセット">${items.map((asset,index)=>`<option value="${esc(asset.id)}" ${asset.offlineUnavailable?'disabled':''} ${index===currentIndex?'selected':''}>${index+1}. ${esc(asset.series.label)} ${esc(asset.title)}</option>`).join('')}</select><button class="button secondary series-next">次のアセット →</button></div><div class="series-continuation"><label><input type="checkbox" class="series-continuous">連続再生・閲覧</label><span class="series-continuation-status" role="status"></span><button type="button" class="text-button series-cancel" hidden>自動移動を停止</button><button type="button" class="text-button series-now" hidden>今すぐ次へ</button></div>`;
        const details=document.createElement('details'),summary=document.createElement('summary');summary.append(bar.querySelector('strong'),bar.querySelector('span'));details.append(summary,...bar.querySelectorAll(':scope > div'));bar.append(details);
        bar.querySelector('.series-prev').onclick=()=>core.navigate({direction:-1});
        bar.querySelector('.series-next').onclick=()=>core.navigate();
        bar.querySelector('select').onchange=e=>core.navigate({targetId:e.target.value});
        bar.querySelector('input').onchange=e=>{onEnabled(e.target.checked);core.setEnabled(e.target.checked);};
        bar.querySelector('.series-cancel').onclick=()=>core.cancel('今回の自動移動を停止しました。');
        bar.querySelector('.series-now').onclick=()=>core.navigate({continuous:true,autoplay:true});
      }
      bar.dataset.chromePinned=String(countdown!==null || busy);
      if(countdown!==null || busy){bar.querySelector('details').open=true;node.showChrome?.();}
      bar.querySelector('.series-prev').disabled=busy || (order?!order.canMove(context,item.id,-1):currentIndex===0);
      bar.querySelector('.series-next').disabled=busy || (order?!order.canMove(context,item.id):!next);
      bar.querySelector('select').disabled=busy;
      bar.querySelector('input').checked=enabled;
      bar.querySelector('.series-cancel').hidden=countdown===null && !busy;
      bar.querySelector('.series-now').hidden=countdown===null;
      bar.querySelector('.series-continuation-status').textContent=busy?'次のアセットの権限と続き位置を確認しています…':countdown!==null?`${countdown}秒後に「${order&&(order.modes.shuffle||order.modes.repeat==='series')?'次の作品':next?.title??''}」へ進みます。`:message;
    }
    // Keep footer height stable during page re-render/resize to avoid a ResizeObserver loop.
    const lastPage=book && (book.atEnd??book.page===book.total);
    footer.hidden=!(lastPage && enabled && context?.series);
    if(!footer.hidden){
      if(!footer.isConnected)(node.querySelector('.viewer-meta')??body).append(footer);
      footer.innerHTML=next?`<span>この本の最後のページです。次は「${esc(next.title)}」</span><button type="button" class="button secondary" ${canContinue && book.ready?'':'disabled'}>次のアセットへ読み進む</button>`:'<span>この本はシリーズの最後のアセットです。</span>';
      const button=footer.querySelector('button');if(button)button.onclick=()=>core.nextBook();
    }
    for(const subscriber of subscribers)subscriber();
  }
  const suspend=()=>{pendingEnd=null;core.cancel('自動移動を停止しました。次へ進むには操作してください。');};
  const nativeState=active=>{if(active)render();else suspend();};
  const visibility=()=>{if(document.hidden && !['video','audio'].includes(item.kind))suspend();else render();};
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',suspend);activeNavigations.add(nativeState);
  const ready=(async()=>{
    try{
      const context=await api(`/items/${item.id}/series`);
      if(!alive())return;
      core.setContext(context);
      if(pendingEnd?.ended && active())core.videoEnded();pendingEnd=null;
    }catch{if(alive())core.notify('シリーズ情報を確認できないため、連続移動は停止しています。');}
  })();
  return {
    ready,
    get modeState(){return {...(order?.modes??{repeat:'off',shuffle:false}),hasSeries:Boolean(core.state.context?.series)};},
    setModes(value){if(!order)return;loopEpoch++;order.setModes(value);onModes(order.modes);onEnabled(true);core.setEnabled(true);},
    get canContinue(){return core.state.canContinue;},
    subscribe(fn){subscribers.add(fn);fn();return()=>subscribers.delete(fn);},
    bookState(state){book=state;render();},
    nextBook:()=>core.nextBook(),
    navigate:direction=>core.navigate({direction,autoplay:Boolean(video&&!video.paused)}),
    cancel:()=>core.cancel(),
    bindVideo(element,{autoplay=false}={}){
      videoCleanup?.();video=element;
      const ended=async()=>{if(order?.modes.repeat==='one'&&core.state.enabled){const epoch=++loopEpoch;try{await beforeMove();if(epoch!==loopEpoch||!active()||order.modes.repeat!=='one'||!core.state.enabled)return;video.currentTime=0;await video.play();}catch{if(alive())core.notify('単体リピートを開始できません。再生ボタンで再開してください。');}return;}if(!core.state.context)pendingEnd=video;else core.videoEnded();};
      const cancel=()=>{loopEpoch++;pendingEnd=null;core.cancel();};
      const failure=()=>core.cancel('メディアのエラーにより連続再生を停止しました。');
      videoCleanup=bindContinuationVideo(video,{autoplay,canAutoplay:()=>active(),onEnded:ended,onReset:cancel,onError:failure,
        onBlocked:reason=>core.notify(reason==='policy'?'自動再生が制限されました。プレーヤーの再生ボタンを押してください。':'自動再生を停止しました。再生ボタンで開始してください。')});
    },
    dispose(){if(disposed)return;disposed=true;loopEpoch++;pendingEnd=null;core.dispose();videoCleanup?.();subscribers.clear();activeNavigations.delete(nativeState);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',suspend);}
  };
}
