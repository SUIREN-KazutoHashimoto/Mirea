// Browser-owned PiP/OS media controls. The tab must remain open; no fake keepalive.
const owners=new WeakMap();
export function mountMediaSession(media,{title='',kind='video',artwork,previous,next,stop,onError=()=>{},navigator:nav=globalThis.navigator,document:doc=globalThis.document,MediaMetadata:Metadata=globalThis.MediaMetadata}={}){
  const session=nav?.mediaSession,listeners=[],actions=[];let disposed=false;
  const owner={};if(session)owners.set(session,owner);const owns=()=>!disposed&&(!session||owners.get(session)===owner);
  const listen=(target,event,fn)=>{target?.addEventListener(event,fn);listeners.push(()=>target?.removeEventListener(event,fn));};
  const intent=playing=>{if(typeof CustomEvent!=='undefined')media.dispatchEvent(new CustomEvent('mirea:playback-intent',{detail:{playing}}));};
  const play=()=>{intent(true);return Promise.resolve(media.play()).catch(()=>{if(owns())onError(new Error('再生ボタンを押して再開してください。'));});};
  const seek=position=>{if(Number.isFinite(media.duration))media.currentTime=Math.min(media.duration,Math.max(0,position));};
  const set=(action,handler)=>{try{session?.setActionHandler(action,handler);actions.push(action);}catch{/* Optional browser capability. */}};
  if(session){
    if(Metadata)session.metadata=new Metadata({title,artist:'Mirea',...(artwork?{artwork:[{src:artwork}]}:{})});
    set('play',play);set('pause',()=>{intent(false);media.pause();});set('stop',()=>{intent(false);media.pause();stop?.();});
    set('seekbackward',details=>seek(media.currentTime-(details.seekOffset??10)));
    set('seekforward',details=>seek(media.currentTime+(details.seekOffset??10)));
    set('seekto',details=>{if(Number.isFinite(details.seekTime))seek(details.seekTime);});
    if(previous)set('previoustrack',previous);if(next)set('nexttrack',next);
    if(kind==='video')set('enterpictureinpicture',()=>pip().catch(onError));
  }
  function update(){
    if(!session||!owns())return;
    session.playbackState=media.paused?'paused':'playing';
    try{if(Number.isFinite(media.duration)&&media.duration>0)session.setPositionState?.({duration:media.duration,position:Math.min(media.duration,Math.max(0,media.currentTime||0)),playbackRate:media.playbackRate||1});}catch{/* Unknown duration or unsupported position state. */}
  }
  const supportsPip=kind==='video'&&Boolean(doc?.pictureInPictureEnabled&&media.requestPictureInPicture || media.webkitSupportsPresentationMode?.('picture-in-picture'));
  async function pip(){
    if(disposed)return;
    if(!supportsPip)throw new Error('このブラウザーではPiPを利用できません。');
    if(doc.pictureInPictureElement===media)return doc.exitPictureInPicture();
    if(media.requestPictureInPicture)return media.requestPictureInPicture();
    media.webkitSetPresentationMode(media.webkitPresentationMode==='picture-in-picture'?'inline':'picture-in-picture');
  }
  const exitPip=()=>{if(doc?.pictureInPictureElement===media)return doc.exitPictureInPicture?.().catch(()=>{});if(media.webkitPresentationMode==='picture-in-picture')media.webkitSetPresentationMode?.('inline');};
  async function background(minimize){
    if(kind==='video'&&supportsPip&&doc.pictureInPictureElement!==media&&media.webkitPresentationMode!=='picture-in-picture'){
      try{await pip();}catch{/* The existing tab mini-player remains a safe fallback. */}
    }
    if(!disposed)minimize();
    else if(doc?.pictureInPictureElement===media)doc.exitPictureInPicture?.().catch(()=>{});
  }
  for(const event of ['play','pause','ended','loadedmetadata','timeupdate','ratechange','seeked'])listen(media,event,update);
  update();
  return {supportsPip,pip,exitPip,background,setArtwork(src){if(owns()&&session&&Metadata)session.metadata=new Metadata({title,artist:'Mirea',...(src?{artwork:[{src}]}:{})});},dispose(){const owned=owns();disposed=true;listeners.forEach(remove=>remove());if(owned){for(const action of actions){try{session?.setActionHandler(action,null);}catch{}}if(session){owners.delete(session);session.playbackState='none';session.metadata=null;try{session.setPositionState?.();}catch{}}}exitPip();}};
}
