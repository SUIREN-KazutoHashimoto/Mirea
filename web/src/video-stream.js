import Hls from 'hls.js/light';
import {resolveQualityPreference} from './quality-preference.js';

// One HTMLVideoElement for the whole viewing session: ABR changes never create
// a new view, reset resume state, or trigger series continuation.
export function attachVideoStream(video,{ticket,absoluteUrl,renew,onQuality=()=>{},onOptions=()=>{},onError=()=>{},initialQuality='auto',onChoose=()=>{},HlsClass=Hls}) {
  let hls,disposed=false,selected=resolveQualityPreference(ticket.renditions??[],initialQuality),preferred=initialQuality,actual='unknown',refreshing,refreshTimer,streamKind='mp4',manifestReady=false;
  const restores=new Set();
  const emit=()=>onQuality({selectedQuality:['higher','data'].includes(selected)?'auto':selected,actualQuality:actual,streamKind,
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
    if(!ticket.hlsUrl||selected==='legacy')return absoluteUrl(ticket.url);
    if(selected==='auto'||hls)return absoluteUrl(ticket.hlsUrl);
    if(['higher','data'].includes(selected)){const ordered=[...qualities()].sort((a,b)=>Math.min(b.width,b.height)-Math.min(a.width,a.height)),r=selected==='higher'?ordered[0]:ordered.find(q=>Math.min(q.width,q.height)<=480)??ordered.at(-1);return absoluteUrl(ticket.hlsUrl.replace('master.m3u8',`${r.quality}.m3u8`));}
    return absoluteUrl(ticket.hlsUrl.replace('master.m3u8',`${selected}.m3u8`));
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if(!disposed&&renew&&ticket.expiresAt)refreshTimer=setTimeout(()=>reconnect().catch(onError),Math.max(1000,ticket.expiresAt-Date.now()-60000));
  }
  async function reconnect() {
    if(refreshing)return refreshing;
    refreshing=(async()=>{const next=await renew();if(disposed)return;ticket=next;selected=streamKind==='mp4'?'legacy':resolveQualityPreference(qualities(),preferred);manifestReady=false;restoreSource(sourceUrl());options();emit();scheduleRefresh();})().finally(()=>{refreshing=null;});
    return refreshing;
  }
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
    hls=new HlsClass({maxBufferLength:20,maxMaxBufferLength:30,backBufferLength:30,enableWorker:true,autoStartLoad:false});
    hls.on(HlsClass.Events.MANIFEST_PARSED,()=>{if(disposed)return;manifestReady=true;if(applyLevel())hls.startLoad();options();emit();});
    hls.on(HlsClass.Events.LEVEL_SWITCHED,(_event,data)=>{const level=hls.levels[data.level];actual=qualities().find(q=>q.width===level?.width&&q.height===level?.height)?.quality??'unknown';options();emit();});
    hls.on(HlsClass.Events.ERROR,(_event,data)=>{if(data.fatal&&!disposed)onError(new Error('配信を読み込めません。アクセス権と通信を確認し、再接続してください。'));});
    hls.attachMedia(video);hls.loadSource(absoluteUrl(ticket.hlsUrl));
  }else if(ticket.hlsUrl&&video.canPlayType('application/vnd.apple.mpegurl')){streamKind='hls';video.src=sourceUrl();actual=['auto','higher','data'].includes(selected)?'unknown':selected;}
  else{selected='legacy';actual='legacy';video.src=absoluteUrl(ticket.url);}
  options();emit();scheduleRefresh();
  return {choose,reconnect,dispose(){disposed=true;clearTimeout(refreshTimer);for(const listener of restores)video.removeEventListener('loadedmetadata',listener);restores.clear();hls?.destroy();}};
}
