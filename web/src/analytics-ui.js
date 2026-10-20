export function openAnalytics({ dialog, api, flush, esc, shelfId, global = false }) {
  const anonymous=Boolean(shelfId || global), base=global?'/analytics/global':shelfId?`/shelves/${shelfId}/analytics`:'/analytics/me';
  const node=dialog(anonymous?'匿名の閲覧集計':'自分の閲覧記録',`<div class="modal-body analytics-body"><p>${anonymous?'5人以上が閲覧した集計だけを表示します。件数は5件単位、時間は10秒単位に丸め、当日（UTC）の閲覧を除きます。個人の識別情報・個別履歴は表示しません。':'自分だけが確認できる詳細履歴です。本編とプレビューは別集計です。表示時間は画面上の表示、アクティブ時間は前面・非放置状態の推定です。'}<br>閲覧回数は実際に表示／再生を開始したセッション数です。動画・音声の終端到達は全編視聴を意味しません。</p>
    ${anonymous?'<label>集計期間<select class="analytics-period"><option value="30d">直近30日（当日除外）</option><option value="7d">直近7日</option><option value="90d">直近90日</option><option value="all">全期間</option></select></label>':''}
    <div class="analytics-results" aria-live="polite">読み込んでいます…</div><div class="modal-actions"><button class="button secondary analytics-refresh">更新</button><button class="button secondary analytics-export">${anonymous?'匿名集計を出力':'自分の生ログを出力（最大1,000件ずつ）'}</button></div><p class="analytics-export-status" role="status"></p>${anonymous?'':'<details><summary>自分のイベント詳細（1,000件ずつ）</summary><button class="button secondary analytics-events">次のイベントを表示</button><pre class="analytics-event-list"></pre></details>'}</div>`,'analytics-modal');
  const results=node.querySelector('.analytics-results'), status=node.querySelector('.analytics-export-status');
  let exportCursor=0, eventCursor=0, loading=false;
  const period=()=>node.querySelector('.analytics-period')?.value || 'all';
  const suffix=()=>anonymous?`?period=${period()}`:'';
  const duration=ms=>`${(ms/1000).toFixed(1)}秒`;
  async function load() {
    if(loading)return; loading=true;
    try {
      await flush(); const data=await api(`${base}/summary${suffix()}`);
      if(!node.isConnected)return;
      results.innerHTML=data.assets.length?data.assets.map(asset=>`<details class="analytics-asset"><summary><strong>${esc(asset.title || `${asset.kind} / ${asset.platform}`)}</strong> · ${asset.context==='preview'?'プレビュー':'本編'} · ${asset.viewCount}回</summary><p>表示 ${duration(asset.visibleMs)} / アクティブ ${duration(asset.activeMs)} / 実再生 ${duration(asset.watchMs)} / 終端到達 ${asset.endedCount}回${anonymous?` / 閲覧者 ${asset.uniqueViewers}人（丸め値）`:''}</p>
        ${(data.pages || []).filter(row=>row.assetId===asset.assetId).map(row=>`<div>${row.page}ページ: ${row.visits}回 / 表示 ${duration(row.visibleMs)} / アクティブ ${duration(row.activeMs)}</div>`).join('')}
        ${(data.videoBins || []).filter(row=>row.assetId===asset.assetId && row.context===asset.context).map(row=>`<div>${row.startMs/1000}〜${(row.startMs+data.binSizeMs)/1000}秒: 実再生 ${duration(row.watchMs)}（繰り返し含む）</div>`).join('')}</details>`).join(''):`<p>${anonymous?'条件を満たす集計はまだありません。5人未満のデータは非公開です。':'閲覧記録はまだありません。'}</p>`;
      if(data.truncated)results.insertAdjacentHTML('beforeend','<p>表示上限に達しました。本人の生ログはカーソル付きで続けて出力できます。</p>');
    } catch(error){if(node.isConnected)results.textContent=error.message;} finally{loading=false;}
  }
  node.querySelector('.analytics-refresh').onclick=load;
  node.querySelector('.analytics-period')?.addEventListener('change',load);
  node.querySelector('.analytics-export').onclick=async event=>{
    const button=event.currentTarget; button.disabled=true;
    try {
      // Personal exports are bounded chunks; never load an unlimited log into RAM.
      const data=anonymous?await api(`${base}/summary${suffix()}`):await api(`${base}/events?limit=1000&after=${exportCursor}`);
      const rows=anonymous?[{type:'metadata',privacy:data.privacy,period:data.period,truncated:data.truncated,schemaVersion:data.schemaVersion,binSizeMs:data.binSizeMs},...data.assets.map(row=>({type:'asset',...row})),...data.pages.map(row=>({type:'page',...row})),...data.videoBins.map(row=>({type:'video_bin',...row}))]:data.events;
      const url=URL.createObjectURL(new Blob([rows.map(row=>JSON.stringify(row)).join('\n')+'\n'],{type:'application/x-ndjson'}));
      const link=document.createElement('a');link.href=url;link.download=anonymous?'mirea-anonymous.ndjson':`mirea-self-after-${exportCursor}.ndjson`; link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      if(!anonymous){exportCursor=data.nextCursor;status.textContent=`${rows.length}件を出力しました。カーソル: ${exportCursor}。${data.hasMore?'もう一度押すと続きから出力します。':'現時点の末尾です。'}`;}
    }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  };
  node.querySelector('.analytics-events')?.addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{const data=await api(`${base}/events?limit=1000&after=${eventCursor}`);eventCursor=data.nextCursor;node.querySelector('.analytics-event-list').textContent=data.events.map(row=>JSON.stringify(row,null,2)).join('\n');button.textContent=data.hasMore?'次のイベントを表示':'以降の新しいイベントを確認';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  });
  load();return node;
}
