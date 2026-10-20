import './style.css';
import './workspace.css';
import './immersive.css';
import './audio-player.css';
import { api, native, getEndpoint, setEndpoint, getSession, setSession, upload, absoluteUrl, authenticatedBlob } from './api.js';
import { openImageBook } from './image-reader.js';
import { App } from '@capacitor/app';
import { mountVideoPreviews } from './video-previews.js';
import { configureAnalytics, startAnalytics, stopAnalytics, clearAccountAnalytics, flushAnalytics, trackAsset, analyticsNativeState } from './analytics.js';
import { openAnalytics } from './analytics-ui.js';
import { openProgress,bindVideoProgress,progressNativeState,flushProgress,clearAccountProgress } from './progress.js';
import { downloadToDevice,listDownloads,removeDownload,openDownloaded,closeDownloads,clearAccountDownloads,downloadsNativeState } from './downloads.js';
import { openSeriesManager,mountSeriesNavigation,seriesNativeState } from './series-ui.js';
import { createTheme } from './theme.js';
import { openSettings } from './settings.js';
import { createViewerScreen } from './viewer-shell.js';
import { initializeNativePlayback,openNativePlayback,refreshNativePlayback } from './native-playback.js';
import { nativePlayerAvailable } from './native-player-bridge.js';
import { mountVideoPlayer } from './video-player.js';
import { AUDIO_EXTENSIONS, isTimedKind } from '../../server/audio-types.js';
import { VIDEO_EXTENSIONS } from '../../server/video-types.js';
import { beginUpdateActivity } from './update-busy.js';
import { initializeAppUpdates, refreshAppUpdates, appUpdatesEndpointChanged, mountAppUpdates, openAppUpdates } from './app-updates.js';
import './app-updates.css';

const theme = createTheme();
const defaultApkUrl = 'https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/download/v0.2.3beta/mirea-0.2.3beta-android.apk';

const root = document.querySelector('#app');
const roleName = { owner: '管理者', editor: '編集者', viewer: '閲覧者' };
const icons = {
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
let series=[],activeSeries='';
let seriesContinuous=true;
let thumbnailRequest, thumbnailObserver, thumbnailUrls = [], videoPreviews;
let nativeAppActive = true, nativeStateRevision = 0;
if (native) {
  App.addListener('appStateChange', ({ isActive }) => {
    nativeStateRevision++;
    nativeAppActive = isActive;
    if (isActive) {refreshAppUpdates();refreshNativePlayback().catch(()=>{});}
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
      authenticatedBlob(img.dataset.thumbnail, signal).then(blob => {
        if (signal.aborted || !img.isConnected) return;
        const url = URL.createObjectURL(blob);
        thumbnailUrls.push(url);
        img.onload = () => img.parentElement?.classList.add('cover-loaded');
        img.src = url;
      }).catch(error => {
        if (signal.aborted || !img.isConnected) return;
        const placeholder = img.parentElement.querySelector('.cover-placeholder');
        if (placeholder) { placeholder.textContent = '表紙を読み込めません'; placeholder.title = error.message; }
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
  document.querySelectorAll('.viewer-screen').forEach(node => node.close());
  series=[];activeSeries='';seriesContinuous=true;
  closeDownloads();
  clearThumbnails();
  root.innerHTML = `<main class="auth-layout"><section class="auth-story"><a class="brand" href="/" aria-label="Mirea ホーム"><span class="brand-mark">m</span>Mirea<span class="brand-dot">.</span></a>
    <div class="auth-story-copy"><span class="eyebrow">YOUR SHARED MEDIA LIBRARY</span><h1>見たい。読みたい。<br>そのすべてを、<br><span>ひとつの本棚に。</span></h1><p>お気に入りの動画も、大切な一冊も、好きな音楽も。<br>あなただけの場所に集めて、必要な人と共有しよう。</p></div>
    <div class="auth-art" aria-hidden="true"><div class="art-book">${icon('book')}<span>A space<br>for your stories.</span><small>MIREA / LIBRARY</small></div><div class="art-video">${icon('video')}<div class="art-horizon"></div><small>WATCH. READ. SHARE.</small></div><div class="art-chip">${icon('users')} ひとつの本棚を、一緒に。</div></div>
    <span class="auth-footer">動画と本と音楽の、あなたらしい居場所。</span></section>
    <section class="auth-form-area"><div class="auth-form-wrap"><span class="mobile-brand">Mirea.</span><span class="eyebrow">WELCOME TO MIREA</span><h2>${register ? 'アカウントを作成' : 'おかえりなさい。'}</h2><p class="muted">${register ? 'あなたのライブラリを、ここから始めましょう。' : 'ログインして、あなたの本棚を開きましょう。'}</p>
    <form id="auth-form">${native ? `<label>サーバーURL<input name="server" type="url" placeholder="https://mirea.example.com" value="${esc(getEndpoint())}" required autocomplete="url"><small>利用するMireaサーバーのHTTPS URL</small></label>` : ''}
      ${register ? '<label>表示名<input name="name" autocomplete="name" maxlength="80" required placeholder="例：水蓮 太郎"></label>' : ''}
      <label>メールアドレス<input name="email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com" required></label>
      <label>パスワード<input name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="12" maxlength="128" placeholder="12文字以上" required></label>
      <p class="form-error" role="alert" hidden></p><button class="button primary auth-submit" type="submit">${register ? 'アカウントを作成する' : 'ログインする'}${icon('arrow')}</button>
    </form><p class="auth-switch">${register ? 'すでにアカウントをお持ちですか？' : 'はじめてご利用ですか？'} <button class="text-button" id="switch-auth">${register ? 'ログイン' : 'アカウントを作成'}</button></p><a class="auth-apk" href="${esc(config.androidApkUrl || defaultApkUrl)}" target="_blank" rel="noopener noreferrer">${icon('download')} Android版APKをダウンロード</a><div class="auth-note">${icon('shelf')} 本棚ごとに、共有する相手を選べます。</div></div></section></main>`;
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
      const body = { email: form.elements.email.value.trim(), password: form.elements.password.value };
      if (register) body.name = form.elements.name.value.trim();
      setSession(await api(register ? '/auth/register' : '/auth/login', { method: 'POST', body }));
      form.reset();
      await loadConfig();
      await startAnalytics();
      renderShell();
      await refresh();
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    finally { submit.disabled = false; }
  };
}

function renderShell() {
  clearThumbnails();
  const user = getSession().user;
  root.innerHTML = `<div class="app-layout"><aside class="sidebar"><a class="brand" href="/" aria-label="Mirea ホーム"><span class="brand-mark">m</span>Mirea<span class="brand-dot">.</span></a>
    <div class="workspace-label">MY WORKSPACE <span>PRIVATE</span></div><nav aria-label="ライブラリ"><button id="nav-all" class="nav-item">${icon('library')}<span>すべてのコンテンツ</span><span class="nav-count"></span></button>
    <div class="sidebar-heading"><span>本棚</span><button id="add-shelf" class="icon-button" aria-label="本棚を作成">${icon('plus')}</button></div><div id="shelf-nav"></div></nav>
    <div class="sidebar-hint">${icon('users')}<strong>好きなものを、共有しよう。</strong><p>本棚にメンバーを追加して、<br>動画・本・音楽を一緒に楽しめます。</p></div>
    <button id="nav-settings" class="nav-item settings-nav">${icon('settings')}<span>設定</span></button><a class="nav-item apk-nav" href="${esc(config.androidApkUrl || defaultApkUrl)}" target="_blank" rel="noopener noreferrer">${icon('download')}<span>Androidアプリ</span></a>
    <div class="profile"><span class="avatar">${esc(user.name.slice(0, 1))}</span><div><strong>${esc(user.name)}</strong><small>${esc(user.email)}</small></div><button id="logout" class="icon-button" aria-label="ログアウト">${icon('logout')}</button></div></aside>
    <main class="main-content"><header class="topbar"><div class="breadcrumb">ワークスペース <span>/</span> <strong id="breadcrumb-title">ライブラリ</strong></div><span class="topbar-label">YOUR PERSONAL COLLECTION</span><button id="mobile-settings" class="icon-button mobile-settings" aria-label="設定">${icon('settings')}</button><button id="mobile-logout" class="icon-button mobile-logout" aria-label="ログアウト">${icon('logout')}</button></header>
    <div class="content-wrap"><section class="page-heading"><div><span class="eyebrow">THE LIBRARY, REIMAGINED</span><h1 id="page-title">あなたのライブラリ<span class="title-dot">.</span></h1><p id="page-description">動画も本も音楽も、ここに。お気に入りを集めた、あなたの場所。</p></div><div class="heading-actions"><button class="button secondary" id="manage-members" hidden>${icon('users')}共有設定</button><button class="button secondary" id="upload-jobs">アップロード処理</button><button class="button primary" id="open-upload">${icon('plus')}コンテンツを追加</button></div></section>
    <section class="library-overview" aria-label="ライブラリの概要"><div class="overview-message"><div class="overview-icon">${icon('shelf')}</div><div><span class="eyebrow">A LITTLE SPACE FOR BIG IDEAS</span><h2>好きな時間を、好きな本棚で。</h2><p>ひとりで楽しむ。みんなで分かち合う。</p></div></div><div class="stats"><div><strong id="stat-total">—</strong><span>コンテンツ</span></div><div><strong id="stat-book">—</strong><span>本</span></div><div><strong id="stat-video">—</strong><span>動画</span></div><div><strong id="stat-audio">—</strong><span>音声・音楽</span></div></div></section>
    <section class="collection"><div class="collection-toolbar"><div class="tabs" role="group" aria-label="種類で絞り込み"><button data-filter="all" class="tab active">すべて <span id="count-all">0</span></button><button data-filter="book" class="tab">${icon('book')}本 <span id="count-book">0</span></button><button data-filter="video" class="tab">${icon('video')}動画 <span id="count-video">0</span></button><button data-filter="audio" class="tab">${icon('audio')}音声 <span id="count-audio">0</span></button></div><div class="collection-tools"><label class="search-field">${icon('search')}<input id="search" type="search" placeholder="タイトルで検索" aria-label="タイトルで検索"></label><label class="sr-only" for="sort">並び順</label><select id="sort"><option value="recent">追加が新しい順</option><option value="name">タイトル順</option></select></div></div><div class="collection-caption"><h2 id="collection-title">すべてのコンテンツ</h2><span id="result-count"></span></div><div id="items" class="item-grid" aria-live="polite"><p class="loading-state">ライブラリを読み込んでいます…</p></div></section>
    <footer class="library-footer"><span>Mirea<span class="brand-dot">.</span></span><span>あなたの物語が、ここにある。</span></footer></div></main></div>`;
  document.querySelector('#add-shelf').onclick = openCreateShelf;
  document.querySelector('#nav-all').onclick = () => selectShelf(null);
  document.querySelector('#open-upload').onclick = openUpload;
  document.querySelector('#upload-jobs').onclick = openUploadJobs;
  document.querySelector('#manage-members').onclick = openMembers;
  document.querySelector('#nav-settings').onclick = document.querySelector('#mobile-settings').onclick = showSettings;
  const seriesControls=document.createElement('section');seriesControls.className='series-controls';seriesControls.setAttribute('aria-label','シリーズ');
  seriesControls.innerHTML='<div class="series-controls-heading"><label>シリーズ<select id="series-filter" aria-label="シリーズで絞り込み"></select></label><button class="button secondary" id="manage-series">シリーズを管理</button></div><p id="series-description" class="muted"></p>';
  document.querySelector('.collection-caption').before(seriesControls);
  document.querySelector('#manage-series').onclick=()=>manageSeries();
  document.querySelector('#series-filter').onchange=e=>{activeSeries=e.target.value;filter='all';search='';document.querySelector('#search').value='';renderItems();};
  const analyticsActions=document.createElement('div');
  analyticsActions.className='analytics-actions';
  analyticsActions.innerHTML='<button class="button secondary" id="my-history">自分の閲覧記録</button><button class="button secondary" id="shelf-analytics" hidden>本棚の匿名集計</button><button class="button secondary" id="global-analytics" hidden>全体の匿名集計</button><small>閲覧位置・時間・操作履歴は無期限保存されます。個人の詳細は本人のみ閲覧できます。</small><small id="analytics-delivery" role="status"></small>';
  document.querySelector('.page-heading').after(analyticsActions);
  const downloadsButton=document.createElement('button');downloadsButton.className='button secondary';downloadsButton.textContent='端末のダウンロード';downloadsButton.onclick=openDownloadManager;analyticsActions.prepend(downloadsButton);
  analyticsActions.querySelector('#my-history').onclick=()=>openAnalytics({dialog,api,flush:flushAnalytics,esc});
  analyticsActions.querySelector('#shelf-analytics').onclick=()=>openAnalytics({dialog,api,flush:flushAnalytics,esc,shelfId:activeShelf});
  const globalButton=analyticsActions.querySelector('#global-analytics');
  globalButton.onclick=()=>openAnalytics({dialog,api,flush:flushAnalytics,esc,global:true});
  api('/analytics/access').then(access=>{if(globalButton.isConnected)globalButton.hidden=!access.canViewGlobal;}).catch(()=>{});
  if (!config.analytics?.enabled) analyticsActions.querySelector('small').textContent='閲覧記録の収集はサーバー設定で停止しています。過去の記録は確認できます。';
  const logout = async () => {
    try { clearThumbnails(); document.querySelectorAll('dialog,.viewer-screen').forEach(node=>node.close()); await Promise.all([flushAnalytics(),flushProgress()]); await stopAnalytics(); await api('/auth/logout', { method: 'POST' }); setSession(null); loadGeneration++; shelves = []; items = []; activeShelf = null; renderAuth(); }
    catch (error) { report(error); }
  };
  document.querySelector('#logout').onclick = logout;
  document.querySelector('#mobile-logout').onclick = logout;
  document.querySelector('#search').oninput = e => { search = e.target.value; renderItems(); };
  document.querySelector('#sort').onchange = e => { sort = e.target.value; renderItems(); };
  document.querySelectorAll('[data-filter]').forEach(button => { button.onclick = () => { filter = button.dataset.filter; renderItems(); }; });
}

function showSettings() {
  const actor=getSession(),server=getEndpoint();
  const current=()=>getSession()===actor && getEndpoint()===server;
  openSettings({ dialog, api, esc, theme, apkUrl: config.androidApkUrl || defaultApkUrl, version: config.version || '0.2.3-beta', manageShelf: id => openMembers(id), mountUpdates: native ? mountAppUpdates : null,
    onUpdated: async result => { if(!current())return;closeDownloads();setSession(result);await stopAnalytics().catch(()=>{});if(getSession()!==result || getEndpoint()!==server)return;await startAnalytics();if(getSession()!==result || getEndpoint()!==server)return;renderShell();await refresh();toast('アカウント情報を更新しました。他の端末では再ログインが必要です。'); },
    onDeleted: async () => { if(!current())return;const results=await Promise.allSettled([clearAccountDownloads(),clearAccountAnalytics(),clearAccountProgress()]);if(!current())return;const cacheError=results.some(r=>r.status==='rejected');clearThumbnails();setSession(null);loadGeneration++;shelves=[];items=[];activeShelf=null;renderAuth();toast(cacheError?'アカウントを削除しました。端末内データを消去できませんでした。ブラウザーのサイトデータを削除してください。':'アカウントと個人の記録、この端末のダウンロードを削除しました。'); }
  });
}

async function refresh() {
  const generation = ++loadGeneration;
  const node = document.querySelector('#items');
  if (!node) return;
  clearThumbnails();
  node.innerHTML = '<p class="loading-state">ライブラリを読み込んでいます…</p>';
  try {
    const response = await api('/shelves');
    if (generation !== loadGeneration) return;
    shelves = response.shelves;
    if (activeShelf && !shelves.some(s => s.id === activeShelf)) activeShelf = null;
    const targets = activeShelf ? shelves.filter(s => s.id === activeShelf) : shelves;
    const results = await Promise.all(targets.map(s => api(`/shelves/${s.id}/items`)));
    if (generation !== loadGeneration) return;
    items = results.flatMap(result => result.items.map(item => ({ ...item, shelfName: result.shelf.name, role: result.shelf.role })));
    series=results.flatMap(result=>result.series.map(s=>({...s,shelfName:result.shelf.name,role:result.shelf.role})));
    if(activeSeries && activeSeries!=='ungrouped' && !series.some(s=>s.id===activeSeries))activeSeries='';
    renderNav();
    renderItems();
  } catch (error) {
    if (generation !== loadGeneration || !getSession()) return;
    node.innerHTML = `<div class="empty-state"><h3>ライブラリを読み込めませんでした</h3><p>${esc(error.message)}</p><button class="button secondary" id="retry-library">もう一度読み込む</button></div>`;
    node.querySelector('button').onclick = refresh;
  }
}
function selectShelf(id) {
  activeShelf = id;
  activeSeries='';
  search = '';
  document.querySelector('#search').value = '';
  refresh();
}
function renderNav() {
  const current = shelves.find(s => s.id === activeShelf);
  document.querySelector('#nav-all').classList.toggle('active', !current);
  document.querySelector('.nav-count').textContent = shelves.reduce((n, s) => n + s.itemCount, 0);
  document.querySelector('#shelf-nav').innerHTML = shelves.length ? shelves.map((s, index) => `<button class="nav-item shelf-nav ${s.id === activeShelf ? 'active' : ''}" data-shelf="${esc(s.id)}"><span class="shelf-dot color-${index % 4}"></span><span>${esc(s.name)}</span>${s.memberCount > 1 ? icon('users', 'shared-icon') : ''}<span class="nav-count">${s.itemCount}</span></button>`).join('') : '<p class="sidebar-empty">本棚を作成して<br>コレクションを始めましょう。</p>';
  document.querySelectorAll('[data-shelf]').forEach(button => { button.onclick = () => selectShelf(button.dataset.shelf); });
  document.querySelector('#page-title').innerHTML = `${esc(current?.name ?? 'あなたのライブラリ')}<span class="title-dot">.</span>`;
  document.querySelector('#breadcrumb-title').textContent = current?.name ?? 'ライブラリ';
  document.querySelector('#page-description').textContent = current ? current.description || `${roleName[current.role]}として参加している本棚です。` : '動画も本も音楽も、ここに。お気に入りを集めた、あなたの場所。';
  document.querySelector('#manage-members').hidden = current?.role !== 'owner';
  document.querySelector('#shelf-analytics').hidden = current?.role !== 'owner';
  document.querySelector('#open-upload').hidden = Boolean(current && current.role === 'viewer');
}
function renderItems() {
  const node = document.querySelector('#items');
  if (!node) return;
  clearThumbnails();
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
  const seriesSelect=document.querySelector('#series-filter');
  seriesSelect.innerHTML='<option value="">すべてのシリーズ・単独作品</option><option value="ungrouped">シリーズ未所属</option>'+series.map(s=>`<option value="${s.id}">${esc(s.title)}${activeShelf?'':` · ${esc(s.shelfName)}`} (${s.assetCount}件)</option>`).join('');
  seriesSelect.value=activeSeries;
  const manage=document.querySelector('#manage-series');manage.hidden=!shelves.some(s=>s.role!=='viewer');manage.textContent=selectedSeries && selectedSeries.role!=='viewer'?'このシリーズを編集':'シリーズを管理';
  document.querySelector('#series-description').textContent=selectedSeries?`${selectedSeries.description ? selectedSeries.description+' · ' : ''}巻・話の設定順に表示しています。`:'本・動画・音声をシリーズにまとめて、順番に楽しめます。';
  const sortSelect=document.querySelector('#sort');sortSelect.disabled=Boolean(selectedSeries);
  if(!sortSelect.querySelector('[value="series"]'))sortSelect.insertAdjacentHTML('beforeend','<option value="series" disabled>シリーズの設定順</option>');
  sortSelect.value=selectedSeries?'series':sort;
  const selected = items.filter(item => (!activeSeries || (activeSeries==='ungrouped'?!item.series:item.series?.id===activeSeries)) && (filter === 'all' || (filter === 'book' ? !isTimedKind(item.kind) : filter === item.kind)) && `${item.title} ${item.series?.title??''} ${item.series?.label??''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => selectedSeries?a.series.position-b.series.position:sort === 'name' ? a.title.localeCompare(b.title, 'ja') : b.createdAt - a.createdAt);
  document.querySelector('#collection-title').textContent = filter === 'book' ? '本（PDF・EPUB・画像）' : filter === 'audio' ? '音声・音楽' : filter === 'video' ? '動画' : 'すべてのコンテンツ';
  if(selectedSeries)document.querySelector('#collection-title').textContent=selectedSeries.title;
  document.querySelector('#result-count').textContent = `${selected.length} 件のコンテンツ`;
  if (!selected.length) {
    const hasFilter = Boolean(search || filter !== 'all' || activeSeries);
    node.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon(hasFilter ? 'search' : 'library')}</div><span class="eyebrow">${hasFilter ? 'FIND YOUR NEXT STORY' : 'MAKE YOURSELF AT HOME'}</span><h3>${hasFilter ? '該当するコンテンツがありません' : shelves.length ? '最初の一冊、最初の一本を。' : 'あなたの本棚を、つくろう。'}</h3><p>${hasFilter ? '検索キーワードや種類を変えてみてください。' : shelves.length ? '本や動画・音声を追加して、あなただけのライブラリを育てましょう。' : '本棚を作って本・動画・音声を追加すると、ここに並びます。'}</p>${hasFilter ? '<button class="button secondary" id="empty-action">絞り込みを解除</button>' : !shelves.length || shelves.some(s => s.role !== 'viewer') ? `<button class="button primary" id="empty-action">${icon('plus')}${shelves.length ? 'コンテンツを追加' : '本棚を作成'}</button>` : '<p class="muted">管理者・編集者による追加をお待ちください。</p>'}</div>`;
    const action = node.querySelector('#empty-action');
    if (action) action.onclick = hasFilter ? () => { search = ''; filter = 'all'; activeSeries=''; document.querySelector('#search').value = ''; renderItems(); } : shelves.length ? openUpload : openCreateShelf;
    return;
  }
  node.innerHTML = selected.map(item => {
    const isBook = !isTimedKind(item.kind);
    const label = item.kind === 'image-book' ? `画像・${item.pageCount}ページ` : item.kind === 'epub' ? 'EPUB' : item.kind === 'pdf' ? 'PDF' : item.kind === 'audio' ? 'AAC / M4A' : item.mimeType === 'video/mp4' ? 'MP4' : 'WebM';
    return `<article class="media-card"><button class="card-open" data-open="${item.id}" ${item.kind==='video' ? `data-preview-id="${item.id}"` : ''} aria-label="${esc(item.title)}を${isBook ? '読む' : '再生する'}"><div class="card-art actual-cover ${isBook ? 'book-cover' : item.kind==='audio' ? 'audio-cover' : 'video-cover'}"><img data-thumbnail="${esc(item.thumbnailUrl)}" alt="${esc(item.title)}のサムネイル"><span class="cover-placeholder">${icon(isBook ? 'book' : item.kind==='audio' ? 'audio' : 'video')}<span>表紙を読み込んでいます…</span></span><span class="media-type">${item.kind === 'image-book' ? 'IMAGE BOOK' : item.kind==='epub' ? 'EPUB' : isBook ? 'PDF' : item.kind==='audio' ? 'AUDIO' : 'VIDEO'}</span><span class="card-open-label">${isBook ? '本を開く' : '再生する'} ${icon('arrow')}</span></div><div class="card-content"><span class="card-shelf">${icon('shelf')}${esc(item.shelfName)}</span><h3>${esc(item.title)}</h3><div class="card-meta"><span>${label} <span class="meta-dot">·</span> ${bytes(item.size)}</span><span>${date(item.createdAt)}</span></div><div class="card-progress">${esc(progressLabel(item,item.progress))}</div></div></button>${item.role !== 'viewer' ? `<button class="card-delete icon-button" data-delete="${item.id}" aria-label="${esc(item.title)}を削除">${icon('trash')}</button>` : ''}</article>`;
  }).join('');
  node.querySelectorAll('[data-open]').forEach(button => { button.onclick = () => openViewer(items.find(i => i.id === button.dataset.open)); });
  node.querySelectorAll('[data-delete]').forEach(button => { button.onclick = () => deleteItem(items.find(i => i.id === button.dataset.delete)); });
  node.querySelectorAll('.media-card').forEach(card=>{
    const id=card.querySelector('[data-open]').dataset.open,button=document.createElement('button');
    const item=items.find(item=>item.id===id);
    if(item.series){const badge=document.createElement('button');badge.className='card-series';badge.textContent=`${item.series.title} · ${item.series.label||`${item.series.position}番目`}`;badge.setAttribute('aria-label',`${item.series.title}で絞り込み`);badge.onclick=()=>{activeSeries=item.series.id;filter='all';search='';document.querySelector('#search').value='';renderItems();};card.append(badge);}
    button.className='card-download';button.dataset.download=id;button.textContent='暗号化ダウンロード';button.onclick=()=>openDownload(items.find(item=>item.id===id));card.append(button);
  });
  updateDownloadButtons();
  loadThumbnails();
  videoPreviews = mountVideoPreviews(node, { native, api, authenticatedBlob, trackPreview:(id,video)=>trackAsset(id,'preview')?.video(video) });
  videoPreviews.setPaused('native', !nativeAppActive);
}

function manageSeries(){
  const actor=getSession()?.user.id,endpoint=getEndpoint(),selected=series.find(s=>s.id===activeSeries && s.role!=='viewer');
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
  const editable = shelves.filter(s => s.role !== 'viewer');
  if (!editable.length) return openCreateShelf();
  const node = dialog('コンテンツを追加', `<form class="modal-body" id="upload-form"><label>追加する本棚<select name="shelf">${editable.map(s => `<option value="${s.id}" ${s.id === activeShelf ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label><label class="dropzone" id="dropzone"><input name="file" type="file" aria-label="アップロードするファイル" accept="application/epub+zip,.epub,application/pdf,video/*,audio/*,image/jpeg,image/png,image/webp,.pdf,.mp4,.m4v,.mov,.mkv,.avi,.wmv,.asf,.mpeg,.mpg,.ts,.mts,.m2ts,.flv,.webm,.mp3,.m4a,.m4b,.aac,.wav,.flac,.ogg,.oga,.opus,.aif,.aiff,.wma,.weba,.jpg,.jpeg,.png,.webp" multiple required>${icon('upload')}<strong id="file-label">ファイルを選択、またはドロップ</strong><span>PDF / EPUB / 動画 / 音声は1ファイル・画像は複数枚で1冊</span><small>JPEG / PNG / WebP（静止画）・合計 ${bytes(config.maxUploadBytes)}まで</small></label><div id="selected-files" hidden></div><label>タイトル<input name="title" maxlength="200" required placeholder="ライブラリに表示するタイトル"></label><label class="retain-original"><input name="retainOriginal" type="checkbox">動画・音声の原本を保持する</label><p class="retention-note">初期設定では、配信用の変換データ（動画は全画質）・サムネイルの生成と検証が成功した後、動画・音声の原本を削除します。元の画質・音質・形式が必要な場合はチェックしてください。失敗時は原本を残します。本の原本は削除しません。</p><p class="thumbnail-note">${icon('book')} 表紙はEPUBのカバー・PDFの1ページ目、動画のフレーム、音声のジャケット（なければ専用表紙）、画像の本の先頭ページから生成します。</p><div class="upload-progress" hidden><div><span id="upload-status">アップロード中…</span><span id="upload-percent">0%</span></div><progress max="100" value="0" aria-label="アップロードの進行状況"></progress></div><p class="form-error" role="alert" hidden></p><div class="modal-actions"><button class="button primary" type="submit">${icon('upload')}アップロードする</button></div></form>`);
  const form = node.querySelector('form'), input = form.elements.file, zone = node.querySelector('#dropzone');
  const errorBox = form.querySelector('.form-error');
  const mimeByExtension = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', epub: 'application/epub+zip', ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS };
  const imageMime = file => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
  let selectedFiles = [], activeUpload, lastDefaultTitle = '';
  const previewUrls = new Map();
  function showSelection() {
    const list = node.querySelector('#selected-files');
    list.hidden = !selectedFiles.length;
    const images = selectedFiles.length && selectedFiles.every(imageMime);
    node.querySelector('#file-label').textContent = images ? `${selectedFiles.length}枚の画像を1冊にまとめます` : selectedFiles[0] ? `${selectedFiles[0].name} (${bytes(selectedFiles[0].size)})` : 'ファイルを選択、またはドロップ';
    if (!images) { list.innerHTML = ''; return; }
    list.innerHTML = `<p class="page-order-note">上からページ順です。最初はファイル名の数字順です。矢印で変更できます。先頭ページが表紙になります。</p><ol class="page-order-list">${selectedFiles.map((file, index) => {
      if (!previewUrls.has(file)) previewUrls.set(file, URL.createObjectURL(file));
      return `<li><img src="${previewUrls.get(file)}" alt="${index + 1}ページ目のプレビュー" loading="lazy"><span class="page-order-number">${index + 1}</span><span class="page-order-name">${esc(file.name)}</span><button type="button" class="icon-button" data-page-up="${index}" aria-label="${index + 1}ページ目を前へ" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" class="icon-button" data-page-down="${index}" aria-label="${index + 1}ページ目を後ろへ" ${index === selectedFiles.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="icon-button" data-remove-file="${index}" aria-label="${index + 1}ページ目を取り除く">${icon('close')}</button></li>`;
    }).join('')}</ol>`;
    list.querySelectorAll('[data-page-up], [data-page-down]').forEach(button => { button.onclick = () => {
      const index = Number(button.dataset.pageUp ?? button.dataset.pageDown);
      const target = index + (button.dataset.pageUp === undefined ? 1 : -1);
      [selectedFiles[index], selectedFiles[target]] = [selectedFiles[target], selectedFiles[index]];
      showSelection();
    }; });
    list.querySelectorAll('[data-remove-file]').forEach(button => { button.onclick = () => {
      const [file] = selectedFiles.splice(Number(button.dataset.removeFile), 1);
      URL.revokeObjectURL(previewUrls.get(file)); previewUrls.delete(file);
      if (!selectedFiles.length) input.value = '';
      showSelection();
    }; });
  }
  const selectFiles = incoming => {
    for (const url of previewUrls.values()) URL.revokeObjectURL(url);
    previewUrls.clear();
    selectedFiles = Array.from(incoming).map(file => {
      const extension=file.name.split('.').pop().toLowerCase();
      // WebM can contain audio only. Preserve an explicit audio MIME from the
      // picker rather than forcing every .webm into the video processing path.
      const mime=extension==='webm' && file.type==='audio/webm' ? 'audio/webm' : mimeByExtension[extension] || file.type || 'application/octet-stream';
      return file.type===mime ? file : new File([file],file.name,{type:mime,lastModified:file.lastModified});
    });
    if (selectedFiles.every(imageMime)) selectedFiles.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' }));
    if (selectedFiles.length && (!form.elements.title.value || form.elements.title.value === lastDefaultTitle)) {
      lastDefaultTitle = selectedFiles[0].name.replace(/\.[^.]+$/, '').slice(0, 200);
      form.elements.title.value = lastDefaultTitle;
    }
    errorBox.hidden = true;
    showSelection();
  };
  input.onchange = () => selectFiles(input.files);
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('dragover'); };
  zone.ondragleave = () => zone.classList.remove('dragover');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('dragover'); if (activeUpload) return; if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; selectFiles(e.dataTransfer.files); } };
  node.addEventListener('close', () => { if(activeUpload?.processing)activeUpload.detach();else activeUpload?.abort(); for (const url of previewUrls.values()) URL.revokeObjectURL(url); }, { once: true });
  form.onsubmit = async e => {
    e.preventDefault();
    const button = form.querySelector('[type="submit"]');
    errorBox.hidden = true;
    let validation;
    const allImages = selectedFiles.every(imageMime);
    if (!selectedFiles.length) validation = 'ファイルを選択してください。';
    else if (selectedFiles.length > 1 && !allImages) validation = 'PDF・EPUB・動画・音声は1ファイルずつ、画像の本は画像だけを選択してください。';
    else if (selectedFiles.length > config.maxBookPages) validation = `1冊は${config.maxBookPages}ページまでです。`;
    else if (allImages && selectedFiles.some(file => file.size > config.maxImageBytes)) validation = `画像は1枚${bytes(config.maxImageBytes)}以下にしてください。`;
    else if (selectedFiles.some(file => file.type==='application/epub+zip' && file.size>(config.maxEpubBytes??64*1024*1024))) validation = 'EPUBは64 MiB以下にしてください。';
    else if (selectedFiles.reduce((sum, file) => sum + file.size, 0) > config.maxUploadBytes) validation = `合計${bytes(config.maxUploadBytes)}以下で選択してください。`;
    if (validation) { errorBox.textContent = validation; errorBox.hidden = false; return; }
    button.disabled = true;
    form.querySelectorAll('input, select, [data-page-up], [data-page-down], [data-remove-file]').forEach(el => { el.disabled = true; });
    node.querySelector('.upload-progress').hidden = false;
    node.querySelector('#upload-status').textContent = '分割して送信しています。通信失敗後は同じファイルで再試行できます。';
    activeUpload = upload(form.elements.shelf.value, selectedFiles, form.elements.title.value.trim(), (percent,processing) => {
      node.querySelector('progress').value = percent;
      node.querySelector('#upload-percent').textContent = `${percent}%`;
      if (percent === 100) node.querySelector('#upload-status').textContent = processing ? processingLabel(processing)+'（画面を閉じても継続します）' : 'メディアを確認しています…';
    },{retainOriginal:form.elements.retainOriginal.checked});
    try { await activeUpload.promise; activeUpload = null; node.close(); await refresh(); toast('コンテンツを追加しました。'); }
    catch (error) { if (node.isConnected) { errorBox.textContent = error.message; errorBox.hidden = false; } }
    finally { button.disabled = false; form.querySelectorAll('input, select').forEach(el => { el.disabled = false; }); if (node.isConnected) showSelection(); activeUpload = null; }
  };
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
async function openViewer(item,{startAtBeginning=false,autoplay=false,background=false}={}) {
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
  const seriesNavigation=mountSeriesNavigation({node,body,item,api,esc,open:openViewer,enabled:seriesContinuous,onEnabled:value=>{seriesContinuous=value;},
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
      let stream;
      const renew=()=>api(`/items/${item.id}/playback-ticket`,{method:'POST'});
      const player=mountVideoPlayer(body,{onError,kind:item.kind,title:item.title,reconnect:async()=>{body.querySelector('.viewer-error')?.remove();if(downloaded)return downloaded.reconnect();await stream.reconnect();return null;}});
      let coverUrl;
      if(item.kind==='audio'){
        try{
          coverUrl=URL.createObjectURL(await authenticatedBlob(item.thumbnailUrl??`/api/v1/items/${item.id}/thumbnail`));
          if(!node.isConnected){URL.revokeObjectURL(coverUrl);player.dispose();return;}
          player.surface.querySelector('img').src=coverUrl;player.surface.querySelector('img').hidden=false;
        }catch{/* Audio remains usable when the cover request fails. */}
      }
      const video = player.video;
      const videoProgress=bindVideoProgress(video,progress);
      cleanup=()=>{videoProgress();stream?.dispose();player.dispose();if(coverUrl)URL.revokeObjectURL(coverUrl);};cleanup.restart=()=>videoProgress.restart();
      tracker?.video(video,player.surface);
      seriesNavigation.bindVideo(video,{autoplay});
      if(downloaded){
        video.src=downloaded.url(0);
        tracker?.quality({selectedQuality:downloaded.manifest.files[0].quality??'download',actualQuality:downloaded.manifest.files[0].quality??'download',streamKind:'download'});
      }else stream=attachVideoStream(video,{ticket,absoluteUrl,renew,onError,onQuality:value=>tracker?.quality(value),onOptions:options=>player.setQuality(options,value=>stream?.choose(value))});
      if(downloaded)video.setAttribute('controlsList','nodownload');
    }
    restart.disabled=false;
    if(downloaded){const badge=document.createElement('span');badge.className='download-source';badge.textContent='端末の暗号化データを使用（今回のアクセス権確認済み）';progressBar.prepend(badge);}
  } catch (error) { onError(error); }
}
async function updateDownloadButtons(){
  const actor=getSession()?.user.id,endpoint=getEndpoint();
  try{const rows=await listDownloads();if(getSession()?.user.id!==actor || getEndpoint()!==endpoint)return;
    for(const button of document.querySelectorAll('[data-download]')){const row=rows.find(row=>row.assetId===button.dataset.download);button.textContent=row?.state==='ready'?'暗号化保存済み':row?'ダウンロードを再開':'暗号化ダウンロード';}
  }catch{/* Online browsing still works without local storage. */}
}
function openDownload(item){
  if(!item)return;
  const node=dialog('端末へ暗号化ダウンロード',`<div class="modal-body"><h3>${esc(item.title)}</h3><p>本・動画・音声のデータはAES-256-GCMで暗号化してアプリ／ブラウザー内に保存します。復号鍵は閲覧中のメモリーにだけ保持します。開くたびにオンラインでアクセス権を確認するため、完全オフラインでは開けません。</p><p>画面を閉じると取得を一時停止します。次回は受信済み部分から再開できます。</p><div class="download-quality" hidden><label>保存する画質<select aria-label="ダウンロード画質"></select></label><small>1アセットにつき1画質を保存します。変更すると以前の保存データを置き換えます。</small></div><progress class="download-progress" max="100" value="0" aria-label="ダウンロードの進行状況"></progress><p class="download-status" role="status">${bytes(item.size)}・端末の空き容量が必要です。</p><div class="modal-actions"><button class="button primary start-download">保存を開始／再開</button></div></div>`);
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
    try{await downloadToDevice(item,({received,total})=>{if(node.isConnected){node.querySelector('progress').value=received/total*100;status.textContent=`${bytes(received)} / ${bytes(total)}`;}},controller.signal,node.querySelector('.download-quality select')?.value||undefined);if(node.isConnected)status.textContent='暗号化して保存しました。開く際には毎回オンラインで権限を確認します。';await updateDownloadButtons();}
    catch(error){if(node.isConnected)status.textContent=error.name==='QuotaExceededError'?'端末の保存容量が不足しています。不要なダウンロードを削除してください。':error.message;}
    finally{if(node.isConnected)button.disabled=false;}
  };
}
function openDownloadManager(){
  const node=dialog('この端末のダウンロード','<div class="modal-body"><p>保存内容は暗号化されています。別アカウントとは共有せず、開く際は毎回オンライン認証が必要です。ここから削除してもサーバーの原本や閲覧履歴は消えません。</p><div class="download-list">読み込んでいます…</div></div>');
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
async function loadConfig() {
  if (native && !getEndpoint()) return;
  try { config = { ...config, ...await api('/config') }; configureAnalytics(config.analytics); } catch { /* the login action presents connection errors */ }
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
initializeNativePlayback().catch(()=>{});
await loadConfig();
if (getSession()) {
  try { await api('/auth/me'); await startAnalytics(); renderShell(); await refresh(); }
  catch { setSession(null); renderAuth(); }
} else renderAuth();
window.addEventListener('mirea:analytics-status',event=>{
  const node=document.querySelector('#analytics-delivery');
  if(node)node.textContent=event.detail==='pending'?'閲覧記録は端末で送信待ちです。再接続時に再送します。':'閲覧記録の一部を保存・送信できませんでした。';
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
