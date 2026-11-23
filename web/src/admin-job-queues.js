import './admin-job-queues.css';

const families=[
  ['thumbnail','表紙・サムネイル','画像・本・動画の一覧で使う表紙を生成します。','M3 4h18v16H3z M3 17l5-5 4 4 3-3 6 5 M15 8h2','thumbnail'],
  ['preview','動画プレビュー','動画一覧で試し見する短いプレビューを作ります。','M3 5h18v14H3z M10 9l5 3-5 3z','preview'],
  ['transcode','トランスコード','動画や音声を再生用の形式・配信品質に変換します。','M3 7h15m-3-3 3 3-3 3 M21 17H6m3-3-3 3 3 3','transcode'],
  ['ai','AI解析','タグ、本文、文字起こし、曲の構成、意味検索の索引などを処理します。','M12 2l2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8z'],
  ['transfer','アップロード','ファイルの受信と、処理キューに入る前の作業を表示します。','M12 16V4m-4 4 4-4 4 4 M4 16v4h16v-4'],
  ['repair','未完了の修復','生成が途中で止まったアセットなどの修復を追跡します。','M20 8a8 8 0 1 0 1 8M20 3v5h-5'],
  ['other','その他の処理','上の分類に含まれない、キューに登録された処理を表示します。','M4 7h16M4 12h16M4 17h12']
];
const formatter=new Intl.NumberFormat('ja-JP');
const glyph=path=>`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;

export function mountJobQueueOverview(host,{view,regenerate,repair,settings,assets}){
  host.innerHTML=`<div class="job-queue-toolbar">
    <button type="button" class="button secondary" data-queue-tool="assets">アセットを選ぶ</button>
    <button type="button" class="button secondary" data-queue-tool="repair">欠落を確認</button>
    ${settings?'<button type="button" class="button secondary" data-queue-tool="settings">同時実行数の管理</button>':''}
  </div><p class="job-queue-scope">実行中・待機中はキュー全体の件数です。その場で開始された一時処理は個別一覧に表示します。</p>
  <p class="job-queue-unavailable" role="status" hidden>キュー別の件数は、このサーバーから取得できません。個別一覧は引き続き確認できます。</p>
  <div class="job-queue-list">${families.map(([key,title,description,path,bulk])=>`<article class="job-queue-card" data-queue-family="${key}">
    <div class="job-queue-main"><h4>${glyph(path)}<span>${title}</span></h4><p>${description}</p>
      <div class="job-queue-counters">
        <button type="button" data-queue-state="running" disabled aria-label="${title}の実行中を表示"><span>実行中</span><strong>—</strong></button>
        <button type="button" data-queue-state="queued" disabled aria-label="${title}の待機中を表示"><span>待機中</span><strong>—</strong></button>
      </div>
      <div class="job-queue-secondary"><button type="button" data-queue-state="paused" disabled hidden>一時停止 <strong>—</strong></button><button type="button" data-queue-state="failed" disabled hidden>失敗 <strong>—</strong></button></div>
    </div>
    <div class="job-queue-controls">
      <button type="button" data-queue-state="all" disabled aria-label="${title}の個別一覧">${glyph('M5 6h14M5 12h14M5 18h14')}<span>個別一覧</span></button>
      ${bulk?`<button type="button" data-queue-bulk="${bulk}" aria-label="${title}をすべて再生成">${glyph('M20 8a8 8 0 1 0 1 8M20 3v5h-5')}<span>すべて</span></button>`:''}
    </div>
  </article>`).join('')}</div>`;
  const tools={assets,repair,settings};
  for(const button of host.querySelectorAll('[data-queue-tool]'))button.onclick=()=>tools[button.dataset.queueTool]?.();
  for(const button of host.querySelectorAll('[data-queue-state]'))
    button.onclick=()=>view(button.closest('[data-queue-family]').dataset.queueFamily,button.dataset.queueState);
  for(const button of host.querySelectorAll('[data-queue-bulk]'))button.onclick=()=>regenerate(button.dataset.queueBulk);
  return {
    name:key=>families.find(row=>row[0]===key)?.[1],
    render(data){
      host.querySelector('.job-queue-unavailable').hidden=Boolean(data);
      for(const card of host.querySelectorAll('[data-queue-family]')){
        const counts=data?.[card.dataset.queueFamily];
        for(const button of card.querySelectorAll('[data-queue-state]')){
          const key=button.dataset.queueState;button.disabled=!counts;
          if(key!=='all'){
            const count=counts?.[key];
            const value=Number.isSafeInteger(count)?formatter.format(count):'—';
            button.querySelector('strong').textContent=value;
            if(key==='running'||key==='queued'){
              const name=card.querySelector('h4 span').textContent;
              button.setAttribute('aria-label',name+'の'+button.querySelector('span').textContent+' '+value+'件を表示');
            }
            if(key==='paused'||key==='failed')button.hidden=!count;
          }
        }
      }
    }
  };
}
