import Hls from 'hls.js/light';
import {resolveQualityPreference} from './quality-preference.js';

// One HTMLVideoElement for the whole viewing session: ABR changes never create
// a new view, reset resume state, or trigger series continuation.
export function attachVideoStream(video,{ticket,absoluteUrl,renew,onQuality=()=>{},onOptions=()=>{},onError=()=>{},initialQuality='auto',onChoose=()=>{},HlsClass=Hls,events=globalThis.window,preload=false}) {
  let hls,hlsObjectUrl,disposed=false,selected=resolveQualityPreference(ticket.renditions??[],initialQuality),preferred=initialQuality,actual='unknown',refreshing,refreshTimer,streamKind='mp4',manifestReady=false;
  const restores=new Set();
  let restoring,retryPending=false,retrySeamless=false,recoveryTimer,recoveryAttempts=0,mediaRecoveryAt=0,desiredPlaying=!video.paused;
  const forbidden=error=>[400,401,403,404,410,422,423].includes(error?.status);
  function deferRecovery(){clearTimeout(recoveryTimer);if(disposed||!retryPending)return;recoveryTimer=setTimeout(()=>reconnect({seamless:retrySeamless}).catch(()=>{}),Math.min(30000,1000*2**Math.min(recoveryAttempts++,5)));}
  const emit=()=>onQuality({selectedQuality:['higher','data'].includes(selected)?'auto':selected,actualQuality:actual,streamKind,
    ...(Number.isFinite(hls?.bandwidthEstimate)?{bandwidthEstimate:Math.min(10000000000,Math.max(0,Math.round(hls.bandwidthEstimate)))}:{})});
  const qualities=()=>ticket.renditions??[];
  function options() { onOptions({qualities:selected==='legacy'?[]:qualities(),selected,actual,auto:Boolean(hls||video.canPlayType('application/vnd.apple.mpegurl'))}); }
  function restoreSource(url) {
    const snapshot=restoring??{position:video.currentTime,playing:!video.paused,rate:video.playbackRate};restoring=snapshot;
    for(const listener of restores)video.removeEventListener('loadedmetadata',listener);restores.clear();
    const restore=()=>{video.removeEventListener('loadedmetadata',restore);restores.delete(restore);if(disposed)return;restoring=null;if(Number.isFinite(video.duration))video.currentTime=Math.min(snapshot.position,video.duration);if(Number.isFinite(snapshot.rate))video.playbackRate=snapshot.rate;if(snapshot.playing)video.play().catch(()=>{});};
    restores.add(restore);
    video.addEventListener('loadedmetadata',restore,{once:true});
    if(hls)hls.loadSource(url);else{video.src=url;video.load();}
  }
  function sourceUrl() {
    if(!ticket.hlsUrl||selected==='legacy')return absoluteUrl(ticket.url);
    if(selected==='auto'||hls)return absoluteUrl(ticket.hlsUrl);
    if(['higher','data'].includes(selected)){const ordered=[...qualities()].sort((a,b)=>Math.min(b.width,b.height)-Math.min(a.width,a.height)),r=selected==='higher'?ordered[0]:ordered.find(q=>Math.min(q.width,q.height)<=480)??ordered.at(-1);return absoluteUrl(ticket.hlsUrl.replace('master.m3u8',`${r.quality}.m3u8`));}
    return absoluteUrl(ticket.hlsUrl.replace('master.m3u8',`${selected}.m3u8`));
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if(!disposed&&renew&&ticket.expiresAt)refreshTimer=setTimeout(()=>reconnect({seamless:true}).catch(()=>{}),Math.max(1000,ticket.expiresAt-Date.now()-60000));
  }
  async function reconnect({seamless=false}={}) {
    if(disposed||!renew)return;
    if(refreshing)return refreshing;
    clearTimeout(refreshTimer);
    refreshing=(async()=>{const next=await renew(seamless?ticket:null);if(disposed)return;retryPending=false;clearTimeout(recoveryTimer);const same=next.url===ticket.url&&next.hlsUrl===ticket.hlsUrl;ticket=next;if(!seamless||!same){selected=streamKind==='mp4'?'legacy':resolveQualityPreference(qualities(),preferred);manifestReady=false;restoreSource(sourceUrl());options();emit();}scheduleRefresh();})().catch(error=>{if(disposed)throw error;retryPending=!forbidden(error);retrySeamless=seamless;if(retryPending)deferRecovery();else if(!disposed)onError(error);throw error;}).finally(()=>{refreshing=null;});
    return refreshing;
  }
  const connected=()=>{if(retryPending&&!disposed){clearTimeout(recoveryTimer);reconnect({seamless:retrySeamless}).catch(()=>{});}};events?.addEventListener('online',connected);
  const intent=event=>{if(typeof event.detail?.playing==='boolean'){desiredPlaying=event.detail.playing;if(restoring)restoring.playing=desiredPlaying;}};video.addEventListener('mirea:playback-intent',intent);
  const played=()=>{desiredPlaying=true;},paused=()=>{if(!restoring&&!video.error)desiredPlaying=false;},healthy=()=>{recoveryAttempts=0;};video.addEventListener('play',played);video.addEventListener('pause',paused);video.addEventListener('playing',healthy);
  // MP4/audio and browser-native HLS do not emit hls.js transport events.
  // Recover only network errors; decoding/format errors still reach the UI.
  const transportError=event=>{
    if(disposed||hls||!renew||video.error?.code!==2)return;
    event.stopImmediatePropagation();
    restoring??={position:video.currentTime,playing:desiredPlaying||!video.paused,rate:video.playbackRate};
    retryPending=true;retrySeamless=false;deferRecovery();
  };
  video.addEventListener('error',transportError,true);
  function choose(value) {
    if(!['auto','higher','data'].includes(value)&&!qualities().some(q=>q.quality===value))return;
    selected=value;preferred=value;onChoose(value);
    if(hls&&manifestReady){if(applyLevel())hls.startLoad();}
    else if(ticket.hlsUrl)restoreSource(sourceUrl());
    actual=hls?actual:['auto','higher','data'].includes(selected)?'unknown':selected;options();emit();
  }
  function applyLevel(){
    hls.autoLevelCapping=-1;
    if(['auto','higher','data'].includes(selected)){if(selected==='higher')hls.currentLevel=hls.levels.length-1;else{if(selected==='data'){const levels=hls.levels.map((l,index)=>({index,size:Math.min(l.width,l.height)}));hls.autoLevelCapping=levels.filter(l=>l.size<=480).at(-1)?.index??0;}hls.currentLevel=-1;}return true;}
    const rendition=qualities().find(q=>q.quality===selected),index=hls.levels.findIndex(l=>l.width===rendition?.width&&l.height===rendition?.height);
    if(index<0){hls.stopLoad();onError(new Error('固定した画質が配信一覧に見つかりません。再接続するか別の画質を選択してください。'));return false;}
    // Never turn an unmatched manual choice into -1 (automatic ABR).
    hls.currentLevel=index;return true;
  }
  if(ticket.hlsUrl&&HlsClass.isSupported()){
    streamKind='hls';
    hls=new HlsClass({maxBufferLength:preload?20:90,maxMaxBufferLength:preload?30:180,maxBufferSize:(preload?16:64)*1024*1024,backBufferLength:10,enableWorker:true,autoStartLoad:false});
    if(HlsClass.Events.MEDIA_ATTACHED)hls.on(HlsClass.Events.MEDIA_ATTACHED,()=>{const url=video.getAttribute?.('src')??video.src;hlsObjectUrl=typeof url==='string'&&url.startsWith('blob:')?url:null;});
    hls.on(HlsClass.Events.MANIFEST_PARSED,()=>{if(disposed)return;manifestReady=true;if(applyLevel())hls.startLoad();options();emit();});
    hls.on(HlsClass.Events.LEVEL_SWITCHED,(_event,data)=>{const level=hls.levels[data.level];actual=qualities().find(q=>q.width===level?.width&&q.height===level?.height)?.quality??'unknown';options();emit();});
    hls.on(HlsClass.Events.ERROR,(_event,data)=>{
      if(!data.fatal||disposed)return;
      const status=data.response?.code??data.networkDetails?.status;
      if(data.type===(HlsClass.ErrorTypes?.NETWORK_ERROR??'networkError')&&!forbidden({status})&&renew){
        restoring??={position:video.currentTime,playing:desiredPlaying||!video.paused,rate:video.playbackRate};retryPending=true;retrySeamless=false;deferRecovery();return;
      }
      if(data.type===(HlsClass.ErrorTypes?.MEDIA_ERROR??'mediaError')&&hls.recoverMediaError&&Date.now()-mediaRecoveryAt>15000){mediaRecoveryAt=Date.now();hls.recoverMediaError();return;}
      retryPending=false;clearTimeout(recoveryTimer);onError(new Error('配信を読み込めません。アクセス権と通信を確認し、再接続してください。'));
    });
    hls.attachMedia(video);hls.loadSource(absoluteUrl(ticket.hlsUrl));
  }else if(ticket.hlsUrl&&video.canPlayType('application/vnd.apple.mpegurl')){streamKind='hls';video.src=sourceUrl();actual=['auto','higher','data'].includes(selected)?'unknown':selected;}
  else{selected='legacy';actual='legacy';video.src=absoluteUrl(ticket.url);}
  options();emit();scheduleRefresh();
  return {choose,reconnect,adopt(callbacks){({renew=renew,onQuality=onQuality,onOptions=onOptions,onError=onError,onChoose=onChoose}=callbacks);if(hls){hls.config.maxBufferLength=90;hls.config.maxMaxBufferLength=180;hls.config.maxBufferSize=64*1024*1024;}options();emit();scheduleRefresh();},dispose({preserveMedia=false}={}){if(disposed)return;disposed=true;clearTimeout(refreshTimer);clearTimeout(recoveryTimer);events?.removeEventListener('online',connected);video.removeEventListener('error',transportError,true);video.removeEventListener('mirea:playback-intent',intent);video.removeEventListener('play',played);video.removeEventListener('pause',paused);video.removeEventListener('playing',healthy);for(const listener of restores)video.removeEventListener('loadedmetadata',listener);restores.clear();restoring=null;
    // The pinned hls.js transfer API detaches controllers without clearing src
    // or calling load(). The next stream replaces the source on this same PiP
    // element; a normal destroy would first blank it and close some browsers' PiP.
    let transferred;try{if(preserveMedia&&hls?.transferMedia)transferred=hls.transferMedia();}finally{hls?.destroy();}
    // Release only the object URL observed when this HLS instance attached.
    // Revoking the URL does not detach an already-open MediaSource.
    if(transferred?.media===video&&hlsObjectUrl)URL.revokeObjectURL(hlsObjectUrl);
  }};
}
