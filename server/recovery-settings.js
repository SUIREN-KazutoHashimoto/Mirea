import {httpError} from './security.js';
export const RECOVERY_DEFAULTS={intervalMinutes:5,retentionDays:30,reserveMiB:512,automaticBudgetMiB:16384};
export const RECOVERY_LIMITS={intervalMinutes:[1,1440],retentionDays:[7,365],reserveMiB:[64,1048576],automaticBudgetMiB:[64,1048576]};
const variables={intervalMinutes:'RECOVERY_INTERVAL_MINUTES',retentionDays:'RECOVERY_RETENTION_DAYS',reserveMiB:'RECOVERY_RESERVE_MIB',automaticBudgetMiB:'RECOVERY_AUTOMATIC_BUDGET_MIB'};
export function recoverySettings(db,env=process.env){
 const saved=JSON.parse(db.prepare("SELECT value FROM server_settings WHERE key='recovery'").get()?.value??'{}');
 // Retain compatibility with a 2.1.0 setting without starting a media copy.
 const {fullIntervalHours:legacyFullIntervalHours,...metadataSettings}=saved;
 const configured={...RECOVERY_DEFAULTS,...metadataSettings},overrides={},ignored=[];
 if(legacyFullIntervalHours!==undefined)ignored.push({setting:'fullIntervalHours',value:legacyFullIntervalHours});
 if(env.RECOVERY_FULL_INTERVAL_HOURS!==undefined)ignored.push({variable:'RECOVERY_FULL_INTERVAL_HOURS',value:env.RECOVERY_FULL_INTERVAL_HOURS});
 const validate=(key,value)=>RECOVERY_LIMITS[key]&&Number.isSafeInteger(value)&&value>=RECOVERY_LIMITS[key][0]&&value<=RECOVERY_LIMITS[key][1];
 for(const [key,value]of Object.entries(configured))if(!validate(key,value))throw Error('Invalid recovery setting');
 for(const [key,variable]of Object.entries(variables))if(env[variable]!==undefined){const value=Number(env[variable]);if(!validate(key,value))throw Error('Invalid '+variable);overrides[key]={variable,value};}
 const applied=()=>Object.fromEntries(Object.entries(configured).map(([key,value])=>[key,overrides[key]?.value??value]));
 return {get value(){return applied();},get metadata(){return {configured:{...configured},applied:applied(),overrides,ignored};},update(values){for(const [key,value]of Object.entries(values))if(!validate(key,value))throw httpError(400,'メタデータ保全の設定値を確認してください。');for(const [key,value]of Object.entries(values))if(!overrides[key])configured[key]=value;db.prepare("INSERT INTO server_settings(key,value) VALUES('recovery',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(configured));return this.metadata;}};
}
