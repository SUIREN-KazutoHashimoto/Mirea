import {offlineVault,offlinePartition} from './offline-vault.js';
import {getSession,getEndpoint} from './api.js';
import {mountPlaybackDock} from './playback-dock.js';
let serial=Promise.resolve(),dock,identity,lastStamp=0,lastKey;
const context=()=>{const session=getSession(),origin=getEndpoint();return session?{partition:offlinePartition(origin,session.user.id),userId:session.user.id,origin}:null;};
export function rememberPlayback(value,{force=false}={}){
 const ctx=context();if(!ctx||!value?.id||!['video','audio'].includes(value.kind))return;
 const stamp=Date.now(),key=ctx.partition+'|'+value.id;if(!force&&key===lastKey&&stamp-lastStamp<5000)return;lastKey=key;lastStamp=stamp;
 const ms=value=>Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
 const record={id:value.id,kind:value.kind,positionMs:ms(value.positionMs),durationMs:ms(value.durationMs),savedAt:stamp};
 serial=serial.catch(()=>{}).then(async()=>{if(context()?.partition!==ctx.partition)return;await(await offlineVault()).seal(ctx.partition,'playback-resume',record);});serial.catch(()=>{});
}
export function clearPlaybackPresentation(){dock?.dispose();dock=null;identity=null;}
export function forgetPlayback(){const ctx=context();clearPlaybackPresentation();lastKey=null;if(ctx){serial=serial.catch(()=>{}).then(async()=>{await(await offlineVault()).seal(ctx.partition,'playback-resume',null);});serial.catch(()=>{});}}
export function bindPlaybackResume(media,item){
 dock?.dispose();dock=null;
 const save=()=>rememberPlayback({id:item.id,kind:item.kind,positionMs:media.currentTime*1000,durationMs:media.duration*1000},{force:true}),tick=()=>rememberPlayback({id:item.id,kind:item.kind,positionMs:media.currentTime*1000,durationMs:media.duration*1000});
 const hide=()=>{save();media.pause();};for(const event of ['play','pause','seeked'])media.addEventListener(event,save);media.addEventListener('timeupdate',tick);window.addEventListener('pagehide',hide);save();
 return ()=>{for(const event of ['play','pause','seeked'])media.removeEventListener(event,save);media.removeEventListener('timeupdate',tick);window.removeEventListener('pagehide',hide);};
}
export async function restoreStoppedPlayback({items,open,loadArtwork,active=()=>false}){
 const ctx=context();if(!ctx)return;identity=ctx.partition;await serial.catch(()=>{});const record=await(await offlineVault()).unseal(ctx.partition,'playback-resume').catch(()=>null);
 if(!record||record.savedAt<Date.now()-7*86400000||context()?.partition!==ctx.partition||identity!==ctx.partition||active())return;
 const item=items.find(row=>row.id===record.id&&!row.pending&&!row.offlineUnavailable);if(!item)return;
 dock?.dispose();const resume=()=>{clearPlaybackPresentation();if(context()?.partition!==ctx.partition)return;return open(item);};dock=mountPlaybackDock({onRestore:resume,onToggle:resume,onStop:forgetPlayback,loadArtwork:(_state,signal)=>context()?.partition===ctx.partition?loadArtwork(item,signal):null});
 dock.update({key:ctx.partition+'|'+item.id,id:item.id,title:item.title,kind:item.kind,playing:false,positionMs:record.positionMs,durationMs:record.durationMs});
}
