import {saveBlob} from './admin-downloads.js';

export function openAnalytics({dialog,api,flush,esc,shelfId,global=false}){
  if(!shelfId&&!global)throw new Error('詳細な個人ログは設定からダウンロードしてください。');
  const base=global?'/analytics/global':`/shelves/${shelfId}/analytics`;
  const node=dialog('匿名の閲覧集計',`<div class="modal-body analytics-body"><p>5人以上が閲覧した集計だけを表示します。件数は5件単位、時間は10秒単位に丸め、当日（UTC）の閲覧を除きます。個人の識別情報・個別履歴は表示しません。<br>閲覧回数は表示／再生を開始したセッション数です。終端到達は全編視聴を意味しません。</p><label>集計期間<select class="analytics-period"><option value="30d">直近30日（当日除外）</option><option value="7d">直近7日</option><option value="90d">直近90日</option><option value="all">全期間</option></select></label><div class="analytics-results" aria-live="polite">読み込んでいます…</div><div class="modal-actions"><button class="button secondary analytics-refresh">更新</button><button class="button secondary analytics-export">匿名集計を出力</button></div><p class="analytics-export-status" role="status"></p></div>`,'analytics-modal');
  const results=node.querySelector('.analytics-results'),status=node.querySelector('.analytics-export-status');
  let loading=false;
  const suffix=()=>'?period='+node.querySelector('.analytics-period').value;
  const duration=ms=>`${(ms/1000).toFixed(1)}秒`;
  async function load(){
    if(loading)return;loading=true;
    try{await flush();const data=await api(base+'/summary'+suffix());if(!node.isConnected)return;
      results.innerHTML=data.assets.length?data.assets.map(asset=>`<details class="analytics-asset"><summary><strong>${esc(asset.title||asset.kind+' / '+asset.platform)}</strong> · ${asset.context==='preview'?'プレビュー':'本編'} · ${asset.viewCount}回</summary><p>表示 ${duration(asset.visibleMs)} / アクティブ ${duration(asset.activeMs)} / 実再生 ${duration(asset.watchMs)} / 終端到達 ${asset.endedCount}回 / 閲覧者 ${asset.uniqueViewers}人（丸め値）</p>${data.pages.filter(row=>row.assetId===asset.assetId).map(row=>`<div>${row.page}ページ: ${row.visits}回 / 表示 ${duration(row.visibleMs)}</div>`).join('')}${data.videoBins.filter(row=>row.assetId===asset.assetId&&row.context===asset.context).map(row=>`<div>${row.startMs/1000}〜${(row.startMs+data.binSizeMs)/1000}秒: 実再生 ${duration(row.watchMs)}</div>`).join('')}</details>`).join(''):'<p>条件を満たす集計はまだありません。5人未満のデータは非公開です。</p>';
      if(data.truncated)results.insertAdjacentHTML('beforeend','<p>表示上限に達しました。</p>');
    }catch(error){if(node.isConnected)results.textContent=error.message;}finally{loading=false;}
  }
  node.querySelector('.analytics-refresh').onclick=load;node.querySelector('.analytics-period').onchange=load;
  node.querySelector('.analytics-export').onclick=async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{const data=await api(base+'/summary'+suffix());if(!node.isConnected)return;const rows=[{type:'metadata',privacy:data.privacy,period:data.period,truncated:data.truncated,schemaVersion:data.schemaVersion,binSizeMs:data.binSizeMs},...data.assets.map(row=>({type:'asset',...row})),...data.pages.map(row=>({type:'page',...row})),...data.videoBins.map(row=>({type:'video_bin',...row}))];await saveBlob(new Blob([rows.map(row=>JSON.stringify(row)).join('\n')+'\n'],{type:'application/x-ndjson'}),'mirea-anonymous.ndjson');status.textContent='匿名集計を出力しました。';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  };
  load();return node;
}
