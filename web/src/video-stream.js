import Hls from 'hls.js/light';

// One HTMLVideoElement for the whole viewing session: ABR changes never create
// a new view, reset resume state, or trigger series continuation.
export function attachVideoStream(video,{ticket,absoluteUrl,renew,onQuality=()=>{},onOptions=()=>{},onError=()=>{}}) {
  let hls,disposed=false,selected='auto',actual='unknown',refreshing,refreshTimer,streamKind='mp4';
  const restores=new Set();
  const emit=()=>onQuality({selectedQuality:selected,actualQuality:actual,streamKind,
    ...(Number.isFinite(hls?.bandwidthEstimate)?{bandwidthEstimate:Math.min(10000000000,Math.max(0,Math.round(hls.bandwidthEstimate)))}:{})});
  const qualities=()=>ticket.renditions??[];
  function options() { onOptions({qualities:selected==='legacy'?[]:qualities(),selected,actual,auto:Boolean(hls||video.canPlayType('application/vnd.apple.mpegurl'))}); }
  function restoreSource(url) {
    const position=video.currentTime,playing=!video.paused;
    for(const listener of restores)video.removeEventListener('loadedmetadata',listener);restores.clear();
    const restore=()=>{video.removeEventListener('loadedmetadata',restore);restores.delete(restore);if(disposed)return;if(position>0&&Number.isFinite(video.duration))video.currentTime=Math.min(position,video.duration);if(playing)video.play().catch(()=>{});};
    restores.add(restore);
    video.addEventListener('loadedmetadata',restore,{once:true});
    if(hls)hls.loadSource(url);else{video.src=url;video.load();}
  }
  function sourceUrl() {
    if(!ticket.hlsUrl)return absoluteUrl(ticket.url);
    if(selected==='auto'||hls)return absoluteUrl(ticket.hlsUrl);
    return absoluteUrl(ticket.hlsUrl.replace('master.m3u8',`${selected}.m3u8`));
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if(!disposed&&renew&&ticket.expiresAt)refreshTimer=setTimeout(()=>reconnect().catch(onError),Math.max(1000,ticket.expiresAt-Date.now()-60000));
  }
  async function reconnect() {
    if(refreshing)return refreshing;
    refreshing=(async()=>{const next=await renew();if(disposed)return;ticket=next;restoreSource(sourceUrl());scheduleRefresh();})().finally(()=>{refreshing=null;});
    return refreshing;
  }
  function choose(value) {
    if(value!=='auto'&&!qualities().some(q=>q.quality===value))return;
    selected=value;
    if(hls){const index=value==='auto'?-1:hls.levels.findIndex(l=>l.width===qualities().find(q=>q.quality===value)?.width&&l.height===qualities().find(q=>q.quality===value)?.height);hls.currentLevel=index;}
    else if(ticket.hlsUrl)restoreSource(sourceUrl());
    actual=hls?actual:selected==='auto'?'unknown':selected;options();emit();
  }
  if(ticket.hlsUrl&&Hls.isSupported()){
    streamKind='hls';
    hls=new Hls({maxBufferLength:20,maxMaxBufferLength:30,backBufferLength:30,enableWorker:true});
    hls.on(Hls.Events.MANIFEST_PARSED,()=>{options();if(selected!=='auto')choose(selected);});
    hls.on(Hls.Events.LEVEL_SWITCHED,(_event,data)=>{const level=hls.levels[data.level];actual=qualities().find(q=>q.width===level?.width&&q.height===level?.height)?.quality??'unknown';options();emit();});
    hls.on(Hls.Events.ERROR,(_event,data)=>{if(data.fatal&&!disposed)onError(new Error('配信を読み込めません。アクセス権と通信を確認し、再接続してください。'));});
    hls.attachMedia(video);hls.loadSource(absoluteUrl(ticket.hlsUrl));
  }else if(ticket.hlsUrl&&video.canPlayType('application/vnd.apple.mpegurl')){streamKind='hls';video.src=absoluteUrl(ticket.hlsUrl);}
  else{selected='legacy';actual='legacy';video.src=absoluteUrl(ticket.url);}
  options();emit();scheduleRefresh();
  return {choose,reconnect,dispose(){disposed=true;clearTimeout(refreshTimer);for(const listener of restores)video.removeEventListener('loadedmetadata',listener);restores.clear();hls?.destroy();}};
}
