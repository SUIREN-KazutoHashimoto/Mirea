import {Capacitor,registerPlugin} from '@capacitor/core';
const Appearance=registerPlugin('MireaAppearance');
export function syncAppearance(theme){if(Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('MireaAppearance'))Appearance.setTheme({theme}).catch(()=>{});}

let drawerQueue=Promise.resolve(),drawerRevision=0;
export function syncDrawerGesture(enabled){if(Capacitor.getPlatform()!=='android'||!Capacitor.isPluginAvailable('MireaAppearance'))return;const revision=++drawerRevision;drawerQueue=drawerQueue.catch(()=>{}).then(()=>revision===drawerRevision?Appearance.setLibraryDrawerGesture({enabled:Boolean(enabled)}):undefined).catch(()=>{});}
