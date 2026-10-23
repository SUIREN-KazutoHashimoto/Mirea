const entries=new Map();let serial=0;
const changed=()=>globalThis.window?.dispatchEvent(new Event('mirea:transferchange'));
export const transferRows=()=>[...entries.values()];
export function trackTransfer({direction,title,cancel=()=>{},work,notifications=true}){
  const row={id:'transfer-'+(++serial),direction,title,state:'running',percent:0,message:'準備中',cancel};
  for(const [id,value]of entries)if(entries.size>=100&&!['running','queued'].includes(value.state))entries.delete(id);
  entries.set(row.id,row);changed();
  row.promise=Promise.resolve().then(()=>work(value=>{Object.assign(row,value);changed();if(notifications)notify(row);})).then(result=>{row.state='complete';row.percent=100;row.message='完了';changed();if(notifications)notify(row);return result;},error=>{row.state=error.name==='AbortError'?'paused':'failed';row.message=error.message;changed();if(notifications)notify(row);throw error;});
  return row;
}
const notices=new Map();
function notify(row){
  if(!globalThis.Notification||Notification.permission!=='granted'||!globalThis.document?.hidden)return;
  const before=notices.get(row.id)??-1,percent=Math.floor(row.percent/10)*10;
  if(row.state==='running'&&percent===before)return;
  notices.set(row.id,percent);
  try{const note=new Notification(row.direction==='upload'?'Mirea アップロード':'Mirea ダウンロード',{body:row.title+' · '+(row.state==='complete'?'完了':row.state==='running'?percent+'%':row.message),tag:row.id,silent:true});note.onclick=()=>globalThis.window?.focus();}catch{/* OS notification delivery is optional. */}
}
export function stopTransfers(){for(const row of entries.values())if(row.state==='running')row.cancel();}
export function openTransferCenter({dialog,esc}){
  const node=dialog('転送状況','<div class="modal-body"><p class="muted">メニューを閉じても転送を続けます。Androidは通知からも進捗を確認できます。ブラウザーの終了・OSの強制停止時は中断する場合があります。</p><div class="transfer-list"></div></div>','transfer-center');
  const render=()=>{const list=node.querySelector('.transfer-list');list.innerHTML=transferRows().map(row=>`<section class="transfer-row"><strong>${esc(row.title)}</strong><small>${row.direction==='upload'?'アップロード':'ダウンロード'} · ${esc(row.message)} · ${Math.floor(row.percent)}%</small><progress max="100" value="${row.percent}" aria-label="転送進捗"></progress>${row.state==='running'?`<button type="button" class="button secondary" data-stop-transfer="${row.id}">一時停止</button>`:''}</section>`).join('')||'<p>この起動中の転送はありません。</p>';list.querySelectorAll('[data-stop-transfer]').forEach(b=>b.onclick=()=>entries.get(b.dataset.stopTransfer)?.cancel());};
  window.addEventListener('mirea:transferchange',render);node.addEventListener('close',()=>window.removeEventListener('mirea:transferchange',render),{once:true});render();return node;
}
