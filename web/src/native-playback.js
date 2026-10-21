import { mountPlaybackDock } from './playback-dock.js';
import { authenticatedBlob } from './api.js';
import { getSession,getEndpoint,isOfflineSession } from './api.js';
import { NativePlayer,nativePlayerAvailable,nativePlaybackGeneration,nativePlaybackStopped } from './native-player-bridge.js';
import { prepareNativeDownload,downloadedThumbnail } from './downloads.js';
import { beginUpdateActivity } from './update-busy.js';

let release,dock,dockIdentity,refreshEpoch=0;
export async function refreshNativePlayback(){
  if(!nativePlayerAvailable())return;
  const epoch=++refreshEpoch,actor=getSession(),origin=getEndpoint(),generation=nativePlaybackGeneration(),identity=origin+'|'+actor?.user.id;
  if(dockIdentity!==identity){dock?.dispose();dock=null;dockIdentity=identity;}
  await nativePlaybackStopped();
  const current=()=>epoch===refreshEpoch&&getSession()?.token===actor?.token&&getEndpoint()===origin&&nativePlaybackGeneration()===generation;
  const status=await NativePlayer.status();if(!current())return;
  if(status.active&&!release)release=beginUpdateActivity();else if(!status.active&&release){release();release=null;}
  if(!status.active||!actor){dock?.dispose();dock=null;return;}
  if(!dock)dock=mountPlaybackDock({onRestore:()=>NativePlayer.show(),onToggle:state=>state.playing?NativePlayer.pause():NativePlayer.play(),onStop:()=>NativePlayer.stop().then(refreshNativePlayback),loadArtwork:async(state,signal)=>{
    const valid=()=>!signal.aborted&&getEndpoint()===state.origin&&getSession()?.user.id===state.userId;
    if(!valid())return null;const cover=await downloadedThumbnail(state.id).catch(()=>null);if(!valid())return null;
    return cover||authenticatedBlob('/api/v1/items/'+state.id+'/thumbnail',signal);
  }});
  dock.update({origin,userId:actor.user.id,key:origin+'|'+actor.user.id+'|'+status.item?.id,id:status.item?.id,title:status.item?.title,kind:status.video?'video':'audio',playing:status.playing,positionMs:status.positionMs,durationMs:status.durationMs});
}
export async function initializeNativePlayback(){
  if(!nativePlayerAvailable())return;
  await NativePlayer.addListener('playbackState',()=>refreshNativePlayback().catch(()=>{}));
  await refreshNativePlayback();
}
export async function openNativePlayback(item,{restart=false,continuous=true,analytics=false,version='',isCurrent=()=>true,progress=()=>{}}={}){
  await nativePlaybackStopped();const session=getSession(),origin=getEndpoint(),epoch=nativePlaybackGeneration();
  if(!session)throw new Error('ログインしてください。');
  const valid=()=>isCurrent()&&nativePlaybackGeneration()===epoch&&getSession()?.token===session.token&&getEndpoint()===origin;
  const download=await prepareNativeDownload(item,valid,progress);
  if(!valid())throw new Error('再生準備を取り消しました。');
  let artwork;
  if(download){const cover=await downloadedThumbnail(item.id).catch(()=>null);if(cover){const bytes=new Uint8Array(await cover.arrayBuffer()),parts=[];for(let n=0;n<bytes.length;n+=8192)parts.push(String.fromCharCode(...bytes.subarray(n,n+8192)));artwork=btoa(parts.join(''));bytes.fill(0);}}
  if(!valid())throw new Error('再生準備を取り消しました。');
  await NativePlayer.open({...(artwork?{artwork}:{}),origin,token:session.token,userId:session.user.id,item,restart,continuous,analytics,version,autoplay:true,...(download?{download,offline:isOfflineSession()}:{})});
  await refreshNativePlayback();
}
