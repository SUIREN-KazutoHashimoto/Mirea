import {httpError} from './security.js';
export const RECOVERY_DEFAULTS={intervalMinutes:5,fullIntervalHours:24,retentionDays:30,reserveMiB:512};
export const RECOVERY_LIMITS={intervalMinutes:[1,1440],fullIntervalHours:[1,720],retentionDays:[7,365],reserveMiB:[64,1048576]};
const variables={intervalMinutes:'RECOVERY_INTERVAL_MINUTES',fullIntervalHours:'RECOVERY_FULL_INTERVAL_HOURS',retentionDays:'RECOVERY_RETENTION_DAYS',reserveMiB:'RECOVERY_RESERVE_MIB'};
export function recoverySettings(db,env=process.env){
 const configured={...RECOVERY_DEFAULTS,...JSON.parse(db.prepare("SELECT value FROM server_settings WHERE key='recovery'").get()?.value??'{}')},overrides={};
 const validate=(key,value)=>RECOVERY_LIMITS[key]&&Number.isSafeInteger(value)&&value>=RECOVERY_LIMITS[key][0]&&value<=RECOVERY_LIMITS[key][1];
 for(const [key,value]of Object.entries(configured))if(!validate(key,value))throw Error('Invalid recovery setting');
 for(const [key,variable]of Object.entries(variables))if(env[variable]!==undefined){const value=Number(env[variable]);if(!validate(key,value))throw Error('Invalid '+variable);overrides[key]={variable,value};}
 const applied=()=>Object.fromEntries(Object.entries(configured).map(([key,value])=>[key,overrides[key]?.value??value]));
 return {get value(){return applied();},get metadata(){return {configured:{...configured},applied:applied(),overrides};},update(values){for(const [key,value]of Object.entries(values))if(!validate(key,value))throw httpError(400,'自動保全の設定値を確認してください。');for(const [key,value]of Object.entries(values))if(!overrides[key])configured[key]=value;db.prepare("INSERT INTO server_settings(key,value) VALUES('recovery',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(configured));return this.metadata;}};
}
