import packageInfo from './client-version.js';
export function openAbout({dialog,serverVersion,esc}){
  const existing=document.querySelector('dialog.mirea-about[open]');if(existing){existing.focus();return existing;}
  return dialog('Mireaについて',`<div class="modal-body about-body"><h2>Mirea</h2><p>動画・本・音楽を楽しむ、あなたのメディアライブラリ。</p><dl><dt>画面のバージョン</dt><dd>${esc(packageInfo.version)}</dd><dt>サーバーのバージョン</dt><dd>${esc(serverVersion??'未接続')}</dd><dt>ライセンス</dt><dd>Apache License 2.0</dd></dl><p><a href="https://github.com/SUIREN-KazutoHashimoto/Mirea" target="_blank" rel="noopener noreferrer">GitHubでプロジェクトを見る ↗</a></p><p><a href="https://github.com/SUIREN-KazutoHashimoto/Mirea/releases" target="_blank" rel="noopener noreferrer">リリース情報 ↗</a></p></div>`,'mirea-about');
}
