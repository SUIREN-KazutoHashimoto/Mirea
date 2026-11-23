import './radio.css';
import {playerPreferences} from './player-preferences.js';
import {playerIcon,setPlayerIcon} from './player-icons.js';
import {mountLiveMediaSession} from './media-session.js';
import {createLiveCrossfader,readLiveFade} from './radio-crossfade.js';

export function openRadio({dialog, api, authenticatedBlob, sessionRevision, schedule = '/radio/now', headers, onDirectory, beforeListen, stationName='', crossfadeCapable=false, volumeScope=''}) {
  const node = dialog('ラジオ', `<div class="radio-player radio-listen audio-player" data-radio-state="ready">
    <audio preload="none"></audio>
    <div class="audio-art radio-art">
      <span class="radio-player-mark" aria-hidden="true">${playerIcon('volume')}</span>
      <p class="audio-kicker radio-live"><span aria-hidden="true"></span>LIVE RADIO</p>
      <h2 data-radio-title>ラジオ</h2>
      <p data-radio-station></p>
      <p data-radio-next hidden></p>
    </div>
    <div class="player-controls radio-live-controls">
      <div class="radio-transport">
        <button type="button" class="button primary player-play" aria-label="聴く" title="聴く">${playerIcon('play')}</button>
        <span data-radio-hint>聴くと放送中の位置から再生します</span>
      </div>
      <label class="radio-volume"><span>${playerIcon('volume')}<span class="radio-volume-label">ラジオ音量</span></span>
        <input type="range" min="0" max="100" step="1" aria-label="ラジオ音量">
        <output aria-hidden="true"></output>
      </label>
      <p id="radio-status" role="status">現在の番組を聴けます。</p>
    </div>
  </div>`, 'radio-dialog radio-listener');
  let audio=node.querySelector('audio'), mixer;
  const button=node.querySelector('button.primary');
  const shell=node.querySelector('.radio-listen'),title=node.querySelector('[data-radio-title]'),stationLabel=node.querySelector('[data-radio-station]');
  const nextLabel=node.querySelector('[data-radio-next]'),hint=node.querySelector('[data-radio-hint]');
  if(stationName)stationLabel.textContent=stationName;
  function showState(state){
    shell.dataset.radioState=state;
    shell.classList.toggle('audio-motion',state==='live');
    const playing=state==='live'||state==='connecting';
    setPlayerIcon(button,playing?'pause':'play',playing?'一時停止':'聴く');
    hint.textContent=state==='live'?'放送中':state==='connecting'?'放送に接続中…':state==='paused'?'再開すると放送中の位置に戻ります':'聴くと放送中の位置から再生します';
  }
  const volume=node.querySelector('input[type=range]'), meter=node.querySelector('output');
  const preference=playerPreferences('radio:'+volumeScope);
  let gainContext,gainNode,warmContext;
  function applyVolume(value){
    volume.value=String(Math.round(value*100));
    meter.value=volume.value+'%';volume.setAttribute('aria-valuetext',volume.value+'パーセント');
    if(mixer)mixer.volume(value);
    else if(gainNode)gainNode.gain.value=value;
    else try{audio.volume=value;}catch{/* Platform may only support the Web Audio gain control. */}
  }
  function prepareVolume(){
    const value=Number(volume.value)/100;
    if(crossfadeCapable&&!mixer&&!warmContext&&!gainContext&&typeof AudioContext==='function'){
      try{warmContext=new AudioContext();void warmContext.resume().catch(()=>{});}catch{/* Native audio is still available. */}
    }
    if(mixer){mixer.volume(value);mixer.resume();return;}

    if(Math.abs(audio.volume-value)>0.001&&!gainNode&&typeof AudioContext==='function'){
      try{
        gainContext=new AudioContext();gainNode=gainContext.createGain();
        gainContext.createMediaElementSource(audio).connect(gainNode).connect(gainContext.destination);
        gainNode.gain.value=value;
      }catch{void gainContext?.close().catch(()=>{});gainContext=null;gainNode=null;}
    }
    void gainContext?.resume().catch(()=>{});
  }
  volume.addEventListener('input',()=>{
    const value=Number(volume.value)/100;
    preference.save({volume:value});applyVolume(value);prepareVolume();
  });
  applyVolume(preference.value.volume);

  if(onDirectory){
    const back = document.createElement('button');
    back.type = 'button';back.className = 'button secondary';back.textContent = '局一覧に戻る';
    back.onclick = () => {node.close();onDirectory();};
    back.classList.add('radio-back');node.querySelector('.radio-live-controls').append(back);
  }
  const status = node.querySelector('#radio-status'), revision = sessionRevision();
  let controller, objectUrl, retryTimer, refreshTimer, prefetch;
  function discardPrefetch(){prefetch?.controller.abort();prefetch=null;}
  const clearAudio = () => {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  };
  function stop(message = '一時停止しました。再開すると放送中の位置に戻ります。', state='paused') {
    controller?.abort();
    mixer?.cancel();
    discardPrefetch();
    controller = undefined;
    clearTimeout(retryTimer);
    clearTimeout(refreshTimer);
    clearAudio();
    status.textContent = message;
    nextLabel.hidden=true;showState(state);live.update('paused');
  }
  const invalidate = () => { if (node.open) node.close(); };
  const live=mountLiveMediaSession({
    play:()=>{if(!controller&&node.open)start();},pause:()=>{if(controller)stop();},
    stop:invalidate,onSuperseded:()=>{stop();invalidate();}
  });
  node.addEventListener('close', () => {stop();mixer?.close();void warmContext?.close().catch(()=>{});void gainContext?.close().catch(()=>{});live.dispose();}, {once: true});
  window.addEventListener('mirea:unauthorized', invalidate);
  node.addEventListener('close', () => window.removeEventListener('mirea:unauthorized', invalidate), {once: true});

  async function tune(signal) {
    const valid = () => !signal.aborted && node.open && revision === sessionRevision();
    let program, at;
    for (let hop = 0; hop < 3; hop++) {
      program = await api(schedule, {headers, diagnostics:false, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)])});
      at = performance.now();
      const clock=()=>program.serverTime+performance.now()-at;
      const offset=()=>clock()-program.startTime;
      const fade=crossfadeCapable?readLiveFade(program):null;
      if(!valid())return;
      if(fade&&!mixer&&warmContext?.state==='running'&&!gainContext){
        const context=warmContext;warmContext=null;
        mixer=createLiveCrossfader(audio,{Context:function(){return context;},makeAudio:()=>{
          const secondary=document.createElement('audio');secondary.dataset.radio='crossfade';
          node.querySelector('.radio-listen').append(secondary);return secondary;
        }});
        if(mixer){mixer.volume(Number(volume.value)/100);mixer.resume();}
      }

      const adopted=mixer?.take(program.mediaUrl);
      if(adopted){
        clearAudio();audio=adopted.audio;objectUrl=adopted.url;
        present(program,signal,valid,offset,fade,clock);return;
      }
      mixer?.cancel();
      let clip;
      if(prefetch?.url===program.mediaUrl){
        const pending=prefetch;prefetch=null;clip=await pending.result;
      }else discardPrefetch();
      if(!clip)clip=await authenticatedBlob(program.mediaUrl, AbortSignal.any([signal, AbortSignal.timeout(20000)]), headers);
      if (!valid()) return;
      if (offset() >= program.durationMs) continue;
      clearAudio();
      objectUrl = URL.createObjectURL(clip);
      const ready = new Promise((resolve, reject) => {
        const cancel = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
        function finish(error) {
          audio.removeEventListener('loadedmetadata', loaded);
          audio.removeEventListener('error', failed);
          cancel.removeEventListener('abort', aborted);
          error ? reject(error) : resolve();
        }
        const loaded = () => finish(), failed = () => finish(new Error('Failed to load radio audio'));
        const aborted = () => finish(cancel.reason);
        audio.addEventListener('loadedmetadata', loaded);
        audio.addEventListener('error', failed);
        cancel.addEventListener('abort', aborted);
      });
      audio.preload = 'metadata';
      audio.src = objectUrl;
      await ready;
      if (!valid()) return;
      const remaining = program.durationMs - offset();
      const position = offset() / 1000;
      if (remaining <= 0 || position >= audio.duration) continue;
      audio.currentTime = position;
      await audio.play();
      if (!valid()) return;
      present(program,signal,valid,offset,fade,clock);return;
    }
    if (valid()) retryTimer = setTimeout(() => { if (valid()) void listen(signal); }, 1000);
  }
  function present(program,signal,valid,offset,fade,clock){
      title.textContent=program.title;
      stationLabel.textContent=program.station;
      nextLabel.hidden=!program.nextTitle&&!program.nextMediaUrl;
      nextLabel.textContent=program.nextTitle?'次：'+program.nextTitle:'次の放送に自動で切り替わります';
      showState('live');live.update('playing',{title:program.title,station:program.station});
      status.textContent = program.station + ' · ' + program.title + (program.credit?' · '+program.credit:'');
      if(fade&&mixer){
        discardPrefetch();
        mixer.schedule(fade,clock,{signal,load:(url,s)=>authenticatedBlob(url,s,headers)});
      }else if(typeof program.nextMediaUrl==='string'&&program.nextMediaUrl.startsWith('/api/v1/radio/stations/')&&program.nextMediaUrl!==program.mediaUrl){
        const controller=new AbortController();
        prefetch={controller,url:program.nextMediaUrl,result:authenticatedBlob(program.nextMediaUrl,
          AbortSignal.any([signal,controller.signal,AbortSignal.timeout(12000)]),headers).catch(()=>null)};
      }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (valid()) void listen(signal);
      }, Math.max(0, program.durationMs - offset()) + (fade||program.nextMediaUrl?40:0));
  }
  async function listen(signal) {
    if (revision !== sessionRevision()) { stop(); return; }
    try { await tune(signal); }
    catch (error) {
      if (!signal.aborted) stop(error.name === 'NotAllowedError' ? 'もう一度「聴く」を押してください。' : error.status === 404 ? 'この局は再生できません。公開範囲・リンク・曲の本棚へのアクセス権を確認してください。' : 'ラジオに接続できませんでした。');
    }
  }
  function start() {
    prepareVolume();
    live.claim();
    controller = new AbortController();
    showState('connecting');
    status.textContent = 'ラジオに接続中…';
    const signal=controller.signal;
    void (async()=>{
      try{await beforeListen?.();if(!signal.aborted)await listen(signal);}
      catch{if(!signal.aborted){stop('別のプレイヤーを一時停止できませんでした。');live.release();}}
    })();
  }
  button.onclick=()=>controller?stop():start();
  return node;
}
