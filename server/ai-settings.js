import {availableParallelism,totalmem} from 'node:os';
import {httpError} from './security.js';
import {AI_FEATURES} from './ai-validation.js';

const defaults={
  enabled:false,backend:'cpu',threads:Math.max(1,Math.min(4,availableParallelism()-1)),
  concurrentJobs:1,residentModels:2,memoryMiB:Math.min(8192,Math.max(1024,Math.floor((process.constrainedMemory?.()||totalmem())/1024**2/2))),
  contextTokens:8192,outputTokens:4096,loadTimeoutMs:180000,idleMs:60000,
  temporaryMiB:2048,models:{},quietHours:null
};
export const AI_SETTING_RANGES={threads:[1,64],concurrentJobs:[1,4],residentModels:[1,3],memoryMiB:[512,131072],
  contextTokens:[2048,32768],outputTokens:[512,16384],loadTimeoutMs:[30000,600000],
  idleMs:[10000,600000],temporaryMiB:[128,32768]};
const overrides={enabled:'AI_ENABLED',backend:'AI_BACKEND',threads:'AI_THREADS',memoryMiB:'AI_MEMORY_MIB',
  concurrentJobs:'AI_CONCURRENT_JOBS'};
export function validateAiSettings(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.keys(defaults).includes(k)))
    throw httpError(422,'AI設定の項目を確認してください。');
  const result={...defaults,...value,models:{...value.models}};
  if(typeof result.enabled!=='boolean'||!['cpu','vulkan'].includes(result.backend))
    throw httpError(422,'AIの実行方式を確認してください。');
  for(const [key,[min,max]]of Object.entries(AI_SETTING_RANGES))
    if(!Number.isSafeInteger(result[key])||result[key]<min||result[key]>max)
      throw httpError(422,'AIの資源設定を確認してください。');
  if(result.outputTokens>result.contextTokens)throw httpError(422,'出力の上限を文脈サイズ以内にしてください。');
  if(Object.entries(result.models).some(([key,id])=>!AI_FEATURES.includes(key)||!/^[0-9a-f]{64}$/.test(id)))
    throw httpError(422,'解析に使う導入済みモデルを選んでください。');
  if(result.quietHours!==null&&(!Array.isArray(result.quietHours)||result.quietHours.length!==2||
      result.quietHours.some(n=>!Number.isSafeInteger(n)||n<0||n>23)))
    throw httpError(422,'解析時間帯を確認してください。');
  return result;
}
export function createAiSettings(db,env=process.env) {
  const read=()=>JSON.parse(db.prepare("SELECT value FROM server_settings WHERE key='ai'").get()?.value??'{}');
  function effective() {
    const saved={...defaults,...read()},applied={};
    for(const [key,variable]of Object.entries(overrides))if(env[variable]!==undefined){
      if(key==='enabled'&&!['true','false'].includes(env[variable]))throw httpError(422,'AI_ENABLEDはtrueまたはfalseを指定してください。');
      const value=key==='enabled'?env[variable]==='true':key==='backend'?env[variable]:Number(env[variable]);
      applied[key]={variable,value};saved[key]=value;
    }
    return {value:validateAiSettings(saved),overrides:applied};
  }
  effective();
  return {get value(){return effective().value;},inspect:()=>({...effective(),ranges:AI_SETTING_RANGES,saved:{...defaults,...read()}}),
    save(patch){
      const current=effective(),next={...current.value,...patch};
      for(const key of Object.keys(current.overrides))if(patch[key]!==undefined&&patch[key]!==current.value[key])
        throw httpError(409,'環境変数で指定されている設定です。');
      const value=validateAiSettings(next),saved={...value};
      for(const key of Object.keys(current.overrides))saved[key]=read()[key]??defaults[key];
      db.prepare("INSERT INTO server_settings VALUES('ai',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(saved));
      return effective();
    }};
}
