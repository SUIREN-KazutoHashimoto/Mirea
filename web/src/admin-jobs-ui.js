import {partitionJobs,jobStateClass} from './job-presentation.js';
const states={queued:'待機中',running:'実行中',processing:'処理中',uploading:'受信中',complete:'完了',failed:'失敗',cancelled:'取消'};
const names={thumbnail:'表紙',preview:'動画プレビュー',transcode:'動画トランスコード',backup_metadata:'メタデータバックアップ',backup_full:'全体バックアップ'};
const warning='CPU・ディスクを使用して再生成します。既存の配信と端末ダウンロードは保持します。原本がなければ残っている最高品質のデータを使用します。失われた画質は復元できません。';
export async function mountAdminJobs({panel,api,esc,bytes,confirm,valid,status}){
  let cursor='',jobSignature='';
  panel.innerHTML=`<h3>アセットの再生成</h3><p class="muted">${warning} ジョブ履歴ではなく、実行時点で存在するアセットが対象です。処理中のアセットは除外します。</p><div class="admin-toolbar"><label>全件再生成の種類<select class="regenerate-kind"><option value="thumbnail">全アセットの表紙</option><option value="preview">全動画のプレビュー</option><option value="transcode">全動画のトランスコード・配信画質</option></select></label><button class="button primary regenerate-all">対象の全アセットを再生成</button></div><form class="admin-toolbar asset-search"><input name="q" aria-label="アセット検索" placeholder="タイトルで検索"><button class="button secondary">検索</button></form><div class="admin-assets"></div><button class="button secondary next-assets" hidden>次の100件</button><section aria-label="現在のジョブ"><h3>現在のジョブ</h3><p class="current-job-count muted"></p><div class="admin-current-jobs"></div></section><section aria-label="ジョブ履歴"><h3>ジョブ履歴</h3><p class="muted">完了は緑、失敗は赤、取消は灰色で表示します。履歴からの再実行はありません。</p><div class="admin-job-history"></div></section>`;
  const search=panel.querySelector('.asset-search');
  const individual=(id,kind)=>confirm((names[kind]??kind)+'を再生成',warning,'',()=>api(`/admin/assets/${id}/regenerate`,{method:'POST',body:{kind,acknowledgeCost:true}}),{password:false});
  panel.querySelector('.regenerate-all').onclick=()=>{
    const kind=panel.querySelector('.regenerate-kind').value;
    confirm(panel.querySelector('.regenerate-kind').selectedOptions[0].textContent+'を再生成',warning+' 実行時に存在する対象すべてを順番に処理します。画面を閉じても継続し、再起動後も未処理分を再開します。','',async()=>{
      const r=await api('/admin/assets/regenerate-all',{method:'POST',body:{kind,acknowledgeCost:true}});
      return {message:`${r.accepted}件を受け付けました。処理中の${r.skipped}件は除外しました。`};
    },{password:false});
  };
  const card=row=>{const value=row.progress??row.processing??{};return `<article class="admin-card ${jobStateClass(row.state)}"><div class="admin-card-title"><strong>${esc(row.title??names[row.kind]??row.kind??'メディア処理')}</strong><span class="job-state">${esc(states[row.state]??row.state??'処理中')}</span></div><small>${esc(row.id??'')}${row.assetId?' · '+esc(row.assetId):''}</small>${row.upload&&row.state==='complete'&&!row.assetExists?'<small>アセット削除済み · アップロード当時の記録です</small>':''}${value.stage?`<small>${esc(value.stage)} · ${Math.round(value.percent??0)}%</small>`:''}${value.source?`<small>変換元：${value.source==='original'?'保持原本':'最高品質の原本代用'} ${esc(value.sourceQuality??'')}</small>`:''}${row.error?`<p>${esc(row.error)}</p>`:''}</article>`;};
  async function loadJobs(){
    const data=await api('/admin/jobs');if(!valid())return;
    const signature=JSON.stringify([data.jobs.map(j=>[j.id,j.state]),data.uploads.map(j=>[j.id,j.state])]);
    if(jobSignature&&signature!==jobSignature)await loadAssets();jobSignature=signature;if(!valid())return;
    const rows=[...(data.currentJobs??data.jobs),...(data.currentUploads??data.uploads).map(row=>({...row,upload:true})),...data.previews,...data.thumbnails,...(data.processors??[])];
    const split=partitionJobs(rows),history=data.history?[...data.history.jobs,...data.history.uploads.map(row=>({...row,upload:true}))]:split.history;
    panel.querySelector('.admin-current-jobs').innerHTML=split.current.map(card).join('')||'<p>現在実行中・待機中のジョブはありません。</p>';
    panel.querySelector('.current-job-count').textContent=data.currentCount?`待機・実行中 ${data.currentCount}件（各種類の最新100件まで表示）`:'';
    panel.querySelector('.admin-job-history').innerHTML=history.map(card).join('')||'<p>履歴はありません。</p>';
  }
  async function loadAssets(append=false){
    const data=await api('/admin/assets?q='+encodeURIComponent(search.elements.q.value)+(append&&cursor?'&after='+cursor:''));if(!valid())return;cursor=data.nextCursor;const box=panel.querySelector('.admin-assets');if(!append)box.innerHTML='';
    box.insertAdjacentHTML('beforeend',data.assets.map(item=>`<article class="admin-card"><strong>${esc(item.title)}</strong><small>${esc(item.shelf)} · ${esc(item.mimeType)}</small>${item.mimeType.startsWith('video/')?`<small>${item.hasHls?'HLS配信あり':'HLS未生成'} · ${item.originalRetained?'原本保持 ON':'最高品質の既存データを原本代用に使用'}</small>`:''}<div class="admin-actions"><button class="button secondary" data-asset="${esc(item.id)}" data-kind="thumbnail">表紙を再生成</button>${item.mimeType.startsWith('video/')?`<button class="button secondary" data-asset="${esc(item.id)}" data-kind="preview">プレビューを再生成</button><button class="button primary" data-asset="${esc(item.id)}" data-kind="transcode">動画を再トランスコード</button>`:''}</div></article>`).join('')||'<p>見つかりません。</p>');
    box.querySelectorAll('[data-asset]').forEach(b=>b.onclick=()=>individual(b.dataset.asset,b.dataset.kind));panel.querySelector('.next-assets').hidden=!cursor;
  }
  search.onsubmit=event=>{event.preventDefault();loadAssets().catch(status);};panel.querySelector('.next-assets').onclick=()=>loadAssets(true).catch(status);
  await Promise.all([loadJobs(),loadAssets()]);return loadJobs;
}
