import {seriesPathLabel} from './series-tree.js';
import {planUploads,validateUploadPlan,createUploadBatch} from './upload-batch.js';

export function openUploadDialog({dialog,api,upload,shelves,activeShelf,initialSeriesId,config,esc,bytes,icon,processingLabel,isCurrent,onChanged,toast}) {
  const node=dialog('コンテンツを追加',`<form class="modal-body upload-batch-form"><label>追加する本棚<select name="shelf">${shelves.map(s=>`<option value="${esc(s.id)}" ${s.id===activeShelf?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><div class="upload-series-target"><label>シリーズへの追加<select name="seriesId"><option value="">追加しない</option><option value="new">新しいシリーズを作成して追加</option></select></label><div class="upload-new-series" hidden><label>新しいシリーズ名<input name="seriesTitle" maxlength="200"></label><label>親シリーズ<select name="seriesParent"><option value="">なし（最上位）</option></select></label></div><small class="upload-series-note" role="status">追加先を読み込んでいます…</small></div><label class="dropzone" id="dropzone"><input name="file" type="file" aria-label="アップロードするファイル" accept="application/pdf,application/epub+zip,video/*,audio/*,image/jpeg,image/png,image/webp,.pdf,.epub,.mp4,.m4v,.mov,.mkv,.avi,.wmv,.asf,.mpeg,.mpg,.ts,.mts,.m2ts,.flv,.webm,.mp3,.m4a,.m4b,.aac,.wav,.flac,.ogg,.oga,.opus,.aif,.aiff,.wma,.weba,.jpg,.jpeg,.png,.webp" multiple required>${icon('upload')}<strong class="file-label">複数ファイルを選択、またはドロップ</strong><span>PDF・EPUB・動画・音声はファイルごとに追加。画像はまとめて1冊。</span><small>混在選択OK · 1アセット ${bytes(config.maxUploadBytes)}まで</small></label><p class="upload-batch-note">最大3件を並行して分割送信・後処理し、残りは順番待ちします。既存の処理がある場合は並行数を調整します。画面を閉じると未送信分と送信中の転送を中止し、サーバーでの後処理は継続します。</p><div class="upload-selection" hidden></div><label class="retain-original"><input name="retainOriginal" type="checkbox" checked>動画・音声の原本を保持する</label><p class="retention-note">初期設定では原本を保持します。チェックを外した場合のみ、全画質・サムネイルの生成と検証が成功した後に動画・音声の原本を削除します。失敗時と本の原本は残します。</p><div class="upload-progress" hidden><div><span class="upload-status" role="status"></span><span class="upload-percent">0%</span></div><progress max="100" value="0" aria-label="全体のアップロードの進行状況"></progress></div><p class="form-error" role="alert" hidden></p><div class="modal-actions upload-batch-actions"><button class="button secondary upload-reset" type="button" hidden>ファイルを選び直す</button><button class="button secondary upload-stop" type="button" hidden>未完了の送信を中止</button><button class="button primary" type="submit">${icon('upload')}アップロードする</button></div></form>`,'upload-batch-modal');
  const form=node.querySelector('form'),input=form.elements.file,zone=node.querySelector('#dropzone'),selection=node.querySelector('.upload-selection'),errorBox=node.querySelector('.form-error'),submit=form.querySelector('[type="submit"]'),reset=node.querySelector('.upload-reset'),stop=node.querySelector('.upload-stop'),progressBox=node.querySelector('.upload-progress'),status=node.querySelector('.upload-status');
  let jobs=[],results=new Map(),activeBatch,running=false,frozen=false,disposed=false,targetShelf,targetSeries,seriesRows=[],seriesGeneration=0,seriesLoading=true,seriesError='',creation;
  const urls=new Map(),alive=()=>!disposed&&node.isConnected&&isCurrent();
  async function loadSeries(){
    const generation=++seriesGeneration;seriesLoading=true;seriesError='';submit.disabled=true;
    try{const response=await api(`/shelves/${form.elements.shelf.value}/series`);if(!alive()||generation!==seriesGeneration)return;
      seriesRows=response.series??[];
      form.elements.seriesId.innerHTML='<option value="">追加しない</option><option value="new">新しいシリーズを作成して追加</option>'+seriesRows.map(s=>`<option value="${esc(s.id)}" ${s.id===initialSeriesId?'selected':''}>${esc(seriesPathLabel(seriesRows,s.id))}</option>`).join('');
      form.elements.seriesParent.innerHTML='<option value="">なし（最上位）</option>'+seriesRows.map(s=>`<option value="${esc(s.id)}">${esc(seriesPathLabel(seriesRows,s.id))}</option>`).join('');
      node.querySelector('.upload-series-note').textContent='選んだ全作品を後処理の完了順で末尾に追加します。追加先が削除された場合は単独で保存します。';
    }catch(error){if(alive()&&generation===seriesGeneration){seriesError=error.message;node.querySelector('.upload-series-note').textContent='シリーズを取得できません。追加先の本棚を選び直してください。';}}
    finally{if(generation===seriesGeneration){seriesLoading=false;if(alive())controls();}}
  }
  form.elements.shelf.onchange=()=>{if(!frozen&&!running){targetShelf=undefined;targetSeries=undefined;creation=undefined;loadSeries();}};
  form.elements.seriesId.onchange=()=>{const show=form.elements.seriesId.value==='new';node.querySelector('.upload-new-series').hidden=!show;form.elements.seriesTitle.required=show;};
  const releaseImages=()=>{for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();};
  const cover=file=>{if(!urls.has(file))urls.set(file,URL.createObjectURL(file));return urls.get(file);};
  function controls(){form.querySelectorAll('input,select,.selection-action').forEach(el=>{el.disabled=running||frozen||el.dataset.unavailable==='true';});submit.disabled=running||seriesLoading;reset.disabled=running;stop.hidden=!running;reset.hidden=!frozen;}
  function progress(){
    if(!alive())return;
    const rows=jobs.map(job=>results.get(job.key)??{job,state:'queued',percent:0});
    for(const [index,row]of rows.entries()){
      const element=selection.querySelector(`[data-entry="${index}"]`);if(!element)continue;element.dataset.state=row.state;
      element.querySelector('.upload-entry-progress').value=row.percent;
      element.querySelector('.upload-entry-progress').hidden=!frozen;
      element.querySelector('.upload-entry-status').textContent=row.state==='complete'?(row.warning||'追加完了'):row.state==='processing'?processingLabel(row.processing??{})+'（サーバー処理中）':row.state==='failed'?row.error:row.state==='detached'?'サーバーで後処理を継続中':row.state==='cancelled'?'送信を中止しました':row.state==='uploading'?`分割送信中 · ${row.percent}%`:frozen?'順番待ち':'';
    }
    const total=jobs.reduce((n,j)=>n+j.files.reduce((size,f)=>size+f.size,0),0),sent=rows.reduce((n,row)=>n+row.job.files.reduce((size,f)=>size+f.size,0)*row.percent/100,0),percent=total?Math.floor(sent/total*100):0;
    progressBox.querySelector('progress').value=percent;node.querySelector('.upload-percent').textContent=percent+'%';
    const complete=rows.filter(r=>r.state==='complete').length,failed=rows.filter(r=>r.state==='failed').length,active=rows.filter(r=>['uploading','processing'].includes(r.state)).length;
    status.textContent=`追加完了 ${complete} / ${jobs.length}件 · 処理中 ${active}件 · 失敗 ${failed}件${!running?' · 未完了だけ再試行できます。':''}`;
  }
  function render(){
    selection.hidden=!jobs.length;node.querySelector('.file-label').textContent=jobs.length?`${jobs.length}アセット · ${jobs.reduce((n,j)=>n+j.files.length,0)}ファイルを選択中`:'複数ファイルを選択、またはドロップ';
    selection.innerHTML=`<ol class="upload-entry-list">${jobs.map((job,index)=>`<li class="upload-entry" data-entry="${index}"><div class="upload-entry-heading"><strong>${job.imageBook?`画像の本 · ${job.files.length}ページ`:esc(job.files[0].name)}</strong><button type="button" class="icon-button selection-action" data-remove-entry="${index}" aria-label="${esc(job.title)}を選択から除く">${icon('close')}</button></div><label>タイトル<input data-entry-title="${index}" value="${esc(job.title)}" maxlength="200" required></label><small>${bytes(job.files.reduce((n,f)=>n+f.size,0))}${job.imageBook?' · 上からページ順。先頭が表紙です。':''}</small>${job.imageBook?`<ol class="page-order-list">${job.files.map((file,page)=>`<li><img src="${cover(file)}" alt="${page+1}ページ目" loading="lazy"><span class="page-order-name">${esc(file.name)}</span><button class="icon-button selection-action" type="button" data-page-entry="${index}" data-page-up="${page}" data-unavailable="${page===0}" aria-label="${page+1}ページ目を前へ" ${page===0?'disabled':''}>↑</button><button class="icon-button selection-action" type="button" data-page-entry="${index}" data-page-down="${page}" data-unavailable="${page===job.files.length-1}" aria-label="${page+1}ページ目を後ろへ" ${page===job.files.length-1?'disabled':''}>↓</button><button class="icon-button selection-action" type="button" data-page-entry="${index}" data-page-remove="${page}" aria-label="${page+1}ページ目を取り除く">${icon('close')}</button></li>`).join('')}</ol>`:''}<progress class="upload-entry-progress" max="100" value="0" aria-label="${esc(job.title)}のアップロード進捗" hidden></progress><p class="upload-entry-status" role="status"></p></li>`).join('')}</ol>`;
    selection.querySelectorAll('[data-entry-title]').forEach(field=>field.oninput=()=>{jobs[Number(field.dataset.entryTitle)].title=field.value;});
    selection.querySelectorAll('[data-remove-entry]').forEach(button=>button.onclick=()=>{jobs.splice(Number(button.dataset.removeEntry),1);if(!jobs.length)input.value='';render();});
    selection.querySelectorAll('[data-page-entry]').forEach(button=>button.onclick=()=>{
      const entry=Number(button.dataset.pageEntry),job=jobs[entry],page=Number(button.dataset.pageUp??button.dataset.pageDown??button.dataset.pageRemove);
      if(button.dataset.pageRemove!==undefined){const[file]=job.files.splice(page,1);if(urls.has(file)){URL.revokeObjectURL(urls.get(file));urls.delete(file);}if(!job.files.length)jobs.splice(entry,1);if(!jobs.length)input.value='';}
      else{const next=page+(button.dataset.pageUp!==undefined?-1:1);if(next>=0&&next<job.files.length)[job.files[page],job.files[next]]=[job.files[next],job.files[page]];}
      render();
    });
    controls();progress();
  }
  function select(files){if(running||frozen)return;releaseImages();jobs=planUploads(files);results.clear();errorBox.hidden=true;render();}
  input.onchange=()=>select(input.files);
  zone.ondragover=e=>{e.preventDefault();if(!running&&!frozen)zone.classList.add('dragover');};zone.ondragleave=()=>zone.classList.remove('dragover');
  zone.ondrop=e=>{e.preventDefault();zone.classList.remove('dragover');if(!running&&!frozen&&e.dataTransfer.files.length){input.files=e.dataTransfer.files;select(e.dataTransfer.files);}};
  reset.onclick=()=>{if(running)return;frozen=false;targetShelf=undefined;targetSeries=undefined;creation=undefined;jobs=[];results.clear();releaseImages();input.value='';progressBox.hidden=true;errorBox.hidden=true;submit.textContent='アップロードする';render();};
  stop.onclick=()=>activeBatch?.cancel();
  node.addEventListener('close',()=>{disposed=true;activeBatch?.cancel();releaseImages();if(isCurrent())onChanged().catch(()=>{});},{once:true});
  form.onsubmit=async event=>{
    event.preventDefault();if(running||!alive()||seriesLoading)return;errorBox.hidden=true;
    const validation=validateUploadPlan(jobs,config);if(validation){errorBox.textContent=validation;errorBox.hidden=false;return;}
    const pending=jobs.filter(job=>results.get(job.key)?.state!=='complete');if(!pending.length)return;
    running=true;controls();
    try{
      const existing=await api('/uploads');if(!alive())return;
      if(seriesError)throw Error(seriesError);
      targetShelf??=form.elements.shelf.value;
      if(targetSeries===undefined){
        const choice=form.elements.seriesId.value;
        if(choice==='new'){
          const values={title:form.elements.seriesTitle.value.trim(),parentId:form.elements.seriesParent.value||null};
          if(!values.title)throw Error('新しいシリーズ名を入力してください。');
          const key=JSON.stringify([targetShelf,values]);if(creation?.key!==key)creation={key,requestId:crypto.randomUUID()};
          const created=await api(`/shelves/${targetShelf}/series`,{method:'POST',body:{...values,requestId:creation.requestId}});
          if(!alive())return;targetSeries=created.series.id;
        }else targetSeries=choice||null;
      }
      frozen=true;controls();progressBox.hidden=false;
      // Keep at least one slot for resuming our own interrupted sessions, which
      // already count toward the server limit. A definitive 429 stops the queue.
      const concurrency=Math.max(1,3-(existing.uploads?.length??0));
      activeBatch=createUploadBatch(pending.map(job=>({...job,title:job.title.trim(),files:[...job.files]})),{concurrency,isCurrent:alive,
        start:(job,onProgress)=>upload(targetShelf,job.files,job.title,onProgress,{retainOriginal:form.elements.retainOriginal.checked,seriesId:targetSeries}),
        changed:rows=>{for(const row of rows)results.set(row.job.key,row);progress();}});
      const result=await activeBatch.promise;activeBatch=null;if(!alive())return;
      if(result.halted){errorBox.textContent='権限または同時処理上限により、新しい送信を停止しました。アップロード処理と接続状態を確認し、未完了分を再試行してください。';errorBox.hidden=false;}
      if(jobs.every(job=>results.get(job.key)?.state==='complete')){const warnings=[...results.values()].filter(row=>row.warning);node.close();await onChanged();toast(`${jobs.length}件のコンテンツを追加しました。${warnings.length?' '+warnings.length+'件はシリーズへ追加できず、単独で保存しました。':''}`);}
      else await onChanged();
    }catch(error){if(alive()){errorBox.textContent=error.message;errorBox.hidden=false;}}
    finally{running=false;if(alive()){submit.textContent=frozen?'未完了だけ再試行':'アップロードする';controls();progress();}}
  };
  loadSeries();return node;
}
