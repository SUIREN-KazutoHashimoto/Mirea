import {seriesPathLabel} from './series-tree.js';
import {planUploads,validateUploadPlan,createUploadBatch} from './upload-batch.js';
import {folderUploadJobs,prepareFolderSeries} from './folder-upload.js';

import {nativeTransfersAvailable,NativeTransfer,requestTransferNotifications} from './native-transfers.js';
import {trackTransfer} from './transfer-manager.js';
export function openUploadDialog({dialog,api,upload,shelves,activeShelf,initialSeriesId,config,esc,bytes,icon,processingLabel,isCurrent,onChanged,toast}) {
  const node=dialog('コンテンツを追加',`<form class="modal-body upload-batch-form"><label>追加する本棚<select name="shelf">${shelves.map(s=>`<option value="${esc(s.id)}" ${s.id===activeShelf?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><div class="upload-series-target"><label>シリーズへの追加<select name="seriesId"><option value="">追加しない</option><option value="new">新しいシリーズを作成して追加</option></select></label><div class="upload-new-series" hidden><label>新しいシリーズ名<input name="seriesTitle" maxlength="200"></label><label>親シリーズ<select name="seriesParent"><option value="">なし（最上位）</option></select></label></div><small class="upload-series-note" role="status">追加先を読み込んでいます…</small></div><label class="dropzone" id="dropzone"><input name="file" type="file" aria-label="アップロードするファイル" accept="application/pdf,application/epub+zip,video/*,audio/*,image/jpeg,image/png,image/webp,.pdf,.epub,.mp4,.m4v,.mov,.mkv,.avi,.wmv,.asf,.mpeg,.mpg,.ts,.mts,.m2ts,.flv,.webm,.mp3,.m4a,.m4b,.aac,.wav,.flac,.ogg,.oga,.opus,.aif,.aiff,.wma,.weba,.jpg,.jpeg,.png,.webp" multiple required>${icon('upload')}<strong class="file-label">複数ファイルを選択、またはドロップ</strong><span>PDF・EPUB・動画・音声はファイルごとに追加。画像はまとめて1冊。</span><small>一括1,000ファイル · 1アセット ${bytes(config.maxUploadBytes)}まで</small></label><p class="upload-batch-note">送信完了後は、変換の終了を待たずに次のファイルを送ります。上限に達した送信はキューで待機します。メニューを閉じても送信・後処理を継続します。Androidでは通知に進捗を表示します（通知の許可が必要）。ブラウザー終了・OSの強制停止時は再開が必要です。</p><div class="upload-selection" hidden></div><label class="retain-original"><input name="retainOriginal" type="checkbox" checked>動画・音声の原本を保持する</label><p class="retention-note">初期設定では原本を保持します。チェックを外した場合のみ、全画質・サムネイルの生成と検証が成功した後に動画・音声の原本を削除します。失敗時と本の原本は残します。</p><div class="upload-progress" hidden><div><span class="upload-status" role="status"></span><span class="upload-percent">0%</span></div><progress max="100" value="0" aria-label="全体のアップロードの進行状況"></progress></div><p class="form-error" role="alert" hidden></p><div class="modal-actions upload-batch-actions"><button class="button secondary upload-reset" type="button" hidden>ファイルを選び直す</button><button class="button secondary upload-stop" type="button" hidden>未完了の送信を中止</button><button class="button primary" type="submit">${icon('upload')}アップロードする</button></div></form>`,'upload-batch-modal');
  const form=node.querySelector('form'),input=form.elements.file,zone=node.querySelector('#dropzone'),selection=node.querySelector('.upload-selection'),errorBox=node.querySelector('.form-error'),submit=form.querySelector('[type="submit"]'),reset=node.querySelector('.upload-reset'),stop=node.querySelector('.upload-stop'),progressBox=node.querySelector('.upload-progress'),status=node.querySelector('.upload-status');
  let requestedRetention=true,scanning=false,selectionLimit=100;
  let jobs=[],results=new Map(),activeBatch,running=false,frozen=false,disposed=false,targetShelf,targetSeries,seriesRows=[],seriesGeneration=0,seriesLoading=true,seriesError='',creation,folderMode=false,folderRecords=new Map(),folderTargets,selectedFolderFiles=[];
  input.required=false;
  const folderControls=document.createElement('div');folderControls.className='folder-upload-controls';folderControls.innerHTML='<button class="button secondary choose-upload-folder" type="button">フォルダを丸ごと選択</button><input type="file" name="folder" aria-label="アップロードするフォルダ" webkitdirectory multiple hidden><small class="upload-folder-note">フォルダはシリーズ、入れ子は子シリーズ、各ファイルは1アセットとして追加します。空フォルダは含みません。設定された件数上限・16階層。複数フォルダは繰り返し選択して追加できます。シリーズの選択は親の指定になります。</small>';zone.after(folderControls);
  const retain=node.querySelector('.retain-original'),retention=node.querySelector('.retention-note');
  node.querySelector('.upload-series-target').after(retain);retain.after(retention);retention.after(submit);folderControls.after(selection);
  node.classList.add('manager-upload');
  const destination=document.createElement('section'),filesSection=document.createElement('section');destination.className='upload-form-section';filesSection.className='upload-form-section';
  destination.innerHTML='<h3><span>1</span> 追加先と保存方法</h3>';filesSection.innerHTML='<h3><span>2</span> ファイルを選択</h3>';
  const shelfLabel=form.elements.shelf.closest('label'),seriesTarget=node.querySelector('.upload-series-target');form.insertBefore(destination,shelfLabel);destination.append(shelfLabel,seriesTarget,retain);
  const retentionHelp=document.createElement('details');retentionHelp.className='upload-help';retentionHelp.innerHTML='<summary>原本の取り扱い</summary>';retentionHelp.append(retention);destination.append(retentionHelp,submit,errorBox,progressBox);
  form.insertBefore(filesSection,zone);filesSection.append(zone,folderControls,selection);
  const transferHelp=document.createElement('details');transferHelp.className='upload-help';transferHelp.innerHTML='<summary>転送とサーバー後処理について</summary>';transferHelp.append(node.querySelector('.upload-batch-note'));filesSection.append(transferHelp);
  const folderInput=form.elements.folder,folderButton=folderControls.querySelector('button');
  const urls=new Map(),alive=()=>!disposed&&node.isConnected&&isCurrent();
  const scanStatus=document.createElement('p');scanStatus.className='upload-scan-status';scanStatus.setAttribute('role','status');scanStatus.setAttribute('aria-live','polite');scanStatus.hidden=true;zone.before(scanStatus);
  function scanningStatus(text){if(!alive())return;scanStatus.textContent=text;scanStatus.hidden=!text;}
  async function nativeScan(folders){scanning=true;controls();scanningStatus('アップロード候補を探しています…');let listener;
    try{listener=await NativeTransfer.addListener('folderScan',event=>scanningStatus('アップロード候補を探しています… '+(event.folders??0)+'フォルダ・'+(event.files??0)+'ファイル'));const result=await (folders?NativeTransfer.chooseFolder():NativeTransfer.chooseFiles());scanning=false;if(alive()&&result.files?.length)await select(result.files,folders);else scanningStatus('');}
    finally{scanning=false;await listener?.remove();if(alive())controls();}
  }
  if(nativeTransfersAvailable()){input.required=false;zone.addEventListener('click',async e=>{e.preventDefault();if(running||frozen||scanning)return;try{await nativeScan(false);}catch(error){if(alive()){errorBox.textContent=error.message;errorBox.hidden=false;}}});}
  folderButton.onclick=async()=>{if(running||frozen||scanning)return;if(!nativeTransfersAvailable()){scanningStatus('フォルダ選択後、アップロード候補を探します…');folderInput.click();return;}try{await nativeScan(true);}catch(error){if(alive()){errorBox.textContent='フォルダを選択できません。対応する最新版のアプリが必要です。 '+error.message;errorBox.hidden=false;}}};
  folderInput.onchange=()=>select(folderInput.files,true);
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
  form.elements.shelf.onchange=()=>{if(!frozen&&!running){targetShelf=undefined;targetSeries=undefined;creation=undefined;folderRecords=new Map();folderTargets=undefined;loadSeries();}};
  form.elements.seriesId.onchange=()=>{const show=form.elements.seriesId.value==='new';node.querySelector('.upload-new-series').hidden=!show;form.elements.seriesTitle.required=show;};
  const releaseImages=()=>{for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();};
  const cover=file=>{if(!urls.has(file))urls.set(file,URL.createObjectURL(file));return urls.get(file);};
  function controls(){form.querySelectorAll('input,select,.selection-action,.choose-upload-folder').forEach(el=>{el.disabled=running||frozen||scanning||el.dataset.unavailable==='true';});submit.disabled=running||scanning||seriesLoading;reset.disabled=running;stop.hidden=!running;reset.hidden=!frozen;}
  function progress(){
    if(!alive())return;
    const rows=jobs.map(job=>results.get(job.key)??{job,state:'queued',percent:0});
    for(const element of selection.querySelectorAll('[data-entry]')){
      const row=rows[Number(element.dataset.entry)];if(!row)continue;element.dataset.state=row.state;
      element.querySelector('.upload-entry-progress').value=row.percent;
      element.querySelector('.upload-entry-progress').hidden=!frozen;
      element.querySelector('.upload-entry-status').textContent=row.state==='complete'?(row.warning||'追加完了'):row.state==='processing'?processingLabel(row.processing??{})+'（サーバー処理中）':row.state==='failed'?row.error:row.state==='detached'?'サーバーで後処理を継続中':row.state==='cancelled'?'送信を中止しました':row.state==='uploading'?`分割送信中 · ${row.percent}%`:frozen?'順番待ち':'';
    }
    const total=jobs.reduce((n,j)=>n+j.files.reduce((size,f)=>size+f.size,0),0),sent=rows.reduce((n,row)=>n+row.job.files.reduce((size,f)=>size+f.size,0)*row.percent/100,0),percent=total?Math.floor(sent/total*100):0;
    progressBox.querySelector('progress').value=percent;node.querySelector('.upload-percent').textContent=percent+'%';
    const complete=rows.filter(r=>r.state==='complete').length,failed=rows.filter(r=>r.state==='failed').length,active=rows.filter(r=>['uploading','processing'].includes(r.state)).length;
    const acceptedCount=rows.filter(r=>['complete','processing'].includes(r.state)).length;
    status.textContent=`送信済み ${acceptedCount} / ${jobs.length}件 · サーバー後処理 ${rows.filter(r=>r.state==='processing').length}件 · 失敗 ${failed}件${acceptedCount===jobs.length?' · タブを閉じても処理は続きます。':''}`;
  }
  function render(){
    selection.hidden=!jobs.length;node.querySelector('.file-label').textContent=jobs.length?`${jobs.length}アセット · ${jobs.reduce((n,j)=>n+j.files.length,0)}ファイルを選択中`:'複数ファイルを選択、またはドロップ';
    selection.innerHTML=`<ol class="upload-entry-list">${jobs.slice(0,selectionLimit).map((job,index)=>`<li class="upload-entry" data-entry="${index}"><div class="upload-entry-heading"><strong>${job.imageBook?`画像の本 · ${job.files.length}ページ`:esc(job.files[0].name)}</strong><button type="button" class="icon-button selection-action" data-remove-entry="${index}" aria-label="${esc(job.title)}を選択から除く">${icon('close')}</button></div><label>タイトル<input data-entry-title="${index}" value="${esc(job.title)}" maxlength="200" required></label><small>${bytes(job.files.reduce((n,f)=>n+f.size,0))}${job.imageBook?' · 上からページ順。先頭が表紙です。':''}</small>${job.imageBook?`<ol class="page-order-list">${job.files.map((file,page)=>`<li>${file.nativeId?'':`<img src="${cover(file)}" alt="${page+1}ページ目" loading="lazy">`}<span class="page-order-name">${esc(file.name)}</span><button class="icon-button selection-action" type="button" data-page-entry="${index}" data-page-up="${page}" data-unavailable="${page===0}" aria-label="${page+1}ページ目を前へ" ${page===0?'disabled':''}>↑</button><button class="icon-button selection-action" type="button" data-page-entry="${index}" data-page-down="${page}" data-unavailable="${page===job.files.length-1}" aria-label="${page+1}ページ目を後ろへ" ${page===job.files.length-1?'disabled':''}>↓</button><button class="icon-button selection-action" type="button" data-page-entry="${index}" data-page-remove="${page}" aria-label="${page+1}ページ目を取り除く">${icon('close')}</button></li>`).join('')}</ol>`:''}<progress class="upload-entry-progress" max="100" value="0" aria-label="${esc(job.title)}のアップロード進捗" hidden></progress><p class="upload-entry-status" role="status"></p></li>`).join('')}</ol>${jobs.length>selectionLimit?'<button type="button" class="button secondary upload-show-more">次の100件を表示</button>':''}`;
    selection.querySelector('.upload-show-more')?.addEventListener('click',()=>{selectionLimit+=100;render();});
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
  async function select(files,folders=false){if(running||frozen||scanning)return;scanning=true;controls();scanningStatus('アップロード候補を確認しています…');await new Promise(resolve=>setTimeout(resolve,0));if(!alive()){scanning=false;return;}try{const chosen=folders?[...(folderMode?selectedFolderFiles:[]),...Array.from(files)]:[];const next=folders?folderUploadJobs(chosen,planUploads):planUploads(files);selectedFolderFiles=chosen;selectionLimit=100;releaseImages();folderMode=folders;jobs=next;folderRecords=new Map();folderTargets=undefined;results.clear();errorBox.hidden=true;render();if(folders)selection.querySelectorAll('.upload-entry-heading strong').forEach((el,index)=>el.textContent=jobs[index].relativePath);}catch(error){errorBox.textContent=error.message;errorBox.hidden=false;}finally{scanning=false;scanningStatus(jobs.length?`${jobs.length}アセット・${jobs.reduce((n,j)=>n+j.files.length,0)}ファイルの候補を確認しました。`:'');if(alive())controls();}}
  input.onchange=()=>select(input.files);
  zone.ondragover=e=>{e.preventDefault();if(!running&&!frozen)zone.classList.add('dragover');};zone.ondragleave=()=>zone.classList.remove('dragover');
  zone.ondrop=e=>{e.preventDefault();zone.classList.remove('dragover');if(!running&&!frozen&&e.dataTransfer.files.length){input.files=e.dataTransfer.files;select(e.dataTransfer.files);}};
  reset.onclick=()=>{if(running)return;frozen=false;targetShelf=undefined;targetSeries=undefined;creation=undefined;folderMode=false;folderRecords=new Map();folderTargets=undefined;jobs=[];results.clear();releaseImages();input.value='';folderInput.value='';progressBox.hidden=true;errorBox.hidden=true;submit.textContent='アップロードする';render();};
  stop.onclick=cancelBatch;
  async function refreshUploadStates(){
    if(!isCurrent())return;
    const ids=[...new Set([...results.values()].map(row=>row.uploadId).filter(Boolean))];
    if(ids.length&&(config.uploadProtocol??1)>=2){const response=await api('/uploads/status',{method:'POST',body:{ids}});if(!isCurrent())return;for(const status of response.uploads){const row=[...results.values()].find(row=>row.uploadId===status.id);if(row){row.state=status.state;row.item=status.item;row.processing=status.processing;row.error=status.error??'';}}}
  }
  async function cancelBatch(){
    await refreshUploadStates();if(!isCurrent())return;
    const completed=[...results.values()].filter(r=>r.state==='complete'&&r.item);
    if(!confirm('この転送の未完了アップロードと後処理を中止し、原本を削除しますか？'))return;
    const deleteCompleted=completed.length&&confirm('完了済みの'+completed.length+'アセットも削除しますか？（キャンセルを選ぶと完了分は残します）');
    activeBatch?.cancel();
    for(const row of results.values())if(isCurrent()&&row.uploadId&&row.state!=='complete')await api(row.item?'/items/'+row.item.id:'/uploads/'+row.uploadId,{method:'DELETE'}).catch(()=>{});
    if(deleteCompleted)for(const row of completed)if(isCurrent())await api('/items/'+row.item.id,{method:'DELETE'});
    for(const record of [...folderRecords.values()].reverse())if(isCurrent()&&record.created&&record.id){try{const info=await api('/series/'+record.id);await api('/series/'+record.id,{method:'DELETE',body:{revision:info.series.revision,onlyIfEmpty:true}});}catch{/* Reused/nonempty/concurrently changed series are never removed. */}}
    await onChanged();
  }
  function openDetails(){
    const details=dialog('コンテンツを追加（転送の詳細）','<div class="modal-body"><p class="upload-detail-context"></p><div class="upload-detail-list"></div><button class="button secondary upload-detail-refresh" type="button">後処理の状態を更新</button><button class="button danger upload-detail-cancel" type="button">アップロードをキャンセル</button></div>','upload-batch-modal');
    const update=()=>{details.querySelector('.upload-detail-context').textContent=(shelves.find(s=>s.id===targetShelf)?.name??'本棚')+' · '+(requestedRetention?'原本を保持':'変換成功後に原本を削除');details.querySelector('.upload-detail-list').innerHTML=jobs.map(job=>{const row=results.get(job.key);return `<section class="transfer-row"><strong>${esc(job.title)}</strong><small>${esc(job.relativePath??job.files.map(f=>f.name).join(' / '))} · ${bytes(job.files.reduce((n,f)=>n+f.size,0))}</small><p>${esc(row?.error||row?.warning||({complete:'追加完了',failed:'失敗',cancelled:'キャンセル',processing:processingLabel(row?.processing),uploading:'送信中',queued:'順番待ち'}[row?.state]??'準備中'))}</p><progress max="100" value="${row?.percent??0}"></progress></section>`;}).join('');};
    const refresh=async()=>{const button=details.querySelector('.upload-detail-refresh');button.disabled=true;try{await refreshUploadStates();if(details.isConnected)update();}catch(error){toast(error.message);}finally{button.disabled=false;}};details.querySelector('.upload-detail-refresh').onclick=refresh;refresh();
    details.querySelector('.upload-detail-cancel').onclick=()=>cancelBatch().catch(error=>toast(error.message));window.addEventListener('mirea:transferchange',update);details.addEventListener('close',()=>window.removeEventListener('mirea:transferchange',update),{once:true});update();return details;
  }
  node.addEventListener('close',()=>{disposed=true;releaseImages();if(isCurrent())onChanged().catch(()=>{});},{once:true});
  form.onsubmit=async event=>{
    event.preventDefault();if(running||scanning||!alive()||seriesLoading)return;errorBox.hidden=true;
    const validation=validateUploadPlan(jobs,config);if(validation){errorBox.textContent=validation;errorBox.hidden=false;return;}
    const pending=jobs.filter(job=>!['complete','processing'].includes(results.get(job.key)?.state));if(!pending.length)return;
    const requested={shelf:form.elements.shelf.value,choice:form.elements.seriesId.value,title:form.elements.seriesTitle.value.trim(),parentId:form.elements.seriesParent.value||null,retainOriginal:form.elements.retainOriginal.checked};
    requestedRetention=requested.retainOriginal;running=true;controls();
    try{
      await requestTransferNotifications();
      if(!isCurrent())return;
      if(seriesError)throw Error(seriesError);
      targetShelf??=requested.shelf;
      frozen=true;
      if(targetSeries===undefined){
        const choice=requested.choice;
        if(choice==='new'){
          const values={title:requested.title,parentId:requested.parentId};
          if(!values.title)throw Error('新しいシリーズ名を入力してください。');
          const key=JSON.stringify([targetShelf,values]);if(creation?.key!==key)creation={key,requestId:crypto.randomUUID()};
          const created=await api(`/shelves/${targetShelf}/series`,{method:'POST',body:{...values,requestId:creation.requestId}});
          if(!isCurrent())return;targetSeries=created.series.id;
        }else targetSeries=choice||null;
      }
      if(alive()){controls();progressBox.hidden=false;}
      if(folderMode)folderTargets=await prepareFolderSeries(jobs,{api,shelfId:targetShelf,parentId:targetSeries,records:folderRecords,isCurrent,onProgress:({done,total,path})=>scanningStatus(`追加先のシリーズを準備しています… ${done}/${total}${path?' · '+path:''}`)});scanningStatus('');
      // Keep at least one slot for resuming our own interrupted sessions, which
      // already count toward the server limit. A definitive 429 stops the queue.
      const concurrency=config.maxConcurrentUploads??3;
      const transfer=trackTransfer({direction:'upload',title:pending.length+'件のコンテンツ',completeMessage:'送信完了 · 後処理はサーバーで継続',notifications:!nativeTransfersAvailable(),cancel:cancelBatch,stop:()=>activeBatch?.cancel({detachProcessing:true}),open:openDetails,work:update=>{
        activeBatch=createUploadBatch(pending.map(job=>({...job,title:job.title.trim(),files:[...job.files]})),{concurrency:nativeTransfersAvailable()?pending.length:concurrency,eager:nativeTransfersAvailable(),progressIntervalMs:100,isCurrent,
          start:(job,onProgress)=>upload(targetShelf,job.files,job.title,onProgress,{retainOriginal:requested.retainOriginal,seriesId:folderMode?folderTargets.get(job.key):targetSeries,protocolVersion:config.uploadProtocol??1,monitorProcessing:false}),
          changed:rows=>{for(const row of rows)results.set(row.job.key,row);const percent=rows.reduce((n,r)=>n+r.percent,0)/Math.max(1,rows.length);update({percent,message:rows.filter(r=>r.state==='complete').length+' / '+rows.length+'件完了'});progress();}});
        activeBatch.promise.catch(()=>{});
        return activeBatch.transferred.then(result=>{if(result.cancelled)throw new DOMException('転送を一時停止しました。','AbortError');if(result.rows.some(r=>r.state==='failed'))throw Error(result.rows.filter(r=>r.state==='failed').length+'件のアップロードに失敗しました。アップロード処理から確認できます。');return result;});
      }});
      const result=await transfer.promise;activeBatch=null;if(!isCurrent())return;
      if(result.halted&&alive()){errorBox.textContent='権限または同時処理上限により、新しい送信を停止しました。アップロード処理と接続状態を確認し、未完了分を再試行してください。';errorBox.hidden=false;}
      if(jobs.every(job=>['complete','processing'].includes(results.get(job.key)?.state))){const warnings=[...results.values()].filter(row=>row.warning);if(alive())node.close();await onChanged();toast(`${jobs.length}件の送信が完了しました。変換などの後処理はサーバーで継続します。タブを閉じてもかまいません。${warnings.length?' '+warnings.length+'件はシリーズへの追加先を確認してください。':''}`);}
      else await onChanged();
    }catch(error){if(alive()){errorBox.textContent=error.message;errorBox.hidden=false;}}
    finally{running=false;if(alive()){submit.textContent=frozen?'未完了だけ再試行':'アップロードする';controls();progress();}}
  };
  loadSeries();return node;
}
