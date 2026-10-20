const mediaKinds=['thumbnail','preview','transcode'];
const states={queued:'待機中',running:'実行中',processing:'処理中',uploading:'受信中',complete:'完了',failed:'失敗',cancelled:'取消'};
const names={thumbnail:'表紙',preview:'動画プレビュー',transcode:'動画トランスコード',backup_metadata:'メタデータバックアップ',backup_full:'全体バックアップ'};
const warning='CPU・ディスクを使用して再実行します。既存の配信と端末ダウンロードは保持します。原本がなければ、残っている最高品質のデータを原本代用にして再圧縮します。失われた画質は復元できません。';
export async function mountAdminJobs({panel,api,esc,bytes,confirm,valid,status}){
  const selected=new Map();let cursor='',jobSignature='';
  panel.innerHTML=`<h3>ジョブと動画の再トランスコード</h3><p class="muted">${warning} 古い動画で固定画質が選べない場合は、動画トランスコードを実行して配信画質を生成してください。</p><form class="admin-toolbar asset-search"><input name="q" aria-label="アセット検索" placeholder="タイトルで検索"><button class="button secondary">検索</button></form><div class="admin-assets"></div><button class="button secondary next-assets" hidden>次の100件</button><h4>ジョブ（最新100件ずつ）</h4><div class="admin-toolbar"><button class="button secondary select-jobs">表示中の再実行可能ジョブを選択</button><button class="button secondary clear-jobs">選択解除</button><button class="button primary retry-jobs" disabled>選択したジョブを一括再実行</button><span class="selected-jobs" role="status">0件選択 · 一度に20件まで</span></div><div class="admin-job-list"></div>`;
  const list=panel.querySelector('.admin-job-list'),search=panel.querySelector('.asset-search'),count=panel.querySelector('.selected-jobs'),bulk=panel.querySelector('.retry-jobs');let visible=[];
  const update=()=>{count.textContent=selected.size+'件選択 · 一度に20件まで';bulk.disabled=!selected.size||selected.size>20;list.querySelectorAll('[data-select-job]').forEach(b=>{b.checked=selected.has(b.dataset.selectJob);});};
  const individual=(id,kind)=>confirm((names[kind]??kind)+'を再実行',warning,'',()=>api(`/admin/assets/${id}/regenerate`,{method:'POST',body:{kind,acknowledgeCost:true}}),{password:false});
  function choice(row,type){return row.automatic?{id:row.assetId,type:'asset',kind:row.kind}:{id:row.id,type};}
  async function loadJobs(){
    const data=await api('/admin/jobs');if(!valid())return;
    const nextSignature=data.jobs.map(j=>j.id+':'+j.state).join('|');
    if(jobSignature&&jobSignature!==nextSignature)await loadAssets();jobSignature=nextSignature;if(!valid())return;
    const rows=[...data.jobs,...data.uploads.map(row=>({...row,upload:true})),...data.previews,...data.thumbnails,...(data.processors??[])];visible=[];
    list.innerHTML=rows.map(row=>{
      const retry=row.upload?row.state==='failed'&&row.retryable:mediaKinds.includes(row.kind)&&['complete','failed'].includes(row.state)&&row.assetId;
      const key=(row.upload?'upload:':row.automatic?'asset:'+row.kind+':':'job:')+row.id;if(retry)visible.push([key,choice(row,row.upload?'upload':'job')]);
      const value=row.progress??row.processing??{};
      return `<article class="admin-card"><div class="admin-card-title"><strong>${esc(row.title??names[row.kind]??row.kind??'処理')}</strong><span>${esc(states[row.state]??row.state??'')}</span></div><small>${esc(row.id??'')}${row.assetId?' · '+esc(row.assetId):''}</small>${value.stage?`<small>${esc(value.stage)} · ${Math.round(value.percent??0)}%</small>`:''}${value.source?`<small>変換元：${value.source==='original'?'保持原本':'最高品質の原本代用'} ${esc(value.sourceQuality??'')}</small>`:''}${row.error?`<p>${esc(row.error)}</p>`:''}${retry?`<div class="admin-actions"><label class="confirm-row"><input type="checkbox" data-select-job="${esc(key)}">一括再実行の対象</label><button class="button secondary" data-retry-one="${esc(key)}">再実行</button></div>`:''}</article>`;
    }).join('')||'<p>処理はありません。</p>';
    const available=new Map(visible);for(const key of selected.keys())if(!available.has(key))selected.delete(key);
    list.querySelectorAll('[data-select-job]').forEach(b=>b.onchange=()=>{if(b.checked){if(selected.size>=20){b.checked=false;status('一度に20件まで選択してください。');return;}selected.set(b.dataset.selectJob,available.get(b.dataset.selectJob));}else selected.delete(b.dataset.selectJob);update();});
    list.querySelectorAll('[data-retry-one]').forEach(b=>b.onclick=()=>{const entry=available.get(b.dataset.retryOne);if(entry.type==='upload')confirm('失敗したアップロードを再実行',warning,'',()=>api(`/admin/uploads/${entry.id}/retry`,{method:'POST',body:{acknowledgeCost:true}}),{password:false});else if(entry.type==='asset')individual(entry.id,entry.kind);else{const row=data.jobs.find(r=>r.id===entry.id);individual(row.assetId,row.kind);}});update();
  }
  panel.querySelector('.select-jobs').onclick=()=>{for(const [key,entry] of visible){if(selected.size>=20)break;selected.set(key,entry);}update();};
  panel.querySelector('.clear-jobs').onclick=()=>{selected.clear();update();};
  bulk.onclick=()=>{const jobs=[...selected.values()];confirm(jobs.length+'件のジョブを一括再実行',warning+' 処理中・対象削除済み・同じアセットの重複・キュー上限に達したジョブは除外し、結果を表示します。','',async()=>{
    const result=await api('/admin/jobs/retry',{method:'POST',body:{acknowledgeCost:true,jobs}});const accepted=result.results.filter(r=>r.accepted).length;
    return {message:`${accepted}件を受け付け、${result.results.length-accepted}件を除外しました。`+result.results.filter(r=>!r.accepted).map(r=>r.error).join(' / ')};
  },{password:false});};
  async function loadAssets(append=false){
    const data=await api('/admin/assets?q='+encodeURIComponent(search.elements.q.value)+(append&&cursor?'&after='+cursor:''));if(!valid())return;cursor=data.nextCursor;const box=panel.querySelector('.admin-assets');if(!append)box.innerHTML='';
    box.insertAdjacentHTML('beforeend',data.assets.map(item=>`<article class="admin-card"><strong>${esc(item.title)}</strong><small>${esc(item.shelf)} · ${esc(item.mimeType)}</small>${item.mimeType.startsWith('video/')?`<small>${item.hasHls?'HLS配信あり':'HLS未生成'} · ${item.originalRetained?'原本保持 ON':'最高品質の既存データを原本代用に使用'}</small>`:''}<div class="admin-actions"><button class="button secondary" data-asset="${esc(item.id)}" data-kind="thumbnail">表紙を再生成</button>${item.mimeType.startsWith('video/')?`<button class="button secondary" data-asset="${esc(item.id)}" data-kind="preview">プレビューを再生成</button><button class="button primary" data-asset="${esc(item.id)}" data-kind="transcode">動画を再トランスコード</button>`:''}</div></article>`).join('')||'<p>見つかりません。</p>');
    box.querySelectorAll('[data-asset]').forEach(b=>b.onclick=()=>individual(b.dataset.asset,b.dataset.kind));panel.querySelector('.next-assets').hidden=!cursor;
  }
  search.onsubmit=event=>{event.preventDefault();loadAssets().catch(status);};panel.querySelector('.next-assets').onclick=()=>loadAssets(true).catch(status);
  await Promise.all([loadJobs(),loadAssets()]);return loadJobs;
}
