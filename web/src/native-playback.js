import { mountPlaybackDock } from './playback-dock.js';
import { authenticatedBlob } from './api.js';
import { getSession,getEndpoint,isOfflineSession,requireCompatibleServer } from './api.js';
import { NativePlayer,nativePlayerAvailable,nativePlaybackGeneration,nativePlaybackStopped } from './native-player-bridge.js';
import { prepareNativeDownload,downloadedThumbnail,listDownloads } from './downloads.js';
import {offlineCatalog,offlineCollection,offlineSeriesContext} from './offline-catalog.js';
import {offlineVault,offlinePartition} from './offline-vault.js';
import { beginUpdateActivity } from './update-busy.js';
import {shelfUnlockValue} from './private-shelves.js';
import {rememberPlayback,forgetPlayback,clearPlaybackPresentation} from './playback-resume.js';
import {playlistContext} from './playlist-context.js';

let release,dock,dockIdentity,refreshEpoch=0;
export async function refreshNativePlayback(eventState){
  if(!nativePlayerAvailable())return;
  const epoch=++refreshEpoch,actor=getSession(),origin=getEndpoint(),generation=nativePlaybackGeneration(),identity=origin+'|'+actor?.user.id;
  if(dockIdentity!==identity){dock?.dispose();dock=null;dockIdentity=identity;}
  await nativePlaybackStopped();
  const current=()=>epoch===refreshEpoch&&getSession()?.token===actor?.token&&getEndpoint()===origin&&nativePlaybackGeneration()===generation;
  const status=typeof eventState?.active==='boolean'?eventState:await NativePlayer.status();if(!current())return;
  if(status.active&&!release)release=beginUpdateActivity();else if(!status.active&&release){release();release=null;}
  if(!status.active||!actor){dock?.dispose();dock=null;return;}
  rememberPlayback({id:status.item?.id,kind:status.video?'video':'audio',positionMs:status.positionMs,durationMs:status.durationMs});
  if(!dock)dock=mountPlaybackDock({onRestore:()=>NativePlayer.show(),onToggle:state=>state.playing?NativePlayer.pause():NativePlayer.play(),onStop:()=>{forgetPlayback();return NativePlayer.stop().then(refreshNativePlayback);},loadArtwork:async(state,signal)=>{
    const valid=()=>!signal.aborted&&getEndpoint()===state.origin&&getSession()?.user.id===state.userId;
    if(!valid())return null;const cover=await downloadedThumbnail(state.id).catch(()=>null);if(!valid())return null;
    return cover||authenticatedBlob('/api/v1/items/'+state.id+'/thumbnail',signal);
  }});
  dock.update({origin,userId:actor.user.id,key:origin+'|'+actor.user.id+'|'+status.item?.id,id:status.item?.id,title:status.item?.title,kind:status.video?'video':'audio',playing:status.playing,positionMs:status.positionMs,durationMs:status.durationMs});
}
export async function initializeNativePlayback(){
  if(!nativePlayerAvailable())return;
  await NativePlayer.addListener('playbackState',state=>refreshNativePlayback(state).catch(()=>{}));
  await refreshNativePlayback();
}
export async function openNativePlayback(item,{restart=false,continuous=true,analytics=false,version='',playlistId,isCurrent=()=>true,progress=()=>{}}={}){
  requireCompatibleServer();
  clearPlaybackPresentation();
  await nativePlaybackStopped();const session=getSession(),origin=getEndpoint(),epoch=nativePlaybackGeneration();
  if(!session)throw new Error('ログインしてください。');
  const valid=()=>isCurrent()&&nativePlaybackGeneration()===epoch&&getSession()?.token===session.token&&getEndpoint()===origin;
  const download=await prepareNativeDownload(item,valid,progress);
  if(!valid())throw new Error('再生準備を取り消しました。');
  let artwork;
  if(download){const cover=await downloadedThumbnail(item.id).catch(()=>null);if(cover){const bytes=new Uint8Array(await cover.arrayBuffer()),parts=[];for(let n=0;n<bytes.length;n+=8192)parts.push(String.fromCharCode(...bytes.subarray(n,n+8192)));artwork=btoa(parts.join(''));bytes.fill(0);}}
  if(!valid())throw new Error('再生準備を取り消しました。');
  let offlineSeries;
  // Carry the cached series even when starting online. Connectivity can change
  // while the native Activity owns playback and the WebView is suspended.
  if(download){
    const partition=offlinePartition(origin,session.user.id),catalog=await(await offlineCatalog()).load(partition).catch(()=>null);
    if(catalog){
      const rows=await listDownloads(),vault=await offlineVault(),playable=new Set(),members=new Set((playlistId?playlistContext(catalog.playlists??[],offlineCollection(catalog,rows,playable).items,playlistId,item.id):offlineSeriesContext(offlineCollection(catalog,rows,playable),item.id)).items.map(asset=>asset.id));
      const ready=rows.filter(row=>row.state==='ready'&&members.has(row.assetId));let index=0;
      await Promise.all(Array.from({length:Math.min(4,ready.length)},async()=>{while(valid()&&index<ready.length){const row=ready[index++],lease=await vault.lease(partition,row.manifest.id).catch(()=>null);if(lease){playable.add(row.assetId);lease.key='';}}}));
      const context=playlistId?playlistContext(catalog.playlists??[],offlineCollection(catalog,rows,playable).items,playlistId,item.id):offlineSeriesContext(offlineCollection(catalog,rows,playable),item.id);
      if(context.series){const manifests=new Map(rows.filter(row=>row.state==='ready'&&playable.has(row.assetId)&&['audio','video'].includes(row.manifest.kind)).map(row=>[row.assetId,row.manifest]));offlineSeries={...context,items:context.items.map(asset=>({...asset,...(manifests.has(asset.id)?{offlineDownload:manifests.get(asset.id)}:{})}))};}
    }
  }
  if(!valid())throw new Error('再生準備を取り消しました。');
  await NativePlayer.open({...(playlistId?{playlistId}:{}),...(offlineSeries?{offlineSeries}:{}),...(artwork?{artwork}:{}),origin,token:session.token,userId:session.user.id,shelfUnlock:shelfUnlockValue(),item,restart,continuous,analytics,version,autoplay:true,...(download?{download,offline:isOfflineSession()}:{})});
  await refreshNativePlayback();
}
