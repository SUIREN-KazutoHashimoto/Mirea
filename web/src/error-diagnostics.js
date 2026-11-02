import {normalizeDiagnostic,DIAGNOSTIC_CATEGORIES,DIAGNOSTIC_OPERATIONS} from '../../server/error-diagnostic-schema.js';
import packageInfo from './client-version.js';
let recent=[],sendReports;
const listeners=new Set();let attached=new WeakMap();
const notify=()=>{for(const listener of listeners)try{listener();}catch{/* Diagnostics must not replace the original operation's failure. */}};
export const recentDiagnostics=()=>structuredClone(recent);
export function clearDiagnostics(){recent=[];attached=new WeakMap();notify();}
export function recordDiagnostic(value,error){
  const safe=normalizeDiagnostic({...value,clientVersion:packageInfo.version});if(!safe)return null;
  if(error&&typeof error==='object')attached.set(error,safe);
  const index=recent.findIndex(r=>r.errorId===safe.errorId);if(index<0){recent=[safe,...recent].slice(0,20);notify();}return safe;
}
export function diagnosticFor(error){return error&&typeof error==='object'?attached.get(error):undefined;}
export function localDiagnostic({status=0,operation='client',network=false}={}){
  return {schemaVersion:1,errorId:crypto.randomUUID(),occurredAt:new Date().toISOString(),status,operation,category:network?'network':'client',code:network?'NETWORK_ERROR':'CLIENT_ERROR',type:'Error',trace:[],redacted:true};
}
export function requestError(data,status,{network=false,record=true,defer=false}={}){
  const error=Object.assign(new Error(typeof data?.error==='string'?data.error:'リクエストに失敗しました。'),{status});
  const incoming=normalizeDiagnostic(data?.diagnostic),safe=incoming?.status===status?incoming:localDiagnostic({status,operation:network?'network':'request',network});
  if(record)recordDiagnostic(safe,error);else if(defer)attached.set(error,safe);return error;
}
export function recordClientError(error){if(error?.name==='AbortError')return;recordDiagnostic(diagnosticFor(error)??localDiagnostic({status:error?.status,network:error?.status===0}),error);}
export function diagnosticText(value){const safe=normalizeDiagnostic(value);return safe?JSON.stringify(safe,null,2):'';}
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const button=(label,action)=>{const node=el('button',label,'button secondary');node.type='button';node.onclick=action;return node;};
export function openErrorDiagnostics(dialog){
  const existing=document.querySelector('dialog.diagnostic-modal[open]');if(existing){existing.focus();return existing;}
  const node=dialog('エラーの詳細','<div class="modal-body diagnostic-body"></div>','diagnostic-modal'),body=node.querySelector('.diagnostic-body');let sendKey,sendId;
  const render=()=>{
    body.replaceChildren(el('p','この画面のエラーを最大20件表示します。個人情報や値・保存先などを除いた診断情報を、必要なときだけコピーできます。','muted'));
    const privacy=el('details',undefined,'diagnostic-privacy');privacy.append(el('summary','診断情報の取り扱い'),el('p','共有用の詳細にはアセット名・ファイル名・メール・保存先・URL・認証情報・例外の原文を含みません。この画面の一覧はアカウント／接続先の変更・再読み込みで消去します。後処理の安全な診断情報はサーバーの転送履歴に保存され、本人の転送画面から再表示できます。外部へ自動送信しません。'));body.append(privacy);
    if(!recent.length){body.append(el('p','表示できるエラーはありません。'));return;}
    if(sendReports){const status=el('p','','diagnostic-send-status');status.setAttribute('role','status');const send=button('エラーをまとめてサーバー管理者へ送信',async()=>{send.disabled=true;const reports=recentDiagnostics(),key=reports.map(report=>report.errorId).join('|');if(key!==sendKey){sendKey=key;sendId=crypto.randomUUID();}try{await sendReports(reports,{id:sendId});status.textContent='個人情報を除いた診断情報を送信しました。';}catch{status.textContent='送信できませんでした。接続を確認して再試行してください。';send.disabled=false;}});body.append(send,status);}
    for(const report of recent){
      const card=el('details',undefined,'diagnostic-card');card.open=report===recent[0];
      card.append(el('summary',DIAGNOSTIC_OPERATIONS[report.operation]+' · '+report.code));
      card.append(el('p',report.image?({IMAGE_TRUNCATED:'画像の途中または末尾のデータを読み込めませんでした。',IMAGE_PROFILE_INVALID:'画像に含まれる色設定を読み込めませんでした。'}[report.code]??'このページの画像処理に失敗しました。転送の詳細で対象ファイルを確認できます。'):DIAGNOSTIC_CATEGORIES[report.category]));
      if(report.image){const image=report.image;card.append(el('p',[(image.page?`${image.page} / ${image.pages??'?'}ページ目`:''),image.stage==='thumbnail'?'表紙生成':image.stage==='page-validation'?'ページ検証':'',image.phase?({read:'ファイル読み込み',metadata:'画像情報の読み込み',decode:'画像データの検証',render:'表紙の描画'}[image.phase]):'',image.format?.toUpperCase(),image.width&&image.height?`${image.width} × ${image.height}`:''].filter(Boolean).join(' · ')));}
      const pre=el('pre',diagnosticText(report));pre.tabIndex=0;card.append(pre);
      const status=el('p','','diagnostic-copy-status');status.setAttribute('role','status');
      card.append(button('安全な詳細をコピー',async()=>{try{await navigator.clipboard.writeText(diagnosticText(report));status.textContent='コピーしました。';}catch{const range=document.createRange();range.selectNodeContents(pre);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);status.textContent='コピーできないため内容を選択しました。端末のコピー操作を使ってください。';}}),status);body.append(card);
    }
    body.append(button('この画面のエラー履歴を消す',clearDiagnostics));
  };
  listeners.add(render);node.addEventListener('close',()=>listeners.delete(render),{once:true});render();return node;
}
export function mountErrorDiagnostics({dialog,send}){
  sendReports=send;
  const launchers=new Set();let current;
  const update=()=>{
    for(const node of launchers)if(!node.isConnected){launchers.delete(node);}
    if(!recent.length){for(const node of launchers)node.remove();launchers.clear();return;}
    // An existing confirmation dialog stays in control: never replace it or
    // unexpectedly open another modal. Put the explicit detail action inside.
    const parents=[...document.querySelectorAll('.form-error,.viewer-error')].filter(node=>!node.hidden&&node.textContent.trim()&&node.closest('dialog[open]:not(.diagnostic-modal),.viewer-screen'));
    for(const launcher of launchers)if(!parents.includes(launcher.parentElement)){launcher.remove();launchers.delete(launcher);}
    for(const parent of parents){
      if([...launchers].some(node=>node.parentElement===parent))continue;
      const launcher=button('エラーの詳細を見る',()=>{if(current?.isConnected)return;current=openErrorDiagnostics(dialog);});launcher.classList.add('diagnostic-launcher','diagnostic-dialog-action');
      parent.append(launcher);launchers.add(launcher);
    }
  };
  listeners.add(update);
  const unhandled=event=>{if(event.reason?.name==='AbortError'||event.error?.name==='AbortError')return;recordClientError(event.reason??event.error);};
  window.addEventListener('unhandledrejection',unhandled);window.addEventListener('error',unhandled);
  window.addEventListener('viewer:player-ready',update);
  // Viewers/dialogs are direct children. Observe only that boundary, avoiding
  // work for playback frames, progress updates or changing thumbnail colors.
  const observer=new MutationObserver(records=>{if(records.some(r=>r.target.closest?.('.form-error,.viewer-error')||r.type==='childList'&&[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1&&(n.matches?.('dialog,.viewer-screen')||n.querySelector?.('.form-error,.viewer-error')))))update();});observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
  update();return ()=>{observer.disconnect();listeners.delete(update);window.removeEventListener('viewer:player-ready',update);window.removeEventListener('unhandledrejection',unhandled);window.removeEventListener('error',unhandled);for(const node of launchers)node.remove();};
}
