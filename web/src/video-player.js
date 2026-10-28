import {mountAudioMotion} from './audio-motion.js';
import {applyCoverPalette} from './cover-palette.js';
import { mountMediaSession } from './media-session.js';
import { mountVideoHold } from './video-hold.js';
import { heatmapGeometry } from './replay-heatmap.js';
import { bindSeekInteraction } from './seek-interaction.js';
import {playerKey} from './player-actions.js';
import {mountVideoNavigation} from './video-navigation.js';

let playbackPreferences={muted:false,volume:1,rate:1};
export const formatVideoTime = value => {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
export function seekVideo(video, value) { if (Number.isFinite(value) && Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(video.duration, Math.max(0, value)); }
export function mountVideoPlayer(container, { onError = () => {}, reconnect, kind = 'video', title = '', coverUrl, onNavigate=()=>{},editNavigation, playback, assetId='', doc = document } = {}) {
  const audioMode = kind === 'audio';
  container.innerHTML = `<div class="mirea-player" tabindex="0" aria-label="動画プレーヤー"><video playsinline preload="metadata" aria-label="本編動画"></video><div class="player-loading" role="status" hidden>読み込み中…</div><button class="player-center" type="button" aria-label="動画を再生">▶</button><div class="player-controls"><label class="player-scrubber"><span class="sr-only">再生位置</span><input class="player-seek" type="range" min="0" max="1" step="0.01" value="0" disabled></label><div class="player-control-row"><button class="player-play" type="button" aria-label="再生">▶</button><button class="player-backward" type="button" aria-label="10秒戻る">−10</button><button class="player-forward" type="button" aria-label="10秒進む">＋10</button><span class="player-time">0:00 / 0:00</span><div class="player-volume-controls"><button class="player-mute" type="button" aria-label="消音">♫</button><label><span class="sr-only">音量</span><input class="player-volume" type="range" min="0" max="1" step="0.05" value="1"></label></div><label class="player-speed"><span class="sr-only">再生速度</span><select aria-label="再生速度"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option></select></label><label class="player-quality" hidden><span class="sr-only">画質</span><select aria-label="画質"></select></label><button class="player-reconnect" type="button" aria-label="動画へ再接続">↻</button><button class="player-background" type="button" aria-label="ライブラリでバックグラウンド再生">バックグラウンド再生</button><button class="player-pip" type="button" aria-label="ピクチャーインピクチャー" hidden>▣</button><button class="player-fullscreen" type="button" aria-label="全画面を切り替える">⛶</button></div><p class="player-help">Space/K 再生 · J/L ±10秒 · ←/→ ±5秒 · 0–9 位置 · &lt;/&gt; 速度 · 停止中 ,/. コマ送り · F 全画面 · C 字幕</p></div></div>`;
  const root = container.querySelector('.mirea-player');
  const heatmap=doc.createElement('div');heatmap.className='player-heatmap';heatmap.hidden=true;root.querySelector('.player-scrubber').prepend(heatmap);
  const boostLabel=doc.createElement('div');boostLabel.className='player-boost';boostLabel.textContent='▶▶ 2× 早送り';boostLabel.hidden=true;boostLabel.setAttribute('role','status');root.append(boostLabel);
  if(audioMode){
    root.classList.add('audio-player');root.setAttribute('aria-label','音声プレーヤー');
    const audio=doc.createElement('audio');audio.preload='metadata';audio.setAttribute('aria-label','本編音声');
    root.querySelector('video').replaceWith(audio);
    const art=doc.createElement('div');art.className='audio-art';
    const image=doc.createElement('img');image.alt='ジャケット';if(coverUrl)image.src=coverUrl;else image.hidden=true;
    const label=doc.createElement('p');label.className='audio-kicker';label.textContent='MIREA / LISTEN';
    const heading=doc.createElement('h2');heading.textContent=title;
    art.append(image,label,heading);root.prepend(art);
    root.querySelector('.player-center').setAttribute('aria-label','音声を再生');
    root.querySelector('.player-reconnect').setAttribute('aria-label','音声へ再接続');
    root.querySelector('.player-help').textContent='Space/K 再生 · J/L ±10秒 · ←/→ ±5秒 · 0–9 位置 · </> 速度';
  }
  const modeControls=doc.createElement('div');modeControls.className='player-mode-controls';modeControls.innerHTML='<label><span class="sr-only">リピート</span><select class="player-repeat" aria-label="リピート"><option value="off">リピートなし</option><option value="one">単体リピート</option><option value="series">シリーズリピート</option></select></label><button type="button" class="player-shuffle" aria-pressed="false">シャッフル</button>';
  root.querySelector('.player-controls').append(modeControls);const modeSelect=modeControls.querySelector('select'),shuffleButton=modeControls.querySelector('button');
  const updateModes=()=>{const state=playback?.modeState??{};modeSelect.value=state.repeat??'off';modeSelect.querySelector('[value="series"]').disabled=!state.hasSeries;shuffleButton.disabled=!state.hasSeries;shuffleButton.setAttribute('aria-pressed',String(state.shuffle===true));shuffleButton.textContent=state.shuffle?'シャッフル：オン':'シャッフル：オフ';};
  modeSelect.onchange=()=>playback?.setModes({repeat:modeSelect.value});shuffleButton.onclick=()=>playback?.setModes({shuffle:!playback?.modeState.shuffle});const stopModes=playback?.subscribe(updateModes);updateModes();
  const video = root.querySelector('video,audio'), seek = root.querySelector('.player-seek'), volume = root.querySelector('.player-volume'), center = root.querySelector('.player-center');
  video.controls = false;video.muted=playbackPreferences.muted;video.volume=playbackPreferences.volume;video.playbackRate=playbackPreferences.rate;
  const listeners = []; let disposed = false, timer, clickTimer, scrubbing = false, hasHeatmap = false,navigation;
  const listen = (target, event, fn, options) => { target.addEventListener(event, fn, options); listeners.push(() => target.removeEventListener(event, fn, options)); };
  let artObserver;
  if(audioMode){const art=root.querySelector('.audio-art'),image=art.querySelector('img');if(typeof ResizeObserver!=='undefined'){artObserver=new ResizeObserver(entries=>art.style.setProperty('--audio-art-height',Math.max(0,entries[0].contentRect.height)+'px'));artObserver.observe(art);}listen(image,'load',()=>applyCoverPalette(root,image,assetId||title));if(image.complete&&image.naturalWidth)applyCoverPalette(root,image,assetId||title);}
  const hold=audioMode?null:mountVideoHold(video,{document:doc,changed:active=>{boostLabel.hidden=!active;root.classList.toggle('hold-boost',active);showControls();}});
  const announceControls = visible => root.dispatchEvent(new CustomEvent('viewer:player-controls', { bubbles:true, detail:visible }));
  const setSeeking=active=>{scrubbing=active||Boolean(navigation?.precise);heatmap.hidden=!hasHeatmap||!scrubbing;navigation?.scrub(scrubbing);if(!scrubbing)update();showControls();};
  const seekInteraction=bindSeekInteraction(seek,{document:doc,changed:setSeeking});
  if(!audioMode)navigation=mountVideoNavigation(root,video,seek,{doc,format:formatVideoTime,seekTo:value=>seekVideo(video,value),seeking:setSeeking,onError,edit:editNavigation});
  function showControls() { root.classList.remove('controls-hidden'); announceControls(true); clearTimeout(timer); if (!audioMode && !video.paused) timer = setTimeout(() => { if (!scrubbing && !video.paused && !root.querySelector('.player-controls').contains(doc.activeElement)) { root.classList.add('controls-hidden'); announceControls(false); } }, 2600); }
  const play = async () => { try {const playing=video.paused||video.ended;video.dispatchEvent(new CustomEvent('mirea:playback-intent',{detail:{playing}}));if(playing){if(video.ended)seekVideo(video,0);await video.play();}else video.pause();}catch{if(!disposed)onError(new Error('再生を開始できません。再生ボタンを押すか、再接続してください。'));}};
  const fullscreen = () => { const screen = root.closest('.viewer-screen') ?? root; const result = doc.fullscreenElement ? doc.exitFullscreen?.() : screen.requestFullscreen?.(); result?.catch?.(() => {}); };
  function update() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    seek.disabled = !duration; seek.max = String(duration || 1); if (!scrubbing) seek.value = String(video.currentTime || 0);
    seek.style.setProperty('--played', `${duration ? (scrubbing?Number(seek.value):video.currentTime) / duration * 100 : 0}%`);
    seek.setAttribute('aria-valuetext', `${formatVideoTime(video.currentTime)} / ${formatVideoTime(duration)}`);
    root.querySelector('.player-time').textContent = `${formatVideoTime(scrubbing?Number(seek.value):video.currentTime)} / ${formatVideoTime(duration)}`;
    root.querySelector('.player-play').textContent = video.paused ? '▶' : 'Ⅱ'; root.querySelector('.player-play').setAttribute('aria-label', video.paused ? '再生' : '一時停止');
    center.hidden = !video.paused; center.textContent = video.ended ? '↺' : '▶';
    root.querySelector('.player-mute').textContent = video.muted || video.volume === 0 ? '消音' : '♫'; root.querySelector('.player-mute').setAttribute('aria-label', video.muted ? '消音を解除' : '消音');
    volume.value = String(video.muted ? 0 : video.volume);
  }
  root.querySelector('.player-play').onclick = center.onclick = play;
  root.querySelector('.player-backward').onclick = () => seekVideo(video, video.currentTime - 10); root.querySelector('.player-forward').onclick = () => seekVideo(video, video.currentTime + 10);
  root.querySelector('.player-mute').onclick = () => { video.muted = !video.muted; };
  volume.oninput = () => { video.volume = Number(volume.value); video.muted = video.volume === 0; };
  root.querySelector('.player-speed select').value=String(video.playbackRate);
  root.querySelector('.player-speed select').onchange = event => { hold?.cancel();video.playbackRate = Number(event.target.value); };
  root.querySelector('.player-fullscreen').onclick = fullscreen;
  root.querySelector('.player-reconnect').onclick = async event => {
    hold?.cancel();seekInteraction.cancel();if (!reconnect) return; const button = event.currentTarget; button.disabled = true;
    try { const position = video.currentTime, playing = !video.paused, next = await reconnect(); if (disposed) return; if (!next) return; video.src = next; video.addEventListener('loadedmetadata', () => { if (!disposed) { seekVideo(video, position); if (playing) video.play().catch(() => {}); } }, { once: true }); video.load(); } catch (error) { if (!disposed) onError(error); } finally { if (!disposed) button.disabled = false; }
  };
  seek.oninput = () => { root.querySelector('.player-time').textContent = `${formatVideoTime(Number(seek.value))} / ${formatVideoTime(video.duration)}`;seek.style.setProperty('--played',`${Number(seek.value)/Math.max(1,video.duration)*100}%`); };
  seek.onchange = () => { if(!navigation?.precise)seekVideo(video, Number(seek.value)); update(); };
  for(const event of ['loadstart','emptied','error','enterpictureinpicture'])listen(video,event,()=>{navigation?.cancel();seekInteraction.cancel();});
  for (const event of ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked','play', 'pause', 'ended', 'volumechange','ratechange']) listen(video, event, () => { update();if(event==='ratechange'&&!hold?.active)root.querySelector('.player-speed select').value=String(video.playbackRate);if(event!=='timeupdate')showControls(); });
  for (const event of ['waiting', 'seeking', 'loadstart']) listen(video, event, () => { root.querySelector('.player-loading').hidden = false; });
  for (const event of ['playing', 'canplay', 'seeked', 'error']) listen(video, event, () => { root.querySelector('.player-loading').hidden = true; });
  listen(video, 'error', () => onError(new Error('メディアを再生できません。形式や接続を確認するか、再接続してください。')));
  let lastTouch=0,lastSide,zoom=1,pinchDistance,baseZoom=1;const pointers=new Map();
  listen(video,'pointerdown',e=>{if(audioMode||e.pointerType==='mouse')return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size===2){hold?.cancel();const p=[...pointers.values()];pinchDistance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);baseZoom=zoom;}});
  listen(video,'pointermove',e=>{if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size===2&&pinchDistance){const p=[...pointers.values()];zoom=Math.min(4,Math.max(1,baseZoom*Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)/pinchDistance));video.style.transform=`scale(${zoom})`;video.classList.toggle('zoomed',zoom>1);}});
  for(const type of ['pointerup','pointercancel'])listen(video,type,e=>{pointers.delete(e.pointerId);if(!pointers.size)pinchDistance=undefined;});
  listen(video,'enterpictureinpicture',()=>{zoom=1;video.style.transform='';});
  listen(video,'click',event=>{clearTimeout(clickTimer);if(event.pointerType==='touch'||event.pointerType==='pen'){const side=event.clientX<video.getBoundingClientRect().left+video.clientWidth/2?'backward':'forward',now=Date.now();if(now-lastTouch<300&&lastSide===side){seekVideo(video,video.currentTime+(side==='forward'?10:-10));lastTouch=0;}else{lastTouch=now;lastSide=side;showControls();}return;}clickTimer=setTimeout(()=>{if(!disposed)play();},230);});
  listen(video,'dblclick',event=>{if(event.pointerType==='touch'||event.pointerType==='pen')return;clearTimeout(clickTimer);event.preventDefault();fullscreen();});
  listen(root, 'pointermove', showControls); listen(root, 'pointerdown', showControls); listen(root, 'focusin', showControls);
  listen(root, 'keydown', event => {
    const focused=event.target===seek;if (!focused&&(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName)||event.target.isContentEditable)) return;
    const intent=playerKey(event,{paused:video.paused,seekFocused:focused});if(!intent)return;event.preventDefault();const [action,value]=intent;
    if(action==='play')play();else if(action==='seek'||action==='frame')seekVideo(video,video.currentTime+value/(action==='frame'?30:1));
    else if(action==='fraction')seekVideo(video,video.duration*value);else if(action==='volume')video.volume=Math.min(1,Math.max(0,video.volume+value));
    else if(action==='mute')video.muted=!video.muted;else if(action==='fullscreen')fullscreen();else if(action==='minimize')leavePlayer();
    else if(action==='speed'){hold?.cancel();video.playbackRate=Math.min(2,Math.max(.25,video.playbackRate+value));root.querySelector('.player-speed select').value=String(video.playbackRate);}
    else if(action==='navigate')onNavigate(value);else if(action==='chapter')navigation?.chapter(value);else if(action==='captions')navigation?.cycleCaptions();
    if(focused&&['seek','frame','fraction','chapter'].includes(action)){seek.value=String(video.currentTime);navigation?.scrub(seekInteraction.active);update();}
    showControls();
  });
  root.querySelector('.player-background').onclick=()=>leavePlayer();
  const mediaSession=mountMediaSession(video,{title,kind,artwork:coverUrl,previous:()=>onNavigate(-1),next:()=>onNavigate(1),stop:()=>root.closest('.viewer-screen')?.close(),onError,document:doc});
  const pipButton=root.querySelector('.player-pip');pipButton.hidden=!mediaSession.supportsPip;pipButton.onclick=()=>mediaSession.pip().catch(()=>onError(new Error('PiPに切り替えられません。動画を読み込んでから再試行してください。')));
  const screen=root.closest('.viewer-screen');
  if(screen)listen(screen,'viewer:presentation',()=>{if(!screen.isMinimized)mediaSession.exitPip();});
  const stopAudioMotion=audioMode?mountAudioMotion(root,video,{doc,screen}):null;
  async function leavePlayer(){
    seekInteraction.cancel();
    await mediaSession.background(()=>{if(!disposed)screen?.minimize?.();});
  }
  if(screen)screen.onReturn=leavePlayer;
  update(); root.focus();
  return { video, surface:audioMode?root.querySelector('.audio-art'):video, setArtwork:url=>mediaSession.setArtwork(url), setNavigation:(value,url)=>navigation?.set(value,url), setHeatmap(value) {
    if(disposed||audioMode)return;const geometry=heatmapGeometry(value);hasHeatmap=Boolean(geometry);heatmap.replaceChildren();heatmap.hidden=!hasHeatmap||!seekInteraction.active;if(!geometry)return;
    const label=doc.createElement('span');label.className='player-heatmap-label';label.textContent=`${value.scope==='self'?'自分の再生傾向':'よく再生されている箇所（匿名集計）'} · ${formatVideoTime(geometry.peakMs/1000)}`;
    const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1000 40');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');
    const path=doc.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',geometry.path);svg.append(path);heatmap.append(label,svg);
  }, setQuality({qualities=[],selected='auto',actual='unknown',auto=true},choose) {
    const label=root.querySelector('.player-quality'),select=label.querySelector('select');
    label.hidden=!qualities.length;
    const values=[...(auto?[{value:'auto',text:'自動'+(actual!=='unknown'?'（現在 '+actual+'）':'')},{value:'higher',text:'高画質優先'},{value:'data',text:'データセーバー'}]:[]),...qualities.filter(q=>/^\d{2,4}p$/.test(q.quality)).sort((a,b)=>parseInt(b.quality)-parseInt(a.quality)).map(q=>({value:q.quality,text:q.quality+'（固定）'}))];
    const key=values.map(v=>v.value).join(',');
    if(select.dataset.levels!==key){select.replaceChildren(...values.map(value=>{const option=doc.createElement('option');option.value=value.value;option.textContent=value.text;return option;}));select.dataset.levels=key;}
    else for(const value of values){const option=[...select.options].find(o=>o.value===value.value);if(option)option.textContent=value.text;}
    select.value=selected;select.onchange=()=>{hold?.cancel();choose(select.value);};
  }, dispose() { artObserver?.disconnect();stopAudioMotion?.();stopModes?.();hold?.dispose();navigation?.dispose();seekInteraction.dispose();playbackPreferences={muted:video.muted,volume:video.volume,rate:video.playbackRate};disposed = true;if(screen?.onReturn===leavePlayer)screen.onReturn=null; mediaSession.dispose(); clearTimeout(timer);clearTimeout(clickTimer); for (const remove of listeners) remove(); video.pause(); video.removeAttribute('src'); video.load(); root.remove(); } };
}
