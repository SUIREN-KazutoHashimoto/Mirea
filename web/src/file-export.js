import {Capacitor,registerPlugin} from '@capacitor/core';
import {createExportWriter} from './file-export-core.js';
const exporter=registerPlugin('MireaFileExport');
export const nativeExportAvailable=()=>Capacitor.isNativePlatform()&&Capacitor.isPluginAvailable('MireaFileExport');
export const nativeFileWriter=(name,mime,size)=>createExportWriter(exporter,name,mime,size);
