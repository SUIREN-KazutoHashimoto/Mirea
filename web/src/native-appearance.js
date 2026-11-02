import {Capacitor,registerPlugin} from '@capacitor/core';
const Appearance=registerPlugin('MireaAppearance');
export function syncAppearance(theme){if(Capacitor.getPlatform()==='android'&&Capacitor.isPluginAvailable('MireaAppearance'))Appearance.setTheme({theme}).catch(()=>{});}
