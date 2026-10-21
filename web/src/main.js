import './style.css';
import './brand.css';
import {brandMarkup} from './brand.js';
import './workspace.css';
import './immersive.css';
import './audio-player.css';
import { api, isOfflineSession, markSessionOffline, reconnectSession, rememberOfflineConfig, native, getEndpoint, setEndpoint, getSession, setSession, initializeSession, upload, absoluteUrl, authenticatedBlob } from './api.js';
import { openImageBook } from './image-reader.js';
import { App } from '@capacitor/app';
import { mountVideoPreviews } from './video-previews.js';
import { configureAnalytics, startAnalytics, stopAnalytics, clearAccountAnalytics, flushAnalytics, trackAsset, analyticsNativeState } from './analytics.js';
import { openAnalytics } from './analytics-ui.js';
import { openProgress,bindVideoProgress,progressNativeState,flushProgress,clearAccountProgress,syncStoredProgress } from './progress.js';
import { downloadToDevice,listDownloads,removeDownload,openDownloaded,closeDownloads,clearAccountDownloads,downloadsNativeState,syncDownloads,ensureDownloadWorker,downloadedThumbnail } from './downloads.js';
import { openSeriesManager,mountSeriesNavigation,seriesNativeState } from './series-ui.js';
import {syncAppearance} from './native-appearance.js';
import { createTheme } from './theme.js';
import { openSettings } from './settings.js';
import { createViewerScreen } from './viewer-shell.js';
import { initializeNativePlayback,openNativePlayback,refreshNativePlayback } from './native-playback.js';
import { NativePlayer,nativePlayerAvailable } from './native-player-bridge.js';
import { mountVideoPlayer } from './video-player.js';
import {loadVideoNavigation} from './video-navigation.js';
import './video-navigation.css';
import {openNavigationEditor} from './video-navigation-editor.js';
import {createPlaybackOrder,loadPlaybackModes,savePlaybackModes} from './playback-order.js';
import {loadQualityPreference,saveQualityPreference,mountNetworkQuality} from './quality-preference.js';
import { isTimedKind } from '../../server/audio-types.js';
import {openUploadDialog} from './upload-ui.js';
import {collectionEntries} from './library-collection.js';
import './collection-groups.css';
import { beginUpdateActivity } from './update-busy.js';
import { initializeAppUpdates, refreshAppUpdates, appUpdatesEndpointChanged, mountAppUpdates, openAppUpdates } from './app-updates.js';
import './app-updates.css';
import {openAdmin} from './admin.js';
import './admin.css';
import './library-layout.css';
import {offlineIdentity,offlineVault,offlinePartition} from './offline-vault.js';
import {showShelfMenu} from './shelf-menu.js';
import {mountLibraryDrawer,mountAssetHold} from './library-interactions.js';
import {downloadableSnapshot,runBulkDownloads} from './bulk-downloads.js';
import './library-mobile.css';
import './playback-dock.css';

const theme = createTheme({changed:syncAppearance});
document.documentElement.classList.toggle('native-app',native);
const defaultApkUrl = 'https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/download/v0.3.0beta/mirea-0.3.0beta-android.apk';
const currentApkUrl=()=>config.androidApkUrl?.startsWith('/api/v1/app-updates/')?absoluteUrl(config.androidApkUrl):config.androidApkUrl||defaultApkUrl;

const root = document.querySelector('#app');
const roleName = { owner: '管理者', editor: '編集者', viewer: '閲覧者' };
const icons = {
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  library: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="11" y="4" width="4" height="16" rx="1"/><path d="m18 4 4 15-4 1-4-15"/>',
  shelf: '<path d="M4 5v15h16V5M2 20h20M8 4v12m4-10v10m4-11 2 11M4 16h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  book: '<path d="M4 3h12l4 4v14H4zM16 3v5h4M8 12h8M8 16h6"/>',
  video: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4z"/>',
  audio: '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  logout: '<path d="M9 4H4v16h5m6-13 5 5-5 5M8 12h12"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3z"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>'
};
function icon(name, className = '') { return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.library}</svg>`; }
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bytes = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;
const date = timestamp => new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp);
let config = { allowRegistration: true, maxUploadBytes: 2147483648, maxBookPages: 500, maxImageBytes: 25 * 1024 * 1024 };
let shelves = [], items = [], activeShelf = null, filter = 'all', search = '', sort = 'recent', loadGeneration = 0;
let series=[],activeSeries='',seriesReturnView;
let libraryPoll,refreshBusy=false,librarySnapshot='',offlineLibrary=false,synchronizing;
let seriesContinuous=true,appDrawer,cardGestures,displayedItems=[];
let thumbnailRequest, thumbnailObserver, thumbnailUrls = [], videoPreviews;
let nativeAppActive = true, nativeStateRevision = 0;
if (native) {
  App.addListener('backButton',({canGoBack})=>{
    if(appDrawer?.isOpen()){appDrawer.close();return;}
    const modal=[...document.querySelectorAll('dialog[open]')].at(-1);if(modal){modal.close();return;}
    const viewer=document.querySelector('.viewer-screen:not([style*="display: none"])');if(viewer){if(viewer.requestReturn)viewer.requestReturn();else viewer.close();return;}
    if(canGoBack)window.history.back();else App.minimizeApp().catch(()=>{});
  }).catch(()=>{});
  App.addListener('appStateChange', ({ isActive }) => {
    nativeStateRevision++;
    nativeAppActive = isActive;
    if (isActive) {syncAppearance(document.documentElement.dataset.theme);refreshAppUpdates();refreshNativePlayback().catch(()=>{});synchronizeConnection();}
    analyticsNativeState(isActive);
    progressNativeState(isActive);
    downloadsNativeState(isActive);
    seriesNativeState(isActive);
    videoPreviews?.setPaused('native', !isActive);
  }).then(async () => {
    const revision = nativeStateRevision;
    const { isActive } = await App.getState();
    if (revision !== nativeStateRevision) return;
    nativeAppActive = isActive;
    analyticsNativeState(isActive);
    progressNativeState(isActive);
    downloadsNativeState(isActive);
    seriesNativeState(isActive);
    videoPreviews?.setPaused('native', !isActive);
  }).catch(() => { /* visibility/window lifecycle remains available */ });
}
function clearThumbnails() {
  cardGestures?.dispose();cardGestures=null;
  videoPreviews?.dispose();
  videoPreviews = null;
  thumbnailRequest?.abort();
  thumbnailObserver?.disconnect();
  for (const url of thumbnailUrls) URL.revokeObjectURL(url);
  thumbnailUrls = [];
}
function loadThumbnails() {
  thumbnailRequest = new AbortController();
  const signal = thumbnailRequest.signal;
  thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      const img = entry.target;
      thumbnailObserver.unobserve(img);
      downloadedThumbnail(img.dataset.localThumbnail).catch(()=>null).then(blob=>blob||(!offlineLibrary?authenticatedBlob(img.dataset.thumbnail,signal):Promise.reject(new Error('オフラインの表紙がありません。')))).then(blob => {
        if (signal.aborted || !img.isConnected) return;
        const url = URL.createObjectURL(blob);
        thumbnailUrls.push(url);
        img.onload = () => img.parentElement?.classList.add('cover-loaded');
        img.src = url;
      }).catch(error => {
        if (signal.aborted || !img.isConnected) return;
        const placeholder = img.parentElement.querySelector('.cover-placeholder');
        if (placeholder) { placeholder.textContent = offlineLibrary?'端末保存済み':'表紙を読み込めません'; placeholder.title = error.message; }
      });
    }
  }, { rootMargin: '200px' });
  document.querySelectorAll('[data-thumbnail]').forEach(img => thumbnailObserver.observe(img));
}
let toastTimer;
function toast(message) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 6000);
}
function report(error) { toast(error.message || '操作に失敗しました。'); }
function dialog(title, body, extraClass = '') {
  videoPreviews?.setPaused('dialog', true);
  const node = document.createElement('dialog');
  node.className = `modal ${extraClass}`;
  node.innerHTML = `<div class="modal-header"><h2>${esc(title)}</h2><button class="icon-button close-modal" aria-label="閉じる">${icon('close')}</button></div>${body}`;
  document.body.append(node);
  node.querySelector('.close-modal').onclick = () => node.close();
  node.addEventListener('click', e => { if (e.target === node) { const box = node.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) node.close(); } });
  node.addEventListener('close', () => {
    node.remove();
    videoPreviews?.setPaused('dialog', Boolean(document.querySelector('dialog[open]')));
  }, { once: true });
  node.showModal();
  return node;
}

function renderAuth(register = false) {
  appDrawer?.dispose();appDrawer=null;
  clearInterval(libraryPoll);librarySnapshot='';
  document.querySelectorAll('.viewer-screen').forEach(node => node.close());
  series=[];activeSeries='';seriesContinuous=true;
  closeDownloads();
  clearThumbnails();
  root.innerHTML = `<main class="auth-layout"><section class="auth-story"><a class="brand" href="/" aria-label="Mirea ホーム">${brandMarkup()}</a>
    <div class="auth-story-copy"><span class="eyebrow">YOUR SHARED MEDIA LIBRARY</span><h1>見たい。読みたい。<br>そのすべてを、<br><span>ひとつの本棚に。</span></h1><p>お気に入りの動画も、大切な一冊も、好きな音楽も。<br>あなただけの場所に集めて、必要な人と共有しよう。</p></div>
    <div class="auth-art" aria-hidden="true"><div class="art-book">${icon('book')}<span>A space<br>for your stories.</span><small>MIREA / LIBRARY</small></div><div class="art-video">${icon('video')}<div class="art-horizon"></div><small>WATCH. READ. SHARE.</small></div><div class="art-chip">${icon('users')} ひとつの本棚を、一緒に。</div></div>
    <span class="auth-footer">動画と本と音楽の、あなたらしい居場所。</span></section>
    <section class="auth-form-area"><div class="auth-form-wrap"><span class="mobile-brand" role="img" aria-label="Mirea">${brandMarkup()}</span><span class="eyebrow">WELCOME TO MIREA</span><h2>${register ? 'アカウントを作成' : 'おかえりなさい。'}</h2><p class="muted">${register ? 'あなたのライブラリを、ここから始めましょう。' : 'ログインして、あなたの本棚を開きましょう。'}</p>
    <form id="auth-form">${native ? `<label>サーバーURL<input name="server" type="url" placeholder="https://mirea.example.com" value="${esc(getEndpoint())}" required autocomplete="url"><small>利用するMireaサーバーのHTTPS URL</small></label>` : ''}
      ${register ? '<label>表示名<input name="name" autocomplete="name" maxlength="80" required placeholder="例：水蓮 太郎"></label>' : ''}
      <label>メールアドレス<input name="email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com" required></label>
      <label>パスワード<input name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="12" maxlength="128" placeholder="12文字以上" required></label>
      <label class="confirm-row remember-login"><input name="remember" type="checkbox" checked>ログイン状態を保持する（最長30日間）</label><small class="muted">共用端末ではチェックを外してください。パスワードは保存しません。</small>
      <p class="form-error" role="alert" hidden></p><button class="button primary auth-submit" type="submit">${register ? 'アカウントを作成する' : 'ログインする'}${icon('arrow')}</button>
    </form><p class="auth-switch">${register ? 'すでにアカウントをお持ちですか？' : 'はじめてご利用ですか？'} <button class="text-button" id="switch-auth">${register ? 'ログイン' : 'アカウントを作成'}</button></p><a class="auth-apk" href="${esc(currentApkUrl())}" target="_blank" rel="noopener noreferrer">${icon('download')} Android版APKをダウンロード</a><div class="auth-note">${icon('shelf')} 本棚ごとに、共有する相手を選べます。</div></div></section></main>`;
  const switchButton = document.querySelector('#switch-auth');
  switchButton.hidden = !register && !config.allowRegistration;
  switchButton.onclick = () => renderAuth(!register);
  if (native) {
    const updates = document.createElement('button'); updates.type = 'button'; updates.className = 'text-button'; updates.textContent = 'アプリの更新';
    document.querySelector('.auth-form-wrap').append(updates);
    updates.onclick = () => { try { setEndpoint(document.querySelector('#auth-form').elements.server.value.trim()); appUpdatesEndpointChanged(); openAppUpdates(dialog); } catch (error) { report(error); } };
  }
  document.querySelector('#auth-form').onsubmit = async e => {
    e.preventDefault();
    const form = e.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const errorBox = form.querySelector('.form-error');
    submit.disabled = true;
    errorBox.hidden = true;
    try {
      if (native) { setEndpoint(form.elements.server.value.trim()); appUpdatesEndpointChanged(); }
      const remember=form.elements.remember.checked;
      const body = { email: form.elements.email.value.trim(), password: form.elements.password.value,remember };
      if (register) body.name = form.elements.name.value.trim();
      const saved=await setSession(await api(register ? '/auth/register' : '/auth/login', { method: 'POST', body }),{remember});
      form.reset();
      await loadConfig();
      await startAnalytics();
      renderShell();
      await refresh();
      if(!saved)toast('ログインは成功しましたが、保持設定を保存できませんでした。この画面を閉じる前に端末の保存設定を確認してください。');
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    finally { submit.disabled = false; }
  };
}

function renderShell() {
  appDrawer?.dispose();appDrawer=null;
  clearInterval(libraryPoll);librarySnapshot='';
  clearThumbnails();
  const user = getSession().user;
  root.innerHTML = `<div class="app-layout"><aside class="sidebar" id="library-drawer" aria-label="ライブラリメニュー"><button type="button" class="icon-button drawer-close" aria-label="メニューを閉じる">${icon('close')}</button><a class="brand" href="/" aria-label="Mirea ホーム">${brandMarkup()}</a>
    <div class="workspace-label">MY WORKSPACE <span>PRIVATE</span></div><nav aria-label="ライブラリ"><button id="nav-all" class="nav-item">${icon('library')}<span>すべてのコンテンツ</span><span class="nav-count"></span></button><button id="recent-history" class="nav-item">${icon('book')}<span>閲覧履歴</span></button>
    <div class="sidebar-heading"><span>本棚</span><button id="add-shelf" class="icon-button" aria-label="本棚を作成">${icon('plus')}</button></div><div id="shelf-nav"></div></nav>
    <div class="drawer-actions"></div><button id="drawer-upload-jobs" class="nav-item drawer-upload-jobs">${icon('upload')}<span>アップロード処理</span><span class="nav-count" id="drawer-upload-count">0</span></button><small class="drawer-status" id="drawer-delivery" role="status"></small>
    <div class="sidebar-hint">${icon('users')}<strong>好きなものを、共有しよう。</strong><p>本棚にメンバーを追加して、<br>動画・本・音楽を一緒に楽しめます。</p></div>
    <button id="nav-settings" class="nav-item settings-nav">${icon('settings')}<span>設定</span></button><a class="nav-item apk-nav" href="${esc(currentApkUrl())}" target="_blank" rel="noopener noreferrer">${icon('download')}<span>Androidアプリ</span></a>
    <div class="profile"><span class="avatar">${esc(user.name.slice(0, 1))}</span><div><strong>${esc(user.name)}</strong><small>${esc(user.email)}</small></div><button id="logout" class="icon-button" aria-label="ログアウト">${icon('logout')}</button></div></aside>
    <div class="drawer-backdrop" hidden></div><main class="main-content"><header class="topbar"><button id="open-drawer" class="icon-button menu-opener" aria-label="ライブラリメニューを開く" aria-controls="library-drawer" aria-expanded="false">${icon('menu')}</button><div class="breadcrumb"><span class="workspace-prefix">ワークスペース</span> <span>/</span> <strong id="breadcrumb-title">ライブラリ</strong></div><span class="topbar-label">YOUR PERSONAL COLLECTION</span><button id="mobile-settings" class="icon-button mobile-settings" aria-label="設定">${icon('settings')}</button><button id="mobile-logout" class="icon-button mobile-logout" aria-label="ログアウト">${icon('logout')}</button></header>
    <div class="content-wrap">
    <section class="library-overview" aria-label="ライブラリの概要"><div class="overview-message"><div class="overview-icon">${icon('shelf')}</div><div><span class="eyebrow">YOUR COLLECTION</span><h2 id="overview-title">すべてのコンテンツ</h2><p id="overview-description">本棚を選んで、コレクションを楽しみましょう。</p></div></div><div class="overview-actions"><button class="button primary" id="open-upload">${icon('plus')}コンテンツを追加</button><button class="button secondary" id="add-series">${icon('plus')}シリーズを追加</button></div><div class="stats"><div><strong id="stat-total">—</strong><span>コンテンツ</span></div><div><strong id="stat-book">—</strong><span>本</span></div><div><strong id="stat-video">—</strong><span>動画</span></div><div><strong id="stat-audio">—</strong><span>音声・音楽</span></div><div><button id="upload-jobs" class="upload-stat" aria-label="アップロード処理を開く"><strong id="stat-upload">0</strong></button><span>アップロード中</span></div></div><small id="analytics-delivery" role="status"></small></section>
    <section class="collection"><div class="collection-toolbar"><div class="tabs" role="group" aria-label="種類で絞り込み"><button data-filter="all" class="tab active">すべて <span id="count-all">0</span></button><button data-filter="book" class="tab">${icon('book')}本 <span id="count-book">0</span></button><button data-filter="video" class="tab">${icon('video')}動画 <span id="count-video">0</span></button><button data-filter="audio" class="tab">${icon('audio')}音声 <span id="count-audio">0</span></button></div><div class="collection-tools"><label class="search-field">${icon('search')}<input id="search" type="search" placeholder="タイトルで検索" aria-label="タイトルで検索"></label><label class="sr-only" for="sort">並び順</label><select id="sort"><option value="recent">追加が新しい順</option><option value="name">タイトル順</option></select></div></div><div class="collection-caption"><h2 id="collection-title">すべてのコンテンツ</h2><span id="result-count"></span><button id="bulk-download" type="button" class="button secondary bulk-download-button" disabled>${icon('download')}<span>表示中を一括DL</span></button></div><div id="items" class="item-grid" aria-live="polite"><p class="loading-state">ライブラリを読み込んでいます…</p></div></section>
    <footer class="library-footer"><span class="footer-brand" role="img" aria-label="Mirea">${brandMarkup()}</span><span>あなたの物語が、ここにある。</span></footer></div></main></div>`;
  document.querySelector('#add-shelf').onclick = openCreateShelf;
  document.querySelector('#nav-all').onclick = () => selectShelf(null);
  document.querySelector('#open-upload').onclick = openUpload;
  document.querySelector('#upload-jobs').onclick = document.querySelector('#drawer-upload-jobs').onclick = openUploadJobs;
  document.querySelector('#bulk-download').onclick=()=>openBulkDownload(displayedItems);
  document.querySelector('#nav-settings').onclick = document.querySelector('#mobile-settings').onclick = showSettings;
  const seriesContext=document.createElement('div');seriesContext.className='series-context';seriesContext.hidden=true;document.querySelector('.collection-caption').before(seriesContext);
  document.querySelector('#add-series').onclick=()=>manageSeries(true);
  document.querySelector('#recent-history').onclick=openRecentHistory;
  const adminAnchor=document.querySelector('#nav-settings'),actor=getSession();
  api('/admin/access').then(access=>{
    if(!access.isServerAdmin||!adminAnchor.isConnected||getSession()!==actor)return;
    const button=document.createElement('button');button.id='nav-admin';button.className='nav-item';button.innerHTML=icon('settings')+'<span>サーバー管理</span>';button.onclick=showAdmin;adminAnchor.before(button);
  }).catch(()=>{});
  const logout = async () => {
    try { clearThumbnails(); document.querySelectorAll('dialog,.viewer-screen').forEach(node=>node.close()); await Promise.all([flushAnalytics(),flushProgress()]); await stopAnalytics(); await api('/auth/logout', { method: 'POST' }).catch(error=>{if(error.status)throw error;}); await setSession(null); loadGeneration++; shelves = []; items = []; activeShelf = null; renderAuth(); }
    catch (error) { report(error); }
  };
  document.querySelector('#logout').onclick = logout;
  document.querySelector('#mobile-logout').onclick = logout;
  document.querySelector('#search').oninput = e => { search = e.target.value; renderItems(true); };
  document.querySelector('#sort').onchange = e => { sort = e.target.value; renderItems(true); };
  document.querySelectorAll('[data-filter]').forEach(button => { button.onclick = () => { filter = button.dataset.filter; renderItems(true); }; });
  appDrawer=mountLibraryDrawer({layout:root.querySelector('.app-layout'),panel:root.querySelector('.sidebar'),main:root.querySelector('.main-content'),opener:root.querySelector('#open-drawer'),closer:root.querySelector('.drawer-close'),backdrop:root.querySelector('.drawer-backdrop'),actions:[root.querySelector('#open-upload'),root.querySelector('#add-series')],actionHome:root.querySelector('.overview-actions'),native});
  libraryPoll=setInterval(()=>{if(!document.hidden&&!refreshBusy&&getSession())refresh({background:true});},5000);
}

function showSettings() {
  const actor=getSession(),server=getEndpoint();
  const current=()=>getSession()===actor && getEndpoint()===server;
  if(offlineLibrary){openDownloadManager();return;}
  openSettings({ dialog, api, esc, theme, flush:flushAnalytics, apkUrl: currentApkUrl(), version: config.version || '0.4.4-beta', manageShelf: id => openMembers(id), manageDownloads:openDownloadManager, mountUpdates: native ? mountAppUpdates : null,
    onUpdated: async result => { if(!current())return;closeDownloads();await setSession(result);await stopAnalytics().catch(()=>{});if(getSession()!==result || getEndpoint()!==server)return;await startAnalytics();if(getSession()!==result || getEndpoint()!==server)return;renderShell();await refresh();toast('アカウント情報を更新しました。他の端末では再ログインが必要です。'); },
    onDeleted: async () => { if(!current())return;const results=await Promise.allSettled([clearAccountDownloads(),clearAccountAnalytics(),clearAccountProgress()]);if(!current())return;const cacheError=results.some(r=>r.status==='rejected');clearThumbnails();setSession(null);loadGeneration++;shelves=[];items=[];activeShelf=null;renderAuth();toast(cacheError?'アカウントを削除しました。端末内データを消去できませんでした。ブラウザーのサイトデータを削除してください。':'アカウントと個人の記録、この端末のダウンロードを削除しました。'); }
  });
}

function showAdmin(){openAdmin({dialog,api,esc,bytes,onStatistics:()=>openAnalytics({dialog,api,flush:flushAnalytics,esc,global:true})}).catch(report);}
function openShelfMenu(id){
  const shelf=shelves.find(s=>s.id===id);if(!shelf)return;
  const actor=getSession(),server=getEndpoint();
  showShelfMenu({shelf,dialog,api,esc,isCurrent:()=>getSession()===actor&&getEndpoint()===server,share:openMembers,
    statistics:shelfId=>openAnalytics({dialog,api,flush:flushAnalytics,esc,shelfId}),
    renameDone:async()=>{await refresh();toast('本棚の名前を変更しました。');},
    deleteDone:async(shelfId,result)=>{if(activeShelf===shelfId)activeShelf=null;await refresh();toast(result.cleanupPending?'本棚を削除しました。一部の残存ファイルは管理者のファイル整理で確認してください。':'本棚と中のアセットを削除しました。');}
  });
}
async function openRecentHistory(){
  const node=dialog('閲覧履歴','<div class="modal-body"><p>最近開いた作品です。詳細な操作・閲覧ログは設定からダウンロードできます。現在アクセスできる作品だけを表示します。</p><div class="recent-history-list">読み込んでいます…</div></div>');
  try{await flushAnalytics();const data=await api('/history');if(!node.isConnected)return;const list=node.querySelector('.recent-history-list');list.innerHTML=data.items.map(item=>`<div class="history-row"><div><strong>${esc(item.title)}</strong><small>${date(item.lastSeenAt)}</small></div><button class="button secondary" data-history-id="${esc(item.id)}">開く</button></div>`).join('')||'<p>履歴はまだありません。</p>';list.querySelectorAll('[data-history-id]').forEach(button=>button.onclick=()=>{const item=data.items.find(i=>i.id===button.dataset.historyId);node.close();openViewer(item).catch(report);});}catch(error){if(node.isConnected)node.querySelector('.recent-history-list').textContent=error.message;}
}

async function refresh({background=false}={}) {
  const generation = ++loadGeneration;
  const node = document.querySelector('#items');
  if (!node) return;
  refreshBusy=true;
  if(!background){clearThumbnails();node.innerHTML = '<p class="loading-state">ライブラリを読み込んでいます…</p>';}
  try {
    const [response,uploadStatus] = await Promise.all([api('/shelves'),api('/uploads')]);
    if (generation !== loadGeneration) return;
    offlineLibrary=false;shelves = response.shelves;
    if (activeShelf && !shelves.some(s => s.id === activeShelf)) activeShelf = null;
    const targets = activeShelf ? shelves.filter(s => s.id === activeShelf) : shelves;
    const results = await Promise.all(targets.map(s => api(`/shelves/${s.id}/items`)));
    if (generation !== loadGeneration) return;
    const snapshot=JSON.stringify([activeShelf,response,results,uploadStatus.activeCount]);
    document.querySelector('#stat-upload').textContent=uploadStatus.activeCount??0;
    document.querySelector('#drawer-upload-count').textContent=uploadStatus.activeCount??0;
    if(background&&snapshot===librarySnapshot)return;
    librarySnapshot=snapshot;
    items = results.flatMap(result => [...result.items,...(result.pendingUploads??[])].map(item => ({ ...item, shelfName: result.shelf.name, role: result.shelf.role })));
    series=results.flatMap(result=>result.series.map(s=>({...s,shelfName:result.shelf.name,role:result.shelf.role})));
    if(activeSeries && activeSeries!=='ungrouped' && !series.some(s=>s.id===activeSeries))activeSeries='';
    renderNav();
    renderItems(!background);
    rememberOfflineConfig(config);
  } catch (error) {
    if (generation !== loadGeneration || !getSession()) return;
    if(background){if(!error.status&&!offlineLibrary)await renderOfflineLibrary();return;}
    if(!error.status||error.status>=500){if(await renderOfflineLibrary())return;}
    node.innerHTML = `<div class="empty-state"><h3>ライブラリを読み込めませんでした</h3><p>${esc(error.message)}</p><button class="button secondary" id="retry-library">もう一度読み込む</button></div>`;
    node.querySelector('button').onclick = refresh;
  }finally{if(generation===loadGeneration)refreshBusy=false;}
}
function selectShelf(id) {
  activeShelf = id;
  activeSeries='';seriesReturnView=null;
  search = '';
  document.querySelector('#search').value = '';
  refresh();
}
function renderNav() {
  const current = shelves.find(s => s.id === activeShelf);
  document.querySelector('#nav-all').classList.toggle('active', !current);
  document.querySelector('.nav-count').textContent = offlineLibrary?items.length:shelves.reduce((n, s) => n + s.itemCount, 0);
  document.querySelector('#shelf-nav').innerHTML = shelves.length ? shelves.map((s, index) => `<div class="shelf-nav-row"><button class="nav-item shelf-nav ${s.id === activeShelf ? 'active' : ''}" data-shelf="${esc(s.id)}"><span class="shelf-dot color-${index % 4}"></span><span>${esc(s.name)}</span>${s.memberCount > 1 ? icon('users', 'shared-icon') : ''}<span class="nav-count">${s.itemCount}</span></button><button class="icon-button shelf-menu-toggle" data-shelf-menu="${esc(s.id)}" aria-label="${esc(s.name)}の本棚メニュー">⋯</button></div>`).join('') : '<p class="sidebar-empty">本棚を作成して<br>コレクションを始めましょう。</p>';
  document.querySelectorAll('[data-shelf]').forEach(button => { button.onclick = () => selectShelf(button.dataset.shelf); });
  document.querySelectorAll('[data-shelf-menu]').forEach(button=>button.onclick=()=>openShelfMenu(button.dataset.shelfMenu));
  document.querySelector('#breadcrumb-title').textContent = current?.name ?? 'ライブラリ';
  document.querySelector('#overview-title').textContent=current?.name??'すべてのコンテンツ';
  document.querySelector('#overview-description').textContent=offlineLibrary?'オフライン · 保存済み作品のみ表示しています。接続後に自動同期します。':current?(current.description||`${roleName[current.role]}として参加している本棚です。`):'本棚を選んで、コレクションを楽しみましょう。';
  document.querySelector('#add-series').hidden=offlineLibrary||Boolean(current?current.role==='viewer':!shelves.some(s=>s.role!=='viewer'));
  document.querySelector('#add-shelf').hidden=offlineLibrary;document.querySelector('#recent-history').disabled=offlineLibrary;document.querySelector('#upload-jobs').disabled=offlineLibrary;document.querySelector('#drawer-upload-jobs').disabled=offlineLibrary;
  document.querySelector('#open-upload').hidden = offlineLibrary||Boolean(current && current.role === 'viewer');
}
function renderItems(animate=false) {
  const node = document.querySelector('#items');
  if (!node) return;
  clearThumbnails();node.dataset.animate=String(animate);
  const bookCount = items.filter(i => !isTimedKind(i.kind)).length;
  const videoCount = items.filter(i => i.kind === 'video').length;
  const audioCount = items.filter(i => i.kind === 'audio').length;
  for (const [name, value] of Object.entries({ total: items.length, book: bookCount, video: videoCount, audio: audioCount })) document.querySelector(`#stat-${name}`).textContent = value;
  document.querySelector('#count-all').textContent = items.length;
  document.querySelector('#count-book').textContent = bookCount;
  document.querySelector('#count-video').textContent = videoCount;
  document.querySelector('#count-audio').textContent = audioCount;
  document.querySelectorAll('[data-filter]').forEach(button => { button.classList.toggle('active', button.dataset.filter === filter); button.setAttribute('aria-pressed', button.dataset.filter === filter); });
  const selectedSeries=series.find(s=>s.id===activeSeries);
  const context=document.querySelector('.series-context');context.hidden=!selectedSeries;
  context.innerHTML=selectedSeries?`<strong>${esc(selectedSeries.title)}</strong><button class="text-button clear-series">一覧に戻る</button>${selectedSeries.role!=='viewer'?'<button class="button secondary edit-series">シリーズを編集</button>':''}`:'';
  if(selectedSeries){context.querySelector('.clear-series').onclick=()=>{activeSeries='';if(seriesReturnView){({filter,search,sort}=seriesReturnView);seriesReturnView=null;document.querySelector('#search').value=search;}renderItems();};if(context.querySelector('.edit-series'))context.querySelector('.edit-series').onclick=()=>manageSeries();}
  const sortSelect=document.querySelector('#sort');sortSelect.disabled=Boolean(selectedSeries);
  if(!sortSelect.querySelector('[value="series"]'))sortSelect.insertAdjacentHTML('beforeend','<option value="series" disabled>シリーズの設定順</option>');
  sortSelect.value=selectedSeries?'series':sort;
  const selected = items.filter(item => (!activeSeries || (activeSeries==='ungrouped'?!item.series:item.series?.id===activeSeries)) && (filter === 'all' || (filter === 'book' ? !isTimedKind(item.kind) : filter === item.kind)) && `${item.title} ${item.series?.title??''} ${item.series?.label??''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => selectedSeries?a.series.position-b.series.position:sort === 'name' ? a.title.localeCompare(b.title, 'ja') : b.createdAt - a.createdAt);
  document.querySelector('#collection-title').textContent = filter === 'book' ? '本（PDF・EPUB・画像）' : filter === 'audio' ? '音声・音楽' : filter === 'video' ? '動画' : 'すべてのコンテンツ';
  if(selectedSeries)document.querySelector('#collection-title').textContent=selectedSeries.title;
  const entries=collectionEntries(selected,series,{group:!activeSeries,allItems:items,filter,search,sort});
  displayedItems=selected;
  document.querySelector('#bulk-download').disabled=offlineLibrary||!selected.some(item=>!item.pending);
  document.querySelector('#result-count').textContent = entries.some(entry=>entry.type==='series')?`${entries.length} 件の表示 · ${selected.length} アセット`:`${selected.length} 件のコンテンツ`;
  if (!entries.length) {
    const hasFilter = Boolean(search || filter !== 'all' || activeSeries);
    node.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon(hasFilter ? 'search' : 'library')}</div><span class="eyebrow">${hasFilter ? 'FIND YOUR NEXT STORY' : 'MAKE YOURSELF AT HOME'}</span><h3>${hasFilter ? '該当するコンテンツがありません' : shelves.length ? '最初の一冊、最初の一本を。' : 'あなたの本棚を、つくろう。'}</h3><p>${hasFilter ? '検索キーワードや種類を変えてみてください。' : shelves.length ? 'メニューの「コンテンツを追加」から、本・動画・音声を追加できます。' : '本棚を作って本・動画・音声を追加すると、ここに並びます。'}</p>${hasFilter ? '<button class="button secondary" id="empty-action">絞り込みを解除</button>' : !shelves.length ? `<button class="button primary" id="empty-action">${icon('plus')}本棚を作成</button>` : ''}</div>`;
    const action = node.querySelector('#empty-action');
    if (action) action.onclick = hasFilter ? () => { search = ''; filter = 'all'; activeSeries=''; document.querySelector('#search').value = ''; renderItems(); } : openCreateShelf;
    return;
  }
  node.innerHTML = entries.map(entry => {
    if(entry.type==='series'){
      const cover=entry.cover,count=entry.matchedCount===entry.assetCount?`${entry.assetCount}作品`:`${entry.matchedCount} / ${entry.assetCount}作品が一致`;
      return `<article class="media-card series-card"><button class="card-open" data-open-series="${esc(entry.id)}" aria-label="シリーズ「${esc(entry.title)}」を開く"><div class="card-art actual-cover series-cover">${cover?`<img data-local-thumbnail="${cover.id}" data-thumbnail="${esc(cover.thumbnailUrl)}" alt="${esc(entry.title)}の表紙">`:''}<span class="cover-placeholder">${icon('library')}<span>${cover?'表紙を読み込んでいます…':'まだ作品がありません'}</span></span><span class="media-type">SERIES</span><span class="series-count">${entry.assetCount}作品</span></div><div class="card-content"><span class="card-shelf">${icon('shelf')}${esc(entry.shelfName)}</span><h3>${esc(entry.title)}</h3><div class="card-meta"><span>${count}</span><span>シリーズ</span></div><div class="card-progress">${entry.assetCount?`閲覧済み ${entry.completed} / ${entry.assetCount}作品`:entry.role==='viewer'?'作品はまだありません':'開いて作品を追加できます'}</div></div></button></article>`;
    }
    const item=entry.item;
    if(item.pending)return `<article class="media-card pending-card" aria-disabled="true"><div class="card-art pending-art">${icon(item.kind==='video'?'video':item.kind==='audio'?'audio':'book')}<span>${item.state==='uploading'?'アップロード中':esc(processingLabel(item.processing))}</span></div><div class="card-content"><span class="card-shelf">${esc(item.shelfName)}</span><h3>${esc(item.title)}</h3><p class="muted">処理が完了すると開けます</p><progress max="100" value="${Math.max(0,Math.min(100,Number(item.processing?.percent)||0))}" aria-label="後処理の進捗"></progress></div></article>`;
    const isBook = !isTimedKind(item.kind);
    const label = item.kind === 'image-book' ? `画像・${item.pageCount}ページ` : item.kind === 'epub' ? 'EPUB' : item.kind === 'pdf' ? 'PDF' : item.kind === 'audio' ? 'AAC / M4A' : item.mimeType === 'video/mp4' ? 'MP4' : 'WebM';
    return `<article class="media-card"><button class="card-open" data-open="${item.id}" ${item.kind==='video' ? `data-preview-id="${item.id}"` : ''} aria-haspopup="dialog" aria-description="長押し、右クリック、またはShift+F10で作品メニューを開きます" aria-label="${esc(item.title)}を${isBook ? '読む' : '再生する'}"><div class="card-art actual-cover ${isBook ? 'book-cover' : item.kind==='audio' ? 'audio-cover' : 'video-cover'}"><img data-local-thumbnail="${item.id}" data-thumbnail="${esc(item.thumbnailUrl)}" alt="${esc(item.title)}のサムネイル"><span class="cover-placeholder">${icon(isBook ? 'book' : item.kind==='audio' ? 'audio' : 'video')}<span>表紙を読み込んでいます…</span></span><span class="media-type">${item.kind === 'image-book' ? 'IMAGE BOOK' : item.kind==='epub' ? 'EPUB' : isBook ? 'PDF' : item.kind==='audio' ? 'AUDIO' : 'VIDEO'}</span><span class="card-open-label">${isBook ? '本を開く' : '再生する'} ${icon('arrow')}</span></div><div class="card-content"><span class="card-shelf">${icon('shelf')}${esc(item.shelfName)}</span><h3>${esc(item.title)}</h3><div class="card-meta"><span>${label} <span class="meta-dot">·</span> ${bytes(item.size)}</span><span>${date(item.createdAt)}</span></div><div class="card-progress">${esc(progressLabel(item,item.progress))}</div></div></button></article>`;
  }).join('');
  node.querySelectorAll('[data-open]').forEach(button => { button.onclick = () => openViewer(items.find(i => i.id === button.dataset.open)); });
  node.querySelectorAll('[data-open-series]').forEach(button=>button.onclick=()=>openLibrarySeries(button.dataset.openSeries));
  cardGestures=mountAssetHold(node,id=>openAssetActions(items.find(item=>item.id===id)));
  node.querySelectorAll('.media-card:not(.series-card)').forEach(card=>{
    if(card.classList.contains('pending-card'))return;
    const id=card.querySelector('[data-open]').dataset.open;
    const item=items.find(item=>item.id===id);
    if(item.series){const badge=document.createElement('button');badge.className='card-series';badge.textContent=`${item.series.title} · ${item.series.label||`${item.series.position}番目`}`;badge.setAttribute('aria-label',`${item.series.title}で絞り込み`);badge.onclick=()=>openLibrarySeries(item.series.id);card.append(badge);}
  });
  updateDownloadButtons();
  loadThumbnails();
  if(offlineLibrary)return;
  videoPreviews = mountVideoPreviews(node, { native, api, authenticatedBlob, trackPreview:(id,video)=>trackAsset(id,'preview')?.video(video) });
  videoPreviews.setPaused('native', !nativeAppActive);
}

function openLibrarySeries(id){
  if(!activeSeries)seriesReturnView={filter,search,sort};
  activeSeries=id;filter='all';search='';document.querySelector('#search').value='';renderItems(true);
}
function manageSeries(create=false){
  const actor=getSession()?.user.id,endpoint=getEndpoint(),selected=!create&&series.find(s=>s.id===activeSeries && s.role!=='viewer');
  openSeriesManager({dialog,api,esc,shelves,initialShelfId:shelves.find(s=>s.id===activeShelf && s.role!=='viewer')?.id,initialSeriesId:selected?.id,onChanged:refresh,isCurrent:()=>getSession()?.user.id===actor && getEndpoint()===endpoint});
}

function openCreateShelf() {
  const node = dialog('新しい本棚', `<form class="modal-body" id="shelf-form"><p class="muted">テーマや楽しむ相手に合わせて、本棚を分けられます。</p><label>本棚の名前<input name="name" maxlength="100" required placeholder="例：週末の映画と読書"></label><label>説明 <span class="optional">任意</span><textarea name="description" maxlength="500" rows="3" placeholder="どんなものを集める本棚ですか？"></textarea></label><p class="form-error" role="alert" hidden></p><div class="modal-actions"><button class="button primary" type="submit">${icon('plus')}本棚を作成</button></div></form>`);
  node.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const form = e.currentTarget, button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const result = await api('/shelves', { method: 'POST', body: { name: form.elements.name.value.trim(), description: form.elements.description.value.trim() } });
      activeShelf = result.id;
      node.close();
      await refresh();
      toast('本棚を作成しました。');
    } catch (error) { const box = form.querySelector('.form-error'); box.textContent = error.message; box.hidden = false; }
    finally { button.disabled = false; }
  };
}
function openUpload() {
  const editable=shelves.filter(s=>s.role!=='viewer');if(!editable.length)return openCreateShelf();
  const actor=getSession(),endpoint=getEndpoint(),isCurrent=()=>getSession()?.token===actor?.token&&getEndpoint()===endpoint;
  return openUploadDialog({dialog,api,upload,shelves:editable,activeShelf,config,esc,bytes,icon,processingLabel,isCurrent,onChanged:async()=>{if(isCurrent())await refresh();},toast});
}
async function openMembers(requestedShelfId = activeShelf) {
  const shelf = shelves.find(s => s.id === (typeof requestedShelfId === 'string' ? requestedShelfId : activeShelf));
  if (!shelf) return;
  const node = dialog(`${shelf.name} の共有設定`, `<div class="modal-body"><p class="muted">登録済みのアカウントをメールアドレスで追加します。</p><div class="permission-note"><strong>管理者</strong> 閲覧・追加・削除・メンバー管理<br><strong>編集者</strong> 閲覧・追加・削除　 <strong>閲覧者</strong> 閲覧のみ</div><div id="member-list" class="member-list">読み込み中…</div><form id="member-form"><label>メンバーを追加<input name="email" type="email" required placeholder="member@example.com" autocomplete="off"></label><div class="member-add-row"><select name="role" aria-label="追加するメンバーの権限"><option value="viewer">閲覧者</option><option value="editor">編集者</option></select><button class="button primary" type="submit">${icon('plus')}追加する</button></div><p class="form-error" role="alert" hidden></p></form></div>`);
  async function reload() {
    const response = await api(`/shelves/${shelf.id}/members`);
    if (!node.isConnected) return;
    node.querySelector('#member-list').innerHTML = response.members.map(m => `<div class="member-row"><span class="avatar small">${esc(m.name.slice(0, 1))}</span><div class="member-name"><strong>${esc(m.name)}</strong><small>${esc(m.email)}</small></div>${m.role === 'owner' ? '<span class="role-badge">管理者</span>' : `<select data-role="${m.id}" aria-label="${esc(m.name)}の権限"><option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>閲覧者</option><option value="editor" ${m.role === 'editor' ? 'selected' : ''}>編集者</option></select><button class="icon-button" data-remove="${m.id}" aria-label="${esc(m.name)}の共有を解除">${icon('close')}</button>`}</div>`).join('');
    node.querySelectorAll('[data-role]').forEach(select => { select.onchange = async () => {
      select.disabled = true;
      try { await api(`/shelves/${shelf.id}/members/${select.dataset.role}`, { method: 'PATCH', body: { role: select.value } }); toast('権限を変更しました。'); }
      catch (error) { report(error); }
      await reload().catch(report);
    }; });
    for (const member of response.members.filter(member => member.role !== 'owner')) {
      const row = node.querySelector(`[data-role="${member.id}"]`).parentElement;
      const transfer = document.createElement('button'); transfer.type = 'button'; transfer.className = 'text-button owner-transfer'; transfer.textContent = '管理を引き継ぐ';
      transfer.onclick = () => {
        const confirm = dialog('本棚の管理を引き継ぐ', `<form class="modal-body"><p>「${esc(shelf.name)}」の管理者を${esc(member.name)}さんに変更します。あなたは編集者になり、共有設定を変更できなくなります。</p><label>現在のパスワード<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><p class="form-error" role="alert" hidden></p><button class="button primary" type="submit">管理者を変更する</button></form>`);
        confirm.querySelector('form').onsubmit = async event => {
          event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'), error = form.querySelector('.form-error'); button.disabled = true; error.hidden = true;
          try { await api(`/shelves/${shelf.id}/owner`, { method: 'PUT', body: { userId: member.id, currentPassword: form.elements.currentPassword.value } }); form.reset(); confirm.close(); node.close(); await refresh(); toast('本棚の管理を引き継ぎました。'); }
          catch (err) { error.textContent = err.message; error.hidden = false; button.disabled = false; }
        };
      };
      row.append(transfer);
    }
    node.querySelectorAll('[data-remove]').forEach(button => { button.onclick = async () => {
      const member = response.members.find(m => m.id === button.dataset.remove);
      if (!window.confirm(`${member.name} さんの「${shelf.name}」へのアクセスを解除しますか？`)) return;
      button.disabled = true;
      try { await api(`/shelves/${shelf.id}/members/${member.id}`, { method: 'DELETE' }); await reload(); await refresh(); toast('本棚の共有を解除しました。'); }
      catch (error) { report(error); button.disabled = false; }
    }; });
  }
  node.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const form = e.currentTarget, button = form.querySelector('button'), errorBox = form.querySelector('.form-error');
    button.disabled = true;
    errorBox.hidden = true;
    try {
      await api(`/shelves/${shelf.id}/members`, { method: 'POST', body: { email: form.elements.email.value.trim(), role: form.elements.role.value } });
      form.reset(); await reload(); await refresh(); toast('メンバーを追加しました。');
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    finally { button.disabled = false; }
  };
  try { await reload(); } catch (error) { node.querySelector('#member-list').textContent = error.message; }
}
function deleteItem(item) {
  const node = dialog('コンテンツを削除', `<div class="modal-body"><p>「${esc(item.title)}」を本棚から削除します。共有している全員が閲覧できなくなります。</p><p class="muted">この操作は元に戻せません。</p><p class="form-error" role="alert" hidden></p><div class="modal-actions"><button id="confirm-delete" class="button danger">${icon('trash')}削除する</button></div></div>`);
  node.querySelector('#confirm-delete').onclick = async e => {
    e.currentTarget.disabled = true;
    try { await api(`/items/${item.id}`, { method: 'DELETE' }); node.close(); await refresh(); toast('コンテンツを削除しました。'); }
    catch (error) { const box = node.querySelector('.form-error'); box.textContent = error.message; box.hidden = false; node.querySelector('#confirm-delete').disabled = false; }
  };
}
async function openViewer(item,{startAtBeginning=false,autoplay=false,background=false,playbackOrder}={}) {
  if(nativePlayerAvailable()&&isTimedKind(item.kind)){
    document.querySelectorAll('.viewer-screen').forEach(screen=>screen.close());
    const preparing=dialog('再生を準備しています','<div class="modal-body"><p class="native-playback-status" role="status">アクセス権・続き位置・端末の保存データを確認しています…</p></div>');
    let cancelled=false;preparing.addEventListener('close',()=>{cancelled=true;},{once:true});
    try{await flushProgress();await openNativePlayback(item,{restart:startAtBeginning,continuous:seriesContinuous,analytics:config.analytics?.enabled===true,version:config.version,
      isCurrent:()=>!cancelled,progress:(received,total)=>{if(!cancelled)preparing.querySelector('.native-playback-status').textContent=`暗号化データをネイティブ再生用に準備しています… ${Math.floor(received/total*100)}%`;}});preparing.close();}
    catch(error){if(!cancelled){preparing.querySelector('.native-playback-status').textContent=error.message;}}
    return;
  }
  const backgroundContinuation=background || autoplay&&Boolean(document.querySelector('.viewer-screen')?.isMinimized);
  const progressActor=getSession()?.user.id,progressServer=getEndpoint();
  const playbackScope=progressServer+'|'+progressActor;
  const order=isTimedKind(item.kind)?playbackOrder?.scope===playbackScope?playbackOrder:createPlaybackOrder({scope:playbackScope,modes:loadPlaybackModes(localStorage,playbackScope)}):null;
  const isPdf = item.mimeType === 'application/pdf';
  document.querySelectorAll('.viewer-screen').forEach(screen=>screen.close());
  videoPreviews?.setPaused('viewer', true);
  const releaseUpdate = beginUpdateActivity();
  let node;
  try { node = createViewerScreen({title:item.title,kind:item.kind,onClose:()=>{releaseUpdate();videoPreviews?.setPaused('viewer',false);}}); }
  catch (error) { releaseUpdate(); throw error; }
  if(backgroundContinuation)node.minimize();
  const body = node.querySelector('.viewer-body');
  body.innerHTML='<p class="viewer-loading" role="status">読み込んでいます…</p>';
  const tracker = trackAsset(item.id);
  let cleanup,progress,downloaded;
  const seriesNavigation=mountSeriesNavigation({node,body,item,api,esc,open:openViewer,order,onModes:value=>savePlaybackModes(localStorage,playbackScope,value),enabled:seriesContinuous,onEnabled:value=>{seriesContinuous=value;},
    isCurrent:()=>getSession()?.user.id===progressActor && getEndpoint()===progressServer,isActive:()=>!native && isTimedKind(item.kind) || nativeAppActive && !document.hidden,beforeMove:()=>progress?.checkpoint()});
  node.addEventListener('close', () => { seriesNavigation.dispose();progress?.dispose();tracker?.dispose();cleanup?.();const video=body.querySelector('video,audio');video?.pause();downloaded?.dispose();if(downloaded && video){video.removeAttribute('src');video.load();} }, { once: true });
  const progressBar=document.createElement('div');progressBar.className='resume-toolbar';
  progressBar.innerHTML='<span class="resume-status" role="status">続き位置を確認しています…</span><button class="text-button" type="button" disabled>最初から</button>';
  node.querySelector('.viewer-meta').append(progressBar);
  const resumeStatus=progressBar.querySelector('.resume-status'),restart=progressBar.querySelector('button');
  const updateStatus=state=>{
    const messages={pending:'続き位置は送信待ちです。接続後に再送します。',conflict:'別の画面で進行度が更新されました。この画面の保存を停止しました。開き直してください。',forbidden:'続き位置を保存する権限がありません。',unauthorized:'続き位置を保存するには再ログインが必要です。',saved:'続き位置を保存しました。'};
    if(node.isConnected)resumeStatus.textContent=messages[state] || state;
  };
  restart.onclick=()=>{seriesNavigation.cancel();cleanup?.restart?.();};
  const onError = error => {
    if (!node.isConnected) return;
    seriesNavigation.cancel();
    tracker?.error();
    body.querySelector('.viewer-loading')?.remove();
    body.querySelector('.pdf-loading')?.remove();
    body.querySelector('.viewer-error')?.remove();
    const errorBox = document.createElement('div');
    errorBox.className = 'viewer-error';
    errorBox.setAttribute('role', 'alert');
    errorBox.textContent = error.message || 'コンテンツを開けませんでした。閉じて、もう一度お試しください。';
    body.prepend(errorBox);
  };
  try {
    downloaded=await openDownloaded(item,()=>node.close());
    if(!node.isConnected){downloaded?.dispose();return;}
    if(downloaded){item.pageCount=downloaded.manifest.pageCount;item.size=downloaded.manifest.files.reduce((n,file)=>n+file.size,0);}
    progress=await openProgress(item,{status:updateStatus,saved:position=>{
      if(getSession()?.user.id!==progressActor || getEndpoint()!==progressServer)return;
      const current=items.find(row=>row.id===item.id);
      if((current?.progress?.revision??0)>position.revision)return;
      if(current)current.progress=position;
      item.progress=position;
      const card=document.querySelector(`[data-open="${item.id}"] .card-progress`);if(card)card.textContent=progressLabel(item,position);
    }});
    if(!node.isConnected){progress.dispose();return;}
    if(startAtBeginning){progress.initial=null;resumeStatus.textContent='シリーズの続きとして、このアセットの先頭から開きました。';}
    else if(progress.initial)resumeStatus.textContent=progressLabel(item,progress.initial)+'（自動で復元）';
    else if(resumeStatus.textContent==='続き位置を確認しています…')resumeStatus.textContent='閲覧中は続き位置を自動保存します。';
    if (item.kind === 'image-book') {
      cleanup = openImageBook(body, item, onError, tracker,progress,downloaded,seriesNavigation);
    } else if (item.kind === 'epub') {
      const { openEpub } = await import('./epub-reader.js');
      if (!node.isConnected) return;
      cleanup = openEpub(body,item,onError,tracker,progress,downloaded,seriesNavigation);
    } else if (isPdf) {
      const { openPdf } = await import('./pdf-reader.js');
      if (!node.isConnected) return;
      cleanup = await openPdf(body, item, onError, tracker,progress,downloaded,seriesNavigation);
    } else {
      const ticket = downloaded?null:await api(`/items/${item.id}/playback-ticket`, { method: 'POST' });
      if (!node.isConnected) return;
      const {attachVideoStream}=await import('./video-stream.js');
      if(!node.isConnected)return;
      let stream,stopNetworkQuality;
      const renew=()=>api(`/items/${item.id}/playback-ticket`,{method:'POST'});
      const player=mountVideoPlayer(body,{onError,kind:item.kind,title:item.title,assetId:item.id,playback:seriesNavigation,onNavigate:direction=>seriesNavigation.navigate(direction),editNavigation:()=>openNavigationEditor({item,api,dialog,esc}),reconnect:async()=>{body.querySelector('.viewer-error')?.remove();if(downloaded)return downloaded.reconnect();await stream.reconnect();return null;}});
      let coverUrl;
      if(item.kind==='audio'){
        try{
          coverUrl=URL.createObjectURL(await downloadedThumbnail(item.id).catch(()=>null)||await authenticatedBlob(item.thumbnailUrl??`/api/v1/items/${item.id}/thumbnail`));
          if(!node.isConnected){URL.revokeObjectURL(coverUrl);player.dispose();return;}
          player.surface.querySelector('img').src=coverUrl;player.surface.querySelector('img').hidden=false;
        }catch{/* Audio remains usable when the cover request fails. */}
      }
      const video = player.video;
      node.bindBackground(video,{key:progressServer+'|'+progressActor+'|'+item.id,id:item.id,loadArtwork:async(_state,signal)=>{
        if(getSession()?.user.id!==progressActor||getEndpoint()!==progressServer)return null;
        const saved=await downloadedThumbnail(item.id).catch(()=>null);if(signal.aborted||getSession()?.user.id!==progressActor||getEndpoint()!==progressServer)return null;
        return saved||(!offlineLibrary?authenticatedBlob(item.thumbnailUrl??`/api/v1/items/${item.id}/thumbnail`,signal):null);
      }});
        if(item.kind==='video')api(`/items/${item.id}/replay-heatmap`).then(value=>player.setHeatmap(value)).catch(()=>{/* Playback never depends on aggregate availability. */});
      const videoProgress=bindVideoProgress(video,progress);
      const stopNavigation=item.kind==='video'?loadVideoNavigation({id:item.id,api,blob:authenticatedBlob,set:player.setNavigation,isCurrent:()=>node.isConnected&&getSession()?.user.id===progressActor&&getEndpoint()===progressServer}):()=>{};
      cleanup=()=>{stopNetworkQuality?.();stopNavigation();videoProgress();stream?.dispose();player.dispose();if(coverUrl)URL.revokeObjectURL(coverUrl);};cleanup.restart=()=>videoProgress.restart();
      tracker?.video(video,player.surface);
      seriesNavigation.bindVideo(video,{autoplay});
      if(downloaded){
        video.src=downloaded.url(0);
        tracker?.quality({selectedQuality:downloaded.manifest.files[0].quality??'download',actualQuality:downloaded.manifest.files[0].quality??'download',streamKind:'download'});
      }else {
        const qualityEndpoint=getEndpoint(),qualityUser=getSession()?.user.id;
        stream=attachVideoStream(video,{ticket,absoluteUrl,renew,onError,initialQuality:loadQualityPreference(qualityEndpoint,qualityUser),onChoose:value=>saveQualityPreference(qualityEndpoint,qualityUser,value),onQuality:value=>tracker?.quality(value),onOptions:options=>player.setQuality(options,value=>stream?.choose(value))});
        if(item.kind==='video')stopNetworkQuality=mountNetworkQuality(body.querySelector('.player-controls'),qualityEndpoint,qualityUser,value=>stream?.choose(value));
      }
      if(downloaded)video.setAttribute('controlsList','nodownload');
    }
    restart.disabled=false;
    if(downloaded){const badge=document.createElement('span');badge.className='download-source';badge.textContent='端末の暗号化データを使用（7日間の閲覧許可）';progressBar.prepend(badge);}
  } catch (error) { onError(error); }
}
async function updateDownloadButtons(){
  await document.querySelector('.asset-action-menu')?.refreshDownloadState?.();
}
function openAssetActions(item){
  if(!item||item.pending)return;
  const actor=getSession(),endpoint=getEndpoint(),current=()=>getSession()?.token===actor?.token&&getEndpoint()===endpoint;
  const editable=!offlineLibrary&&item.role!=='viewer';
  const node=dialog(item.title,`<div class="modal-body asset-action-list"><button class="asset-action action-download" disabled>${icon('download')}<span>保存状態を確認しています…</span></button><button class="asset-action action-unregister" hidden>${icon('trash')}<span>端末のダウンロードを解除</span></button>${editable?`<button class="asset-action action-delete danger-text">${icon('trash')}<span>サーバーから作品を削除</span></button>`:''}<button class="asset-action action-details">${icon('more')}<span>詳細を表示</span></button><p class="muted action-status" role="status"></p></div>`,'asset-action-menu');
  const download=node.querySelector('.action-download'),unregister=node.querySelector('.action-unregister'),status=node.querySelector('.action-status');
  const act=fn=>()=>{node.close();if(current())fn();};
  download.onclick=act(()=>openDownload(item));unregister.onclick=act(()=>removeAssetDownload(item));node.querySelector('.action-details').onclick=act(()=>openAssetDetails(item));
  if(editable)node.querySelector('.action-delete').onclick=act(()=>deleteItem(item));
  node.refreshDownloadState=async()=>{
    try{const row=(await listDownloads()).find(row=>row.assetId===item.id);if(!node.isConnected||!current())return;
      const ready=row?.state==='ready';download.hidden=ready;download.disabled=offlineLibrary;download.querySelector('span').textContent=row?'ダウンロードを再開':'暗号化ダウンロード';unregister.hidden=!row;
      status.textContent=ready?'端末に暗号化保存済み':row?'取得途中のデータがあります。再開・解除できます。':offlineLibrary?'オフライン中は新しくダウンロードできません。':'';
    }catch{if(node.isConnected&&current()){download.disabled=offlineLibrary;download.querySelector('span').textContent='暗号化ダウンロード';status.textContent='保存状態を確認できませんでした。';}}
  };
  node.refreshDownloadState();
}
function removeAssetDownload(item){
  const actor=getSession(),endpoint=getEndpoint(),current=()=>getSession()?.token===actor?.token&&getEndpoint()===endpoint;
  const node=dialog('端末のダウンロードを解除',`<div class="modal-body"><p>「${esc(item.title)}」の、この端末に保存した暗号化データを削除します。サーバーの原本・閲覧履歴は削除しません。</p><p class="muted">この保存データを再生中なら停止します。再取得にはサーバーへの接続が必要です。</p><p class="form-error" hidden role="alert"></p><div class="modal-actions"><button class="button danger confirm-unregister">端末の保存を解除</button></div></div>`);
  node.querySelector('.confirm-unregister').onclick=async e=>{if(!current())return;e.currentTarget.disabled=true;try{await removeDownload(item.id);if(!current())return;node.close();await refreshNativePlayback();toast('この端末のダウンロードを解除しました。');}catch(error){if(node.isConnected&&current()){node.querySelector('.form-error').hidden=false;node.querySelector('.form-error').textContent=error.message;node.querySelector('.confirm-unregister').disabled=false;}}};
}
function openAssetDetails(item){
  if(!item||item.pending)return;
  const actor=getSession(),endpoint=getEndpoint(),current=()=>getSession()?.token===actor?.token&&getEndpoint()===endpoint;
  const editable=!offlineLibrary&&item.role!=='viewer',kind=item.kind==='video'?'動画':item.kind==='audio'?'音声・音楽':item.kind==='epub'?'EPUB':item.kind==='image-book'?'画像本':'PDF';
  const node=dialog('アセットの詳細',`<div class="modal-body asset-details-body"><h3 class="asset-details-title">${esc(item.title)}</h3><img class="asset-detail-cover" alt="" hidden><dl class="asset-facts"><dt>種類</dt><dd>${esc(kind)}</dd><dt>本棚</dt><dd>${esc(item.shelfName??'端末のダウンロード')}</dd><dt>サイズ</dt><dd>${bytes(item.size)}</dd><dt>追加日</dt><dd>${date(item.createdAt)}</dd>${!isTimedKind(item.kind)?`<dt>ページ／章</dt><dd>${item.pageCount}</dd>`:''}${item.series?`<dt>シリーズ</dt><dd>${esc(item.series.title)} · ${esc(item.series.label||item.series.position)}</dd>`:''}<dt>続き位置</dt><dd>${esc(progressLabel(item,item.progress)||'未閲覧')}</dd><dt>端末保存</dt><dd class="asset-local-state">確認しています…</dd></dl><div class="asset-detail-actions"><button class="button primary detail-open">${icon(isTimedKind(item.kind)?'video':'book')}開く</button><button class="button secondary detail-download" ${offlineLibrary?'disabled':''}>${icon('download')}暗号化ダウンロード</button>${editable&&item.kind==='video'?'<button class="button secondary detail-navigation">チャプター・字幕を編集</button>':''}${editable?`<button class="button danger detail-delete">${icon('trash')}削除</button>`:''}</div></div>`,'asset-details-modal');
  const controller=new AbortController();let cover;
  node.addEventListener('close',()=>{controller.abort();if(cover)URL.revokeObjectURL(cover);},{once:true});
  const act=fn=>()=>{node.close();if(current())fn();};
  node.querySelector('.detail-open').onclick=act(()=>openViewer(item).catch(report));
  node.querySelector('.detail-download').onclick=act(()=>openDownload(item));
  if(editable){node.querySelector('.detail-delete').onclick=act(()=>deleteItem(item));if(item.kind==='video')node.querySelector('.detail-navigation').onclick=act(()=>openNavigationEditor({item,api,dialog,esc}));}
  listDownloads().then(rows=>{if(node.isConnected&&current()){const saved=rows.find(row=>row.assetId===item.id);node.querySelector('.asset-local-state').textContent=saved?.state==='ready'?'暗号化保存済み':saved?'取得途中・再開できます':'未ダウンロード';}}).catch(()=>{if(node.isConnected)node.querySelector('.asset-local-state').textContent='保存状態を確認できません。';});
  downloadedThumbnail(item.id).catch(()=>null).then(blob=>blob||(!offlineLibrary&&item.thumbnailUrl?authenticatedBlob(item.thumbnailUrl,controller.signal):null)).then(blob=>{if(!blob||!node.isConnected||!current())return;cover=URL.createObjectURL(blob);const image=node.querySelector('img');image.src=cover;image.hidden=false;}).catch(()=>{});
}
let bulkDialog;
function openBulkDownload(visible){
  if(offlineLibrary)return;
  if(bulkDialog?.isConnected){bulkDialog.focus();return;}
  const snapshot=downloadableSnapshot(visible);if(!snapshot.length)return;
  const actor=getSession(),endpoint=getEndpoint(),current=()=>getSession()?.token===actor?.token&&getEndpoint()===endpoint,controller=new AbortController();
  const total=snapshot.reduce((sum,item)=>sum+item.size,0);
  const node=bulkDialog=dialog('表示中のアセットを一括ダウンロード',`<div class="modal-body"><p>現在の本棚・検索・種類・シリーズに該当する ${snapshot.length} 件を順番に暗号化保存します。画面外へスクロールした作品も対象です。保存済みはスキップし、取得途中は再開します。</p><p class="muted">合計サイズの概算：${bytes(total)}。動画は標準の保存画質を使用します。画質により容量は変わり、アプリの動画・音声はネイティブ再生用の保存にも容量を使用します。Wi-Fiと端末の空き容量を確認してください。</p><progress class="download-progress" max="100" value="0" aria-label="一括ダウンロードの進行状況"></progress><p class="bulk-status" role="status">開始前に一覧を確認できます。実行中にこの画面を閉じると取得を一時停止します。</p><details><summary>対象の作品</summary><ol class="bulk-failures">${snapshot.map(item=>`<li>${esc(item.title)}</li>`).join('')}</ol></details><ul class="bulk-failures bulk-errors"></ul><div class="modal-actions"><button class="button primary bulk-start">一括ダウンロードを開始</button><button class="button secondary bulk-stop" hidden>一時停止</button></div></div>`,'bulk-download-modal');
  let running=false;const start=node.querySelector('.bulk-start'),stop=node.querySelector('.bulk-stop'),status=node.querySelector('.bulk-status'),progress=node.querySelector('progress');
  const changed=value=>{
    if(!node.isConnected)return;
    const done=value.completed+value.skipped+value.failed.length;
    progress.value=Math.min(100,(done+(value.state==='downloading'&&value.totalBytes?Math.max(0,Math.min(1,(value.received??0)/value.totalBytes)):0))/Math.max(1,value.state==='downloading'?snapshot.length:value.total)*100);
    status.textContent=value.state==='finished'?`${value.cancelled?'一時停止しました。':'完了しました。'} 保存 ${value.completed}件・保存済み ${value.skipped}件・失敗 ${value.failed.length}件`:`${done} / ${snapshot.length}件 · ${value.item?.title??''} ${value.state==='skipped'?'（保存済み）':value.state==='failed'?'（失敗・次へ）':value.state==='downloading'&&value.totalBytes?` · ${bytes(value.received??0)} / ${bytes(value.totalBytes)}`:''}`;
    node.querySelector('.bulk-errors').innerHTML=value.failed.slice(0,100).map(row=>`<li>${esc(row.title)}：${esc(row.message)}</li>`).join('');
  };
  node.addEventListener('close',()=>{controller.abort();bulkDialog=null;},{once:true});
  stop.onclick=()=>{controller.abort();stop.disabled=true;};
  start.onclick=async()=>{
    if(running||!current())return;running=true;start.disabled=true;stop.hidden=false;
    try{await runBulkDownloads(snapshot,{list:listDownloads,download:downloadToDevice,signal:controller.signal,isCurrent:current,changed});}
    catch(error){if(node.isConnected)status.textContent=error.message;}
    finally{running=false;stop.hidden=true;if(node.isConnected){start.textContent='閉じる';start.disabled=false;start.onclick=()=>node.close();}await updateDownloadButtons();}
  };
}
function openDownload(item){
  if(!item||offlineLibrary)return;
  const node=dialog('端末へ暗号化ダウンロード',`<div class="modal-body"><h3>${esc(item.title)}</h3><p>本・動画・音声のデータはAES-256-GCMで暗号化してアプリ／ブラウザー内に保存します。閲覧許可と復号鍵は端末固有の鍵で保護します。オンライン時は権限を確認し、最後の接続から7日間はオフラインでも開けます。</p><p>画面を閉じると取得を一時停止します。次回は受信済み部分から再開できます。</p><div class="download-quality" hidden><label>保存する画質<select aria-label="ダウンロード画質"></select></label><small>1アセットにつき1画質を保存します。変更すると以前の保存データを置き換えます。</small></div><progress class="download-progress" max="100" value="0" aria-label="ダウンロードの進行状況"></progress><p class="download-status" role="status">${bytes(item.size)}・端末の空き容量が必要です。</p><div class="modal-actions"><button class="button primary start-download">保存を開始／再開</button></div></div>`);
  const controller=new AbortController(),status=node.querySelector('.download-status'),button=node.querySelector('.start-download');
  node.addEventListener('close',()=>{controller.abort();updateDownloadButtons();},{once:true});
  if(item.kind==='video'){
    button.disabled=true;
    api(`/items/${item.id}/video`).then(info=>{
      if(!node.isConnected)return;
      const block=node.querySelector('.download-quality'),select=block.querySelector('select');
      block.hidden=!info.renditions?.length;
      select.innerHTML=(info.renditions??[]).map(q=>`<option value="${esc(q.quality)}">${esc(q.quality)} · ${bytes(q.size)}</option>`).join('');
      button.disabled=false;
    }).catch(error=>{if(node.isConnected)status.textContent=error.message;});
  }
  button.onclick=async()=>{
    button.disabled=true;
    try{await downloadToDevice(item,({received,total})=>{if(node.isConnected){node.querySelector('progress').value=received/total*100;status.textContent=`${bytes(received)} / ${bytes(total)}`;}},controller.signal,node.querySelector('.download-quality select')?.value||undefined);if(node.isConnected)status.textContent='暗号化して保存しました。最終接続から7日以内はオフラインで開けます。再接続時に自動延長します。';await updateDownloadButtons();}
    catch(error){if(node.isConnected)status.textContent=error.name==='QuotaExceededError'?'端末の保存容量が不足しています。不要なダウンロードを削除してください。':error.message;}
    finally{if(node.isConnected)button.disabled=false;}
  };
}
function openDownloadManager(){
  const node=dialog('この端末のダウンロード','<div class="modal-body"><p>保存内容は暗号化されています。別アカウントとは共有せず、最終接続から7日間はオフラインで開けます。接続後に閲覧記録・続き位置・権限と期限を自動同期します。ここから削除してもサーバーの原本や閲覧履歴は消えません。</p><div class="download-list">読み込んでいます…</div></div>');
  const actor=getSession()?.user.id,endpoint=getEndpoint();
  async function reload(){
    try{const rows=await listDownloads();if(!node.isConnected || getSession()?.user.id!==actor || getEndpoint()!==endpoint)return;
      const list=node.querySelector('.download-list');list.innerHTML=rows.length?rows.map(row=>`<div class="download-row"><div><strong>${esc(row.manifest.title)}</strong><small>${row.state==='ready'?'暗号化保存済み':'未完了・再開可能'}</small></div><button class="button secondary" data-cache-open="${row.assetId}" ${row.state==='ready'?'':'disabled'}>開く</button><button class="button secondary" data-cache-remove="${row.assetId}">端末から削除</button></div>`).join(''):'<p>このアカウントのダウンロードはありません。</p>';
      list.querySelectorAll('[data-cache-open]').forEach(button=>button.onclick=()=>{const row=rows.find(row=>row.assetId===button.dataset.cacheOpen),m=row.manifest;node.close();openViewer(items.find(item=>item.id===row.assetId)??{id:row.assetId,title:m.title,kind:m.kind,pageCount:m.pageCount,size:m.files.reduce((n,f)=>n+f.size,0),mimeType:m.files[0].mime});});
      list.querySelectorAll('[data-cache-remove]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await removeDownload(button.dataset.cacheRemove);await updateDownloadButtons();await reload();}catch(error){report(error);button.disabled=false;}});
    }catch(error){if(node.isConnected)node.querySelector('.download-list').textContent=error.message;}
  }
  reload();
}
function progressLabel(item,position){
  if(!position)return '';
  if(!isTimedKind(item.kind))return `続きから: ${position.page} / ${item.pageCount}${item.kind==='epub'?'章':'ページ'}`;
  const time=ms=>{const seconds=Math.floor((ms??0)/1000);return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
  return position.completed?'最後まで再生済み（次回は最初から）':`続きから: ${time(position.positionMs)} / ${time(position.durationMs)}`;
}
async function renderOfflineLibrary(){
  const session=getSession();if(!session)return false;
  const identity=await offlineIdentity(getEndpoint(),session.user.id);if(!identity)return false;
  const rows=(await listDownloads()).filter(row=>row.state==='ready');if(!rows.length)return false;
  offlineLibrary=true;await markSessionOffline();shelves=[];series=[];activeShelf=null;activeSeries='';
  items=rows.map(row=>{const m=row.manifest;return {id:row.assetId,title:m.title,kind:m.kind,mimeType:m.files[0].mime,pageCount:m.pageCount,size:m.files.reduce((sum,f)=>sum+f.size,0),createdAt:row.savedAt,shelfName:'端末のダウンロード',role:'viewer'};});
  renderNav();renderItems();return true;
}
function synchronizeConnection(){
  if(synchronizing||!getSession())return synchronizing;
  synchronizing=(async()=>{
    if(!await reconnectSession())return;
    await loadConfig();
    ensureDownloadWorker().catch(()=>{});
    await refresh({background:!offlineLibrary});
    await Promise.all([syncDownloads({items}),syncStoredProgress(),flushProgress(),flushAnalytics(),
      nativePlayerAvailable()?NativePlayer.synchronize({origin:getEndpoint(),token:getSession().token,userId:getSession().user.id}):null]);
    if(offlineLibrary){offlineLibrary=false;await refresh();}
  })().catch(error=>{if([401,403].includes(error.status)){window.dispatchEvent(new Event('mirea:unauthorized'));}}).finally(()=>{synchronizing=null;});
  return synchronizing;
}
window.addEventListener('online',()=>synchronizeConnection());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)synchronizeConnection();});
setInterval(()=>synchronizeConnection(),30000);
async function loadConfig() {
  if (native && !getEndpoint()) return;
  try { if(isOfflineSession()){const cached=await offlineIdentity(getEndpoint(),getSession()?.user.id);config={...config,...cached?.config};}else config = { ...config, ...await api('/config') }; configureAnalytics(config.analytics); await rememberOfflineConfig(config); } catch { /* the login action presents connection errors */ }
}
window.addEventListener('mirea:unauthorized', () => {
  stopAnalytics();
  loadGeneration++;
  document.querySelectorAll('dialog,.viewer-screen').forEach(node => node.close());
  items = []; shelves = []; activeShelf = null;
  renderAuth();
  toast('ログインの有効期限が切れました。もう一度ログインしてください。');
});
window.addEventListener('mirea:update-ready', event => toast(`アプリ ${event.detail} の更新を準備しました。「設定」またはログイン画面の「アプリの更新」で確認できます。`));
initializeAppUpdates();
syncAppearance(document.documentElement.dataset.theme);
initializeNativePlayback().catch(()=>{});
async function bootstrapLogin(){
  try{await initializeSession();await loadConfig();if(getSession()){await startAnalytics();renderShell();if(isOfflineSession())await renderOfflineLibrary();else await refresh();synchronizeConnection();}else renderAuth();}
  catch(error){
    clearInterval(libraryPoll);clearThumbnails();
    root.innerHTML=`<main class="reconnect-screen"><section><h1>サーバーに再接続</h1><p>${esc(error.message)}</p><p class="muted">通信に失敗しても、保持したログインは解除しません。オンラインで認証を確認してからライブラリを開きます。</p><button class="button primary retry-connection">もう一度接続する</button><button class="button secondary show-login">ログイン画面を開く</button></section></main>`;
    root.querySelector('.retry-connection').onclick=()=>bootstrapLogin();root.querySelector('.show-login').onclick=()=>renderAuth();
  }
}
await bootstrapLogin();
window.addEventListener('mirea:analytics-status',event=>{
  for(const node of document.querySelectorAll('#analytics-delivery,#drawer-delivery'))node.textContent=event.detail==='pending'?'閲覧記録は端末で送信待ちです。再接続時に再送します。':'閲覧記録の一部を保存・送信できませんでした。';
});

function processingLabel(value={}){
  const names={probe:'メディアを解析中',encode:'メディアを変換中',validate:'配信データを検証中',thumbnail:'サムネイルを生成中',publish:'保存中',complete:'完了'};
  return (names[value.stage]??'処理待ち')+(value.quality?' · '+value.quality:'')+(Number.isFinite(value.percent)?' · '+value.percent+'%':'');
}
function openUploadJobs(){
  const node=dialog('アップロード処理','<div class="modal-body"><p>変換はサーバーで継続します。失敗した動画の原本は自動削除しません。再試行するか、不要なら原本ごと取り消してください。</p><div class="upload-jobs" role="status">読み込み中…</div></div>');
  const actor=getSession()?.user.id,endpoint=getEndpoint();let timer;
  const current=()=>node.isConnected&&getSession()?.user.id===actor&&getEndpoint()===endpoint;
  async function reload(){
    try{
      const result=await api('/uploads');if(!current())return;
      const list=node.querySelector('.upload-jobs');
      list.innerHTML=result.uploads.length?result.uploads.map(job=>`<div class="upload-job"><strong>${esc(job.title)}</strong><p>${esc(job.state==='failed'?job.error:processingLabel(job.processing))}</p><small>${job.retainOriginal?'原本保持 ON':'原本保持 OFF（全処理成功後に削除）'}${job.sourceRetained?' · 失敗した原本を保持中':''}</small><div>${job.state==='failed'&&job.sourceRetained?`<button class="button secondary" data-job-retry="${job.id}">再試行</button>`:''}<button class="button secondary" data-job-cancel="${job.id}">取り消し・原本削除</button></div></div>`).join(''):'<p>処理中・失敗したアップロードはありません。</p>';
      list.querySelectorAll('[data-job-retry]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await api(`/uploads/${button.dataset.jobRetry}/retry`,{method:'POST'});await reload();}catch(error){report(error);button.disabled=false;}});
      list.querySelectorAll('[data-job-cancel]').forEach(button=>button.onclick=async()=>{if(!confirm('この処理を取り消し、アップロードした原本も削除しますか？'))return;button.disabled=true;try{await api(`/uploads/${button.dataset.jobCancel}`,{method:'DELETE'});await reload();}catch(error){report(error);button.disabled=false;}});
    }catch(error){if(current())node.querySelector('.upload-jobs').textContent=error.message;}
    if(current()){clearTimeout(timer);timer=setTimeout(reload,3000);}
  }
  node.addEventListener('close',()=>{clearTimeout(timer);refresh();},{once:true});reload();
}
