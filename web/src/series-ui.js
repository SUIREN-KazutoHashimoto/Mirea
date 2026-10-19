import { createSeriesContinuation,bindContinuationVideo } from './series-continuation.js';

// Series permissions and ordering remain server-authoritative. Never infer order from titles.
export function openSeriesManager({dialog,api,esc,shelves,initialShelfId,initialSeriesId,onChanged,isCurrent}){
  const editable=shelves.filter(s=>s.role!=='viewer');
  if(!editable.length)return;
  const node=dialog('シリーズを管理','<div class="modal-body series-manager"><p role="status">読み込んでいます…</p></div>','series-modal');
  const body=node.querySelector('.modal-body');
  let shelfId=initialShelfId??editable[0].id,generation=0;
  const alive=()=>node.isConnected && isCurrent();
  node.addEventListener('close',()=>{if(isCurrent())onChanged();},{once:true});
  const error=err=>{if(!alive())return;const box=body.querySelector('.form-error');if(box){box.textContent=err.message;box.hidden=false;}else body.textContent=err.message;};
  async function list(){
    const revision=++generation;
    body.innerHTML='<p role="status">シリーズを読み込んでいます…</p>';
    try{
      const result=await api(`/shelves/${shelfId}/series`);
      if(!alive() || revision!==generation)return;
      body.innerHTML=`<label>本棚<select class="series-shelf">${editable.map(s=>`<option value="${s.id}" ${s.id===shelfId?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><p class="muted">1つのアセットは1シリーズに所属できます。PDF・画像本・動画を混在させられます。</p><div class="series-list">${result.series.map(s=>`<button class="button secondary" data-edit-series="${s.id}">${esc(s.title)} · ${s.assetCount}件</button>`).join('')||'<p>まだシリーズはありません。</p>'}</div><form class="series-create"><label>新しいシリーズ名<input name="title" maxlength="200" required placeholder="例：旅の記録・第1シーズン"></label><button class="button primary" type="submit">シリーズを作成</button></form><p class="form-error" role="alert" hidden></p>`;
      body.querySelector('.series-shelf').onchange=e=>{shelfId=e.target.value;list();};
      body.querySelectorAll('[data-edit-series]').forEach(button=>{button.onclick=()=>edit(button.dataset.editSeries);});
      body.querySelector('form').onsubmit=async e=>{
        e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;
        try{const created=await api(`/shelves/${shelfId}/series`,{method:'POST',body:{title:form.elements.title.value.trim()}});if(alive())edit(created.series.id);}
        catch(err){error(err);button.disabled=false;}
      };
    }catch(err){if(revision===generation)error(err);}
  }
  async function edit(id){
    const revision=++generation;
    body.innerHTML='<p role="status">内容を読み込んでいます…</p>';
    try{
      const detail=await api(`/series/${id}`);
      const library=await api(`/shelves/${detail.series.shelfId}/items`);
      if(!alive() || revision!==generation)return;
      shelfId=detail.series.shelfId;
      let entries=detail.items.map(item=>({assetId:item.id,label:item.series.label}));
      const assets=new Map(library.items.map(i=>[i.id,i]));
      body.innerHTML=`<button class="text-button series-back" type="button">← シリーズ一覧</button><form class="series-edit"><fieldset><label>シリーズ名<input name="title" maxlength="200" required value="${esc(detail.series.title)}"></label><label>説明<textarea name="description" maxlength="2000" rows="2">${esc(detail.series.description)}</textarea></label><p class="muted">上から読む／見る順です。矢印で並べ替え、巻・話の表示を自由に付けられます（第1巻、第2話、外伝など）。最大1,000件。</p><ol class="series-order"></ol><div class="series-add"><label>追加するアセット<select class="series-candidate"></select></label><button class="button secondary" type="button" id="series-add">追加</button></div><p class="form-error" role="alert" hidden></p><div class="modal-actions"><button class="text-button series-delete" type="button">シリーズを削除</button><button class="button primary" type="submit">シリーズを保存</button></div><button class="text-button series-reload" type="button">保存せず最新の内容を読み直す</button></fieldset></form>`;
      const form=body.querySelector('form'),order=body.querySelector('.series-order'),candidate=body.querySelector('.series-candidate');
      function renderOrder(){
        order.innerHTML=entries.map((entry,index)=>`<li><span class="series-entry-title"><small>${index+1}番目</small>${esc(assets.get(entry.assetId).title)}</span><input data-label="${index}" aria-label="${index+1}番目の巻・話ラベル" maxlength="80" placeholder="例：第1巻" value="${esc(entry.label)}"><div class="series-order-actions"><button type="button" class="icon-button" data-up="${index}" aria-label="${index+1}番目を前へ" ${index===0?'disabled':''}>↑</button><button type="button" class="icon-button" data-down="${index}" aria-label="${index+1}番目を後ろへ" ${index===entries.length-1?'disabled':''}>↓</button><button type="button" class="text-button" data-remove="${index}" aria-label="${index+1}番目をシリーズから外す">外す</button></div></li>`).join('');
        order.querySelectorAll('[data-label]').forEach(input=>{input.oninput=()=>{entries[Number(input.dataset.label)].label=input.value;};});
        order.querySelectorAll('[data-up],[data-down]').forEach(button=>{button.onclick=()=>{const index=Number(button.dataset.up??button.dataset.down),target=index+(button.dataset.up===undefined?1:-1);[entries[index],entries[target]]=[entries[target],entries[index]];renderOrder();};});
        order.querySelectorAll('[data-remove]').forEach(button=>{button.onclick=()=>{entries.splice(Number(button.dataset.remove),1);renderOrder();};});
        const available=library.items.filter(item=>!entries.some(e=>e.assetId===item.id) && (!item.series || item.series.id===id));
        candidate.innerHTML=available.map(item=>`<option value="${item.id}">${esc(item.title)} (${item.kind==='video'?'動画':'本'})</option>`).join('')||'<option value="">追加できるアセットがありません</option>';
        body.querySelector('#series-add').disabled=!available.length || entries.length>=1000;
      }
      renderOrder();
      body.querySelector('#series-add').onclick=()=>{if(candidate.value && entries.length<1000){entries.push({assetId:candidate.value,label:''});renderOrder();}};
      body.querySelector('.series-back').onclick=list;
      body.querySelector('.series-reload').onclick=()=>edit(id);
      form.onsubmit=async e=>{
        e.preventDefault();const fieldset=form.querySelector('fieldset');fieldset.disabled=true;
        try{await api(`/series/${id}`,{method:'PUT',body:{revision:detail.series.revision,title:form.elements.title.value.trim(),description:form.elements.description.value.trim(),items:entries}});if(alive())node.close();}
        catch(err){error(err);fieldset.disabled=false;}
      };
      body.querySelector('.series-delete').onclick=()=>{
        const confirm=dialog('シリーズを削除',`<div class="modal-body"><p>「${esc(detail.series.title)}」のまとまりを削除します。アセット本体・閲覧記録・続き位置・暗号化ダウンロードは削除しません。</p><p class="form-error" role="alert" hidden></p><button class="button danger" type="button">シリーズだけを削除する</button></div>`);
        confirm.querySelector('.button').onclick=async e=>{
          e.currentTarget.disabled=true;
          try{await api(`/series/${id}`,{method:'DELETE',body:{revision:detail.series.revision}});confirm.close();if(alive())node.close();}
          catch(err){const box=confirm.querySelector('.form-error');box.hidden=false;box.textContent=err.message;confirm.querySelector('.button').disabled=false;}
        };
      };
    }catch(err){if(revision===generation)error(err);}
  }
  if(initialSeriesId)edit(initialSeriesId);else list();
  return node;
}

const activeNavigations=new Set();
export function seriesNativeState(active){for(const update of activeNavigations)update(active);}

export function mountSeriesNavigation({node,body,item,api,esc,open,isCurrent,isActive=()=>!document.hidden,enabled=true,onEnabled=()=>{},beforeMove=async()=>{}}){
  const bar=document.createElement('nav');bar.className='series-reader-nav';bar.setAttribute('aria-label','シリーズ内の移動');bar.hidden=true;body.before(bar);
  const footer=document.createElement('div');footer.className='series-book-end';footer.hidden=true;
  const subscribers=new Set();let disposed=false,book=null,videoCleanup,signature='',pendingEnd;
  const alive=()=>!disposed && node.isConnected && node.open && isCurrent();
  const active=()=>alive() && isActive() && !document.hidden;
  const core=createSeriesContinuation({assetId:item.id,enabled,loadContext:()=>api(`/items/${item.id}/series`),isActive:active,changed:render,
    move:async(target,options,allowed)=>{
      await beforeMove();
      if(!active() || !allowed())return false;
      return new Promise(resolve=>{
        node.addEventListener('close',()=>{if(isCurrent() && isActive() && !document.hidden)open(target,options);resolve();},{once:true});
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
        bar.innerHTML=`<strong>${esc(series.title)}</strong><span>${currentIndex+1} / ${items.length} · ${esc(items[currentIndex].series.label)}</span><div><button class="button secondary series-prev">← 前のアセット</button><select aria-label="シリーズ内のアセット">${items.map((asset,index)=>`<option value="${esc(asset.id)}" ${index===currentIndex?'selected':''}>${index+1}. ${esc(asset.series.label)} ${esc(asset.title)}</option>`).join('')}</select><button class="button secondary series-next">次のアセット →</button></div><div class="series-continuation"><label><input type="checkbox" class="series-continuous">連続再生・閲覧</label><span class="series-continuation-status" role="status"></span><button type="button" class="text-button series-cancel" hidden>自動移動を停止</button><button type="button" class="text-button series-now" hidden>今すぐ次へ</button></div>`;
        const details=document.createElement('details'),summary=document.createElement('summary');summary.append(bar.querySelector('strong'),bar.querySelector('span'));details.append(summary,...bar.querySelectorAll(':scope > div'));bar.append(details);
        bar.querySelector('.series-prev').onclick=()=>core.navigate({direction:-1});
        bar.querySelector('.series-next').onclick=()=>core.navigate();
        bar.querySelector('select').onchange=e=>core.navigate({targetId:e.target.value});
        bar.querySelector('input').onchange=e=>{onEnabled(e.target.checked);core.setEnabled(e.target.checked);};
        bar.querySelector('.series-cancel').onclick=()=>core.cancel('今回の自動移動を停止しました。');
        bar.querySelector('.series-now').onclick=()=>core.navigate({continuous:true,autoplay:true});
      }
      if(countdown!==null || busy)bar.querySelector('details').open=true;
      bar.querySelector('.series-prev').disabled=busy || currentIndex===0;
      bar.querySelector('.series-next').disabled=busy || !next;
      bar.querySelector('select').disabled=busy;
      bar.querySelector('input').checked=enabled;
      bar.querySelector('.series-cancel').hidden=countdown===null && !busy;
      bar.querySelector('.series-now').hidden=countdown===null;
      bar.querySelector('.series-continuation-status').textContent=busy?'次のアセットの権限と続き位置を確認しています…':countdown!==null?`${countdown}秒後に「${next?.title??''}」へ進みます。`:message;
    }
    // Keep footer height stable during page re-render/resize to avoid a ResizeObserver loop.
    const lastPage=book && book.page===book.total;
    footer.hidden=!(lastPage && enabled && context?.series);
    if(!footer.hidden){
      if(!footer.isConnected)body.append(footer);
      footer.innerHTML=next?`<span>この本の最後のページです。次は「${esc(next.title)}」</span><button type="button" class="button secondary" ${canContinue && book.ready?'':'disabled'}>次のアセットへ読み進む</button>`:'<span>この本はシリーズの最後のアセットです。</span>';
      const button=footer.querySelector('button');if(button)button.onclick=()=>core.nextBook();
    }
    for(const subscriber of subscribers)subscriber();
  }
  const suspend=()=>{pendingEnd=null;core.cancel('自動移動を停止しました。次へ進むには操作してください。');};
  const nativeState=active=>{if(active)render();else suspend();};
  const visibility=()=>{if(document.hidden)suspend();else render();};
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
    get canContinue(){return core.state.canContinue;},
    subscribe(fn){subscribers.add(fn);fn();return()=>subscribers.delete(fn);},
    bookState(state){book=state;render();},
    nextBook:()=>core.nextBook(),
    cancel:()=>core.cancel(),
    bindVideo(video,{autoplay=false}={}){
      videoCleanup?.();
      const ended=()=>{if(!core.state.context)pendingEnd=video;else core.videoEnded();};
      const cancel=()=>{pendingEnd=null;core.cancel();};
      const failure=()=>core.cancel('動画のエラーにより連続再生を停止しました。');
      videoCleanup=bindContinuationVideo(video,{autoplay,canAutoplay:()=>active() && core.state.enabled,onEnded:ended,onReset:cancel,onError:failure,
        onBlocked:reason=>core.notify(reason==='policy'?'自動再生が制限されました。プレーヤーの再生ボタンを押してください。':'自動再生を停止しました。再生ボタンで開始してください。')});
    },
    dispose(){if(disposed)return;disposed=true;pendingEnd=null;core.dispose();videoCleanup?.();subscribers.clear();activeNavigations.delete(nativeState);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',suspend);}
  };
}
