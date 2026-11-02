import {libraryNameConflicts} from '../../server/name-rules.js';
export function renderNameIntegrity(container,catalog,{esc,offline=false,openSeries,openAsset}={}){
  if(!container)return;
  const groups=libraryNameConflicts(catalog),items=new Map(catalog.items.map(i=>[i.id,i]));container.hidden=!groups.length;
  if(!groups.length){container.innerHTML='';return;}
  container.innerHTML=`<h2>データ不整合：同じ階層に名前の重複があります（${groups.length}か所）</h2><p>本棚の所有者・編集者向けの通知です。解消されるまで表示します。自動で改名・統合・削除はしません。${offline?'保存済み一覧の時点の情報です。解消状況はオンラインで確認してください。':''}</p><details><summary>重複している場所を確認・手動で整理</summary><ul>${groups.slice(0,200).map(group=>`<li><strong>${esc(group.path)}</strong><p>${group.kind==='series'?'シリーズ':'アセット'}「${esc(group.title)}」が${group.count}件</p><div>${group.entries.map((entry,index)=>`<button type="button" class="button secondary" data-integrity-kind="${group.kind}" data-integrity-id="${esc(entry.id)}" data-integrity-shelf="${esc(group.shelfId)}" ${offline?'disabled':''}>${group.kind==='series'?'シリーズを編集':'アセットの詳細'} ${index+1}</button>`).join('')}</div></li>`).join('')}</ul>${groups.length>200?'<p>先頭200か所を表示しています。整理後に残りを確認できます。</p>':''}</details>`;
  container.querySelectorAll('[data-integrity-id]').forEach(button=>button.onclick=()=>{if(offline)return;if(button.dataset.integrityKind==='series')openSeries?.(button.dataset.integrityId,button.dataset.integrityShelf);else openAsset?.(items.get(button.dataset.integrityId));});
}
