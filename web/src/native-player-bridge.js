import { Capacitor,registerPlugin } from '@capacitor/core';
export const NativePlayer=registerPlugin('MireaPlayback');
export const nativePlayerAvailable=()=>Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('MireaPlayback');
let generation=0,stopping=Promise.resolve();
export const nativePlaybackGeneration=()=>generation;
export function invalidateNativePlayback(){
  generation++;
  if(nativePlayerAvailable())stopping=stopping.catch(()=>{}).then(()=>NativePlayer.stop()).catch(()=>{});
  return stopping;
}
export const nativePlaybackStopped=()=>stopping;
