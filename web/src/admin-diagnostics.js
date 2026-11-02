import {displayTime} from './management-ui.js';
export async function mountAdminDiagnostics({panel,api,valid}){
  panel.innerHTML='<h3>届いたエラー報告</h3><p class="muted">利用者が送信した診断情報を、送信単位で確認できます。作品名・メール・URL・認証情報・例外の原文は含みません。</p><div class="diagnostic-batches"></div><button class="button secondary diagnostic-more" hidden>以前の報告</button><p class="diagnostic-status" role="status"></p>';
  let before;const box=panel.querySelector('.diagnostic-batches'),more=panel.querySelector('.diagnostic-more'),status=panel.querySelector('.diagnostic-status');
  async function load(){more.disabled=true;const data=await api('/admin/diagnostics'+(before?'?before='+before:''));if(!valid())return;
    for(const batch of data.batches){const card=document.createElement('details');card.className='diagnostic-card';const summary=document.createElement('summary');summary.textContent=displayTime(batch.createdAt)+' · '+batch.count+'件';const pre=document.createElement('pre');pre.textContent=JSON.stringify({id:batch.id,createdAt:new Date(batch.createdAt).toISOString(),reports:batch.reports},null,2);const copy=document.createElement('button');copy.type='button';copy.className='button secondary';copy.textContent='この報告をまとめてコピー';copy.onclick=async()=>{try{await navigator.clipboard.writeText(pre.textContent);status.textContent='コピーしました。';}catch{status.textContent='コピーできませんでした。内容を選択してコピーしてください。';}};card.append(summary,copy,pre);box.append(card);}
    if(!box.children.length)box.textContent='届いたエラー報告はありません。';before=data.nextBefore;more.hidden=!before;more.disabled=false;
  }
  more.onclick=()=>load().catch(()=>status.textContent='報告を取得できませんでした。');await load();
}
