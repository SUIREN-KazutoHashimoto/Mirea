export function mountAudioMotion(root,media,{doc=document,screen,preference=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')}={}){
  const listeners=[],listen=(target,event,fn)=>{if(!target)return;target.addEventListener(event,fn);listeners.push(()=>target.removeEventListener(event,fn));};
  const update=()=>root.classList.toggle('audio-motion',!media.paused&&!media.ended&&!doc.hidden&&!screen?.isMinimized&&!preference?.matches);
  for(const event of ['play','playing','pause','ended','emptied','error'])listen(media,event,update);
  listen(doc,'visibilitychange',update);listen(screen,'viewer:presentation',update);listen(preference,'change',update);update();
  return ()=>{listeners.forEach(remove=>remove());root.classList.remove('audio-motion');};
}
