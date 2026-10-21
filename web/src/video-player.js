import { mountMediaSession } from './media-session.js';
import { mountVideoHold } from './video-hold.js';
import { heatmapGeometry } from './replay-heatmap.js';
import { bindSeekInteraction } from './seek-interaction.js';

let playbackPreferences={muted:false,volume:1,rate:1};
export const formatVideoTime = value => {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
export function seekVideo(video, value) { if (Number.isFinite(value) && Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(video.duration, Math.max(0, value)); }
export function mountVideoPlayer(container, { onError = () => {}, reconnect, kind = 'video', title = '', coverUrl, doc = document } = {}) {
  const audioMode = kind === 'audio';
  container.innerHTML = `<div class="mirea-player" tabindex="0" aria-label="動画プレーヤー"><video playsinline preload="metadata" aria-label="本編動画"></video><div class="player-loading" role="status" hidden>読み込み中…</div><button class="player-center" type="button" aria-label="動画を再生">▶</button><div class="player-controls"><label class="player-scrubber"><span class="sr-only">再生位置</span><input class="player-seek" type="range" min="0" max="1" step="0.01" value="0" disabled></label><div class="player-control-row"><button class="player-play" type="button" aria-label="再生">▶</button><button class="player-backward" type="button" aria-label="10秒戻る">−10</button><button class="player-forward" type="button" aria-label="10秒進む">＋10</button><span class="player-time">0:00 / 0:00</span><div class="player-volume-controls"><button class="player-mute" type="button" aria-label="消音">♫</button><label><span class="sr-only">音量</span><input class="player-volume" type="range" min="0" max="1" step="0.05" value="1"></label></div><label class="player-speed"><span class="sr-only">再生速度</span><select aria-label="再生速度"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><label class="player-quality" hidden><span class="sr-only">画質</span><select aria-label="画質"></select></label><button class="player-reconnect" type="button" aria-label="動画へ再接続">↻</button><button class="player-background" type="button" aria-label="ライブラリでバックグラウンド再生">背景</button><button class="player-pip" type="button" aria-label="ピクチャーインピクチャー" hidden>▣</button><button class="player-fullscreen" type="button" aria-label="全画面を切り替える">⛶</button></div><p class="player-help">Space 再生 / ← → シーク / M 消音 / F 全画面</p></div></div>`;
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
  }
  const video = root.querySelector('video,audio'), seek = root.querySelector('.player-seek'), volume = root.querySelector('.player-volume'), center = root.querySelector('.player-center');
  video.controls = false;video.muted=playbackPreferences.muted;video.volume=playbackPreferences.volume;video.playbackRate=playbackPreferences.rate;
  const listeners = []; let disposed = false, timer, scrubbing = false, hasHeatmap = false;
  const listen = (target, event, fn, options) => { target.addEventListener(event, fn, options); listeners.push(() => target.removeEventListener(event, fn, options)); };
  const hold=audioMode?null:mountVideoHold(video,{document:doc,changed:active=>{boostLabel.hidden=!active;root.classList.toggle('hold-boost',active);showControls();}});
  const announceControls = visible => root.dispatchEvent(new CustomEvent('viewer:player-controls', { bubbles:true, detail:visible }));
  const seekInteraction=bindSeekInteraction(seek,{document:doc,changed:active=>{scrubbing=active;heatmap.hidden=!hasHeatmap||!active;showControls();}});
  function showControls() { root.classList.remove('controls-hidden'); announceControls(true); clearTimeout(timer); if (!audioMode && !video.paused) timer = setTimeout(() => { if (!scrubbing && !video.paused && !root.querySelector('.player-controls').contains(doc.activeElement)) { root.classList.add('controls-hidden'); announceControls(false); } }, 2600); }
  const play = async () => { try { if (video.paused || video.ended) { if (video.ended) seekVideo(video, 0); await video.play(); } else video.pause(); } catch { if (!disposed) onError(new Error('再生を開始できません。再生ボタンを押すか、再接続してください。')); } };
  const fullscreen = () => { const screen = root.closest('.viewer-screen') ?? root; const result = doc.fullscreenElement ? doc.exitFullscreen?.() : screen.requestFullscreen?.(); result?.catch?.(() => {}); };
  function update() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    seek.disabled = !duration; seek.max = String(duration || 1); if (!scrubbing) seek.value = String(video.currentTime || 0);
    seek.style.setProperty('--played', `${duration ? video.currentTime / duration * 100 : 0}%`);
    seek.setAttribute('aria-valuetext', `${formatVideoTime(video.currentTime)} / ${formatVideoTime(duration)}`);
    root.querySelector('.player-time').textContent = `${formatVideoTime(video.currentTime)} / ${formatVideoTime(duration)}`;
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
  seek.oninput = () => { root.querySelector('.player-time').textContent = `${formatVideoTime(Number(seek.value))} / ${formatVideoTime(video.duration)}`; };
  seek.onchange = () => { seekVideo(video, Number(seek.value)); update(); };
  for(const event of ['loadstart','emptied','error','enterpictureinpicture'])listen(video,event,()=>seekInteraction.cancel());
  for (const event of ['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'pause', 'ended', 'volumechange']) listen(video, event, () => { update(); if (event !== 'timeupdate') showControls(); });
  for (const event of ['waiting', 'seeking', 'loadstart']) listen(video, event, () => { root.querySelector('.player-loading').hidden = false; });
  for (const event of ['playing', 'canplay', 'seeked', 'error']) listen(video, event, () => { root.querySelector('.player-loading').hidden = true; });
  listen(video, 'error', () => onError(new Error('メディアを再生できません。形式や接続を確認するか、再接続してください。')));
  listen(video, 'click', play); listen(root, 'pointermove', showControls); listen(root, 'pointerdown', showControls); listen(root, 'focusin', showControls);
  listen(root, 'keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName)) return;
    if ([' ', 'k', 'K'].includes(event.key)) { event.preventDefault(); play(); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seekVideo(video, video.currentTime + (event.key === 'ArrowRight' ? 5 : -5)); }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); video.volume = Math.min(1, Math.max(0, video.volume + (event.key === 'ArrowUp' ? .05 : -.05))); }
    else if (event.key.toLowerCase() === 'm') video.muted = !video.muted;
    else if (event.key.toLowerCase() === 'f') fullscreen();
    showControls();
  });
  root.querySelector('.player-background').onclick=()=>{seekInteraction.cancel();root.closest('.viewer-screen')?.minimize?.();};
  const mediaSession=mountMediaSession(video,{title,kind,artwork:coverUrl,stop:()=>root.closest('.viewer-screen')?.close(),onError,document:doc});
  const pipButton=root.querySelector('.player-pip');pipButton.hidden=!mediaSession.supportsPip;pipButton.onclick=()=>mediaSession.pip().catch(()=>onError(new Error('PiPに切り替えられません。動画を読み込んでから再試行してください。')));
  update(); root.focus();
  return { video, surface:audioMode?root.querySelector('.audio-art'):video, setHeatmap(value) {
    if(disposed||audioMode)return;const geometry=heatmapGeometry(value);hasHeatmap=Boolean(geometry);heatmap.replaceChildren();heatmap.hidden=!hasHeatmap||!seekInteraction.active;if(!geometry)return;
    const label=doc.createElement('span');label.className='player-heatmap-label';label.textContent=`${value.scope==='self'?'自分の再生傾向':'よく再生されている箇所（匿名集計）'} · ${formatVideoTime(geometry.peakMs/1000)}`;
    const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1000 40');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');
    const path=doc.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',geometry.path);svg.append(path);heatmap.append(label,svg);
  }, setQuality({qualities=[],selected='auto',actual='unknown',auto=true},choose) {
    const label=root.querySelector('.player-quality'),select=label.querySelector('select');
    label.hidden=!qualities.length;
    const values=[...(auto?[{value:'auto',text:'自動'+(actual!=='unknown'?'（現在 '+actual+'）':'')}]:[]),...qualities.filter(q=>/^\d{2,4}p$/.test(q.quality)).sort((a,b)=>parseInt(b.quality)-parseInt(a.quality)).map(q=>({value:q.quality,text:q.quality+'（固定）'}))];
    const key=values.map(v=>v.value).join(',');
    if(select.dataset.levels!==key){select.replaceChildren(...values.map(value=>{const option=doc.createElement('option');option.value=value.value;option.textContent=value.text;return option;}));select.dataset.levels=key;}
    else for(const value of values){const option=[...select.options].find(o=>o.value===value.value);if(option)option.textContent=value.text;}
    select.value=selected;select.onchange=()=>{hold?.cancel();choose(select.value);};
  }, dispose() { hold?.dispose();seekInteraction.dispose();playbackPreferences={muted:video.muted,volume:video.volume,rate:video.playbackRate};disposed = true; mediaSession.dispose(); clearTimeout(timer); for (const remove of listeners) remove(); video.pause(); video.removeAttribute('src'); video.load(); root.remove(); } };
}
