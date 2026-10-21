const icons={left:'<path d="m15 5-7 7 7 7"/>',right:'<path d="m9 5 7 7-7 7"/>',play:'<path d="m8 5 11 7-11 7Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',stop:'<path d="M6 6h12v12H6Z"/>',audio:'<path d="M9 18V5l12-2v13M9 8l12-2"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',video:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4Z"/>'};
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

// A small edge dock, not a full-width banner. Collapsing never pauses playback.
export function mountPlaybackDock({doc=document,onRestore,onToggle,onStop,loadArtwork,objectUrl=URL}={}){
  const root=doc.createElement('aside');root.className='playback-dock native-now-playing';root.setAttribute('aria-label','背景再生コントローラー');
  root.innerHTML=`<button type="button" class="dock-fold"></button><div class="dock-content"><button type="button" class="dock-art"><img alt="" hidden><span class="dock-fallback"></span><span class="dock-title"></span></button><div class="dock-controls"><button type="button" class="dock-play"></button><button type="button" class="dock-stop" aria-label="再生を停止">${icon('stop')}</button></div><div class="dock-track" aria-hidden="true"><span></span></div></div>`;
  const fold=root.querySelector('.dock-fold'),content=root.querySelector('.dock-content'),art=root.querySelector('.dock-art'),image=root.querySelector('img'),title=root.querySelector('.dock-title'),play=root.querySelector('.dock-play'),fallback=root.querySelector('.dock-fallback'),track=root.querySelector('.dock-track span');
  let collapsed=false,closed=false,key,revision=0,url,controller,state;
  const revoke=()=>{if(url)objectUrl.revokeObjectURL(url);url=null;image.removeAttribute('src');image.hidden=true;};
  const invoke=fn=>{try{Promise.resolve(fn?.()).catch(()=>{});}catch{}};
  function collapse(value){collapsed=value;root.classList.toggle('dock-collapsed',value);content.inert=value;content.setAttribute('aria-hidden',String(value));fold.innerHTML=icon(value?'left':'right');fold.setAttribute('aria-expanded',String(!value));fold.setAttribute('aria-label',value?'背景再生コントローラーを展開':'背景再生コントローラーを最小化');}
  fold.onclick=()=>collapse(!collapsed);art.onclick=()=>invoke(onRestore);play.onclick=()=>invoke(()=>onToggle?.(state));root.querySelector('.dock-stop').onclick=()=>invoke(onStop);
  collapse(false);doc.body.append(root);
  return {root,collapse,update(value){
    if(closed)return;state=value;const label=value.title||'Mirea';title.textContent=label;root.title=label;art.setAttribute('aria-label',`${label}のプレイヤーを開く`);play.innerHTML=icon(value.playing?'pause':'play');play.setAttribute('aria-label',value.playing?'一時停止':'再生');fallback.innerHTML=icon(value.kind==='video'?'video':'audio');track.style.width=`${Math.max(0,Math.min(100,(value.positionMs||0)/Math.max(1,value.durationMs||0)*100))}%`;
    if(key===value.key)return;key=value.key;const epoch=++revision;controller?.abort();controller=new AbortController();revoke();const signal=controller.signal;
    Promise.resolve().then(()=>loadArtwork?.(value,signal)).then(blob=>{if(closed||epoch!==revision||!blob)return;url=objectUrl.createObjectURL(blob);image.src=url;image.hidden=false;}).catch(()=>{/* A missing cover must never interrupt playback. */});
  },dispose(){if(closed)return;closed=true;revision++;controller?.abort();revoke();root.remove();}};
}
