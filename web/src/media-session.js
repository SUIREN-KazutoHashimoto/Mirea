// Browser-owned PiP/OS media controls. The tab must remain open; no fake keepalive.
const owners=new WeakMap(), documentOwners=new WeakMap();
export const isPictureInPicture=(media,doc=globalThis.document)=>Boolean(media&&(doc?.pictureInPictureElement===media||media.webkitPresentationMode==='picture-in-picture'));
export function mountMediaSession(media,{title='',kind='video',artwork,previous,next,stop,active=true,onError=()=>{},navigator:nav=globalThis.navigator,document:doc=globalThis.document,MediaMetadata:Metadata=globalThis.MediaMetadata}={}){
  const session=nav?.mediaSession,listeners=[],actions=[];let disposed=false,activated=false,preserved=false;
  const owner={pause:()=>{intent(false);media.pause();exitPip();},restore:()=>{if(!disposed&&activated)claim();}};const owns=()=>!disposed&&activated&&(!session||owners.get(session)===owner);
  const listen=(target,event,fn)=>{target?.addEventListener(event,fn);listeners.push(()=>target?.removeEventListener(event,fn));};
  const intent=playing=>{if(typeof CustomEvent!=='undefined')media.dispatchEvent(new CustomEvent('mirea:playback-intent',{detail:{playing}}));};
  const play=()=>{intent(true);return Promise.resolve(media.play()).catch(()=>{if(owns())onError(new Error('再生ボタンを押して再開してください。'));});};
  const seek=position=>{if(Number.isFinite(media.duration))media.currentTime=Math.min(media.duration,Math.max(0,position));};
  const set=(action,handler)=>{try{session?.setActionHandler(action,handler);actions.push(action);}catch{/* Optional browser capability. */}};
  function activate(){
    if(disposed||activated)return;activated=true;claim();
  }
  function claim(){
    if(disposed||!activated)return;
    const prior=documentOwners.get(doc);
    if(doc)documentOwners.set(doc,owner);
    if(prior?.live)prior.superseded();
    if(session&&owners.get(session)===owner){update();return;}
    if(session)owners.set(session,owner);
    actions.length=0;
    if(session){
    if(Metadata)session.metadata=new Metadata({title,artist:'Mirea',...(artwork?{artwork:[{src:artwork}]}:{})});
    set('play',play);set('pause',()=>{intent(false);media.pause();});set('stop',()=>{intent(false);media.pause();stop?.();});
    set('seekbackward',details=>seek(media.currentTime-(details.seekOffset??10)));
    set('seekforward',details=>seek(media.currentTime+(details.seekOffset??10)));
    set('seekto',details=>{if(Number.isFinite(details.seekTime))seek(details.seekTime);});
    if(previous)set('previoustrack',previous);if(next)set('nexttrack',next);
    if(kind==='video')set('enterpictureinpicture',()=>pip().catch(onError));
    }
    update();
  }
  function update(){
    if(!session||!owns())return;
    session.playbackState=media.paused?'paused':'playing';
    try{if(Number.isFinite(media.duration)&&media.duration>0)session.setPositionState?.({duration:media.duration,position:Math.min(media.duration,Math.max(0,media.currentTime||0)),playbackRate:media.playbackRate||1});}catch{/* Unknown duration or unsupported position state. */}
  }
  const supportsPip=kind==='video'&&Boolean(doc?.pictureInPictureEnabled&&media.requestPictureInPicture || media.webkitSupportsPresentationMode?.('picture-in-picture'));
  async function pip(){
    if(disposed||!activated)return;
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
    else if(!preserved&&doc?.pictureInPictureElement===media)doc.exitPictureInPicture?.().catch(()=>{});
  }
  for(const event of ['play','pause','ended','loadedmetadata','timeupdate','ratechange','seeked'])listen(media,event,update);
  listen(media,'play',()=>{if(activated&&documentOwners.get(doc)?.live)claim();});
  if(active)activate();
  return {supportsPip,pip,exitPip,background,activate,setArtwork(src){artwork=src;if(owns()&&session&&Metadata)session.metadata=new Metadata({title,artist:'Mirea',...(src?{artwork:[{src}]}:{})});},dispose({preserveMedia=false}={}){if(disposed)return;const owned=owns();preserved=preserveMedia;disposed=true;if(documentOwners.get(doc)===owner)documentOwners.delete(doc);listeners.forEach(remove=>remove());if(owned){for(const action of actions){try{session?.setActionHandler(action,null);}catch{}}if(session){owners.delete(session);session.playbackState='none';session.metadata=null;try{session.setPositionState?.();}catch{}}}if(activated&&!preserveMedia)exitPip();}};
}

const sessionActions=['play','pause','stop','seekbackward','seekforward','seekto','previoustrack','nexttrack','enterpictureinpicture'];
const setAction=(session,action,handler)=>{try{session?.setActionHandler(action,handler);}catch{/* Optional browser capability. */}};

export function mountLiveMediaSession({play,pause,stop,onSuperseded,document:doc=globalThis.document,navigator:nav=globalThis.navigator,MediaMetadata:Metadata=globalThis.MediaMetadata}={}){
  const session=nav?.mediaSession;
  let disposed=false,previous;
  const owner={live:true,superseded:()=>onSuperseded?.()};
  const owns=()=>!disposed&&documentOwners.get(doc)===owner;
  const clear=()=>{
    for(const action of sessionActions)setAction(session,action,null);
    try{session?.setPositionState?.();}catch{/* Optional browser capability. */}
  };
  function claim(){
    if(disposed||owns()||!doc)return;
    const current=documentOwners.get(doc);
    previous=current?.live?current.previous:current;
    owner.previous=previous;
    documentOwners.set(doc,owner);
    if(current?.live)current.superseded();else current?.pause?.();
    if(!session)return;
    owners.set(session,owner);clear();session.metadata=null;session.playbackState='paused';
    for(const [action,callback] of [['play',play],['pause',pause],['stop',stop]])
      setAction(session,action,()=>{if(owns())callback?.();});
  }
  function update(state,info){
    if(!session||!owns())return;
    session.playbackState=state;
    if(Metadata&&info)session.metadata=new Metadata({title:info.title,artist:info.station||'Mirea Radio'});
  }
  function release(){
    if(!owns())return;
    documentOwners.delete(doc);
    if(session&&owners.get(session)===owner){
      owners.delete(session);clear();session.playbackState='none';session.metadata=null;
    }
    previous?.restore?.();
  }
  function dispose(){if(!disposed){release();disposed=true;}}
  return {claim,update,release,dispose};
}

export function interruptLiveMedia(doc=globalThis.document){
  const current=documentOwners.get(doc);
  if(current?.live)current.superseded();
}
