import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readManifest,restoreRecoveryPoint,verifyRecoveryPoint} from '../server/recovery-store.js';
export async function recover(args){
 const values={};for(const arg of args){if(arg==='--metadata-only'||arg==='--verify-only'){values[arg.slice(2)]=true;continue;}const match=/^--(store|snapshot|destination)=(.+)$/.exec(arg);if(!match||values[match[1]]!==undefined)throw Error('Use --store=PATH --snapshot=ID and --verify-only or --destination=EMPTY_PATH [--metadata-only]');values[match[1]]=match[2];}
 if(!values.store||!values.snapshot||!values['verify-only']&&!values.destination)throw Error('A backup store, snapshot and empty destination (or --verify-only) are required');
 const directory=resolve(values.store),manifest=await readManifest(directory,values.snapshot);
 if(values['verify-only']){
  await verifyRecoveryPoint(directory,values.snapshot);
  return {verified:true,id:manifest.id,scope:manifest.scope,files:manifest.files.length,version:manifest.version,previousVersion:manifest.previousVersion};
 }
 const restored=await restoreRecoveryPoint({directory,id:values.snapshot,destination:resolve(values.destination),metadataOnly:Boolean(values['metadata-only'])});
 return {verified:true,restored:true,id:restored.id,scope:restored.scope,files:restored.files.length,requiresMatchingMedia:restored.scope!=='full',requiresStoppedServer:true};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{console.log(JSON.stringify(await recover(process.argv.slice(2)),null,2));}catch(error){console.error(JSON.stringify({success:false,code:/^RECOVERY_[A-Z_]+$/.test(error.code??'')?error.code:'RECOVERY_FAILED',message:'復旧を完了できませんでした。元データは変更していません。引数・空き容量・バックアップの検証結果を確認してください。'}));process.exitCode=1;}}
