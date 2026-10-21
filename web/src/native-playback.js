import { getSession,getEndpoint } from './api.js';
import { NativePlayer,nativePlayerAvailable,nativePlaybackGeneration,nativePlaybackStopped } from './native-player-bridge.js';
import { prepareNativeDownload,downloadedThumbnail } from './downloads.js';
import { beginUpdateActivity } from './update-busy.js';

let release;
export async function refreshNativePlayback(){
  if(!nativePlayerAvailable())return;
  const status=await NativePlayer.status();
  if(status.active&&!release)release=beginUpdateActivity();else if(!status.active&&release){release();release=null;}
  let bar=document.querySelector('.native-now-playing');
  if(!status.active){bar?.remove();return;}
  if(!bar){bar=document.createElement('div');bar.className='native-now-playing';bar.innerHTML='<span></span><button type="button">プレーヤーを開く</button><button type="button">停止</button>';document.body.append(bar);
    bar.querySelectorAll('button')[0].onclick=()=>NativePlayer.show().catch(()=>{});
    bar.querySelectorAll('button')[1].onclick=()=>NativePlayer.stop().then(refreshNativePlayback).catch(()=>{});
  }
  bar.querySelector('span').textContent=(status.playing?'再生中: ':'一時停止: ')+(status.item?.title??'Mirea');
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
  await NativePlayer.open({...(artwork?{artwork}:{}),origin,token:session.token,userId:session.user.id,item,restart,continuous,analytics,version,autoplay:true,...(download?{download}:{})});
  await refreshNativePlayback();
}
