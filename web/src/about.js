import packageInfo from './client-version.js';
import {Capacitor} from '@capacitor/core';
import './third-party.css';

export function noticesMarkup(catalogs,esc){
  return catalogs.map(catalog=>`<section><h2>${catalog.scope==='android-runtime'?'Androidライブラリー':'共通ライブラリー'}</h2>${catalog.packages.map(item=>`<details><summary>${esc(item.name)} <small>${esc(item.version)} · ${esc(item.license)}</small></summary>${item.documents.map(document=>`<h3>${esc(document.path)}</h3><pre>${esc(document.text)}</pre>`).join('')}</details>`).join('')}</section>`).join('');
}
function openNotices({dialog,esc}){
  const existing=document.querySelector('dialog.mirea-third-party[open]');if(existing){existing.focus();return;}
  const node=dialog('第三者ライセンス',`<div class="modal-body third-party-notices"><p role="status">読み込んでいます…</p></div>`,'mirea-third-party');
  const controller=new AbortController();node.addEventListener('close',()=>controller.abort(),{once:true});
  const names=['third-party-notices.json',...(Capacitor.isNativePlatform()?['third-party-native.json']:[])];
  Promise.all(names.map(async name=>{const response=await fetch('/'+name,{signal:controller.signal});if(!response.ok)throw new Error('Notices unavailable');return response.json();})).then(catalogs=>{if(node.isConnected)node.querySelector('.third-party-notices').innerHTML=noticesMarkup(catalogs,esc);}).catch(()=>{if(!controller.signal.aborted&&node.isConnected)node.querySelector('.third-party-notices').innerHTML='<p role="alert">ライセンス情報を読み込めませんでした。画面を開き直してください。</p>';});
}
export function openAbout({dialog,serverVersion,esc}){
  const existing=document.querySelector('dialog.mirea-about[open]');if(existing){existing.focus();return existing;}
  const node=dialog('Mireaについて',`<div class="modal-body about-body"><h2>Mirea</h2><p>動画・本・音楽を楽しむ、あなたのメディアライブラリ。</p><dl><dt>画面のバージョン</dt><dd>${esc(packageInfo.version)}</dd><dt>サーバーのバージョン</dt><dd>${esc(serverVersion??'未接続')}</dd><dt>ライセンス</dt><dd>Apache License 2.0</dd></dl><p><button type="button" class="button secondary about-third-party">第三者ライセンスを見る</button></p><p><a href="https://github.com/SUIREN-KazutoHashimoto/Mirea" target="_blank" rel="noopener noreferrer">GitHubでプロジェクトを見る ↗</a></p><p><a href="https://github.com/SUIREN-KazutoHashimoto/Mirea/releases" target="_blank" rel="noopener noreferrer">リリース情報 ↗</a></p></div>`,'mirea-about');
  node.querySelector('.about-third-party').addEventListener('click',()=>openNotices({dialog,esc}));return node;
}
