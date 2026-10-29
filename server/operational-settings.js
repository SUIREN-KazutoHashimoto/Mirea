import {httpError} from './security.js';
const definitions={maxUploadBytes:{variable:'MAX_UPLOAD_BYTES',default:2147483648,min:1048576,max:1099511627776},uploadChunkBytes:{variable:'UPLOAD_CHUNK_BYTES',default:8388608,min:65536,max:16777216},allowRegistration:{variable:'ALLOW_REGISTRATION',default:true,type:'boolean'},analyticsEnabled:{variable:'ANALYTICS_ENABLED',default:true,type:'boolean'}};
export function createOperationalSettings(db,env=process.env){
  const saved=JSON.parse(db.prepare("SELECT value FROM server_settings WHERE key='operational'").get()?.value??'{}'),overrides={};
  const valid=(key,value)=>definitions[key].type==='boolean'?typeof value==='boolean':Number.isSafeInteger(value)&&value>=definitions[key].min&&value<=definitions[key].max;
  for(const [key,spec]of Object.entries(definitions))if(env[spec.variable]!==undefined){const raw=env[spec.variable],value=spec.type==='boolean'?(raw==='true'?true:raw==='false'?false:null):Number(raw);if(!valid(key,value))throw Error('Invalid '+spec.variable);overrides[key]={variable:spec.variable,value};}
  const configured={...Object.fromEntries(Object.entries(definitions).map(([key,spec])=>[key,spec.default])),...saved};
  for(const [key,value]of Object.entries(configured))if(!definitions[key]||!valid(key,value))throw Error('Invalid saved operational setting');
  const applied=Object.fromEntries(Object.entries(configured).map(([key,value])=>[key,overrides[key]?.value??value]));
  return {value:applied,get metadata(){return {applied,configured:{...configured},overrides,restartRequired:Object.keys(configured).some(key=>!overrides[key]&&applied[key]!==configured[key])};},update(values){for(const [key,value]of Object.entries(values)){if(!definitions[key]||!valid(key,value))throw httpError(400,'設定値の範囲を確認してください。');if(!overrides[key])configured[key]=value;}db.prepare("INSERT INTO server_settings(key,value) VALUES('operational',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(configured));return this.metadata;}};
}
export function registerOperationalSettings(app,{settings,processingSettings,adminAccess}){
  const auth={onRequest:async req=>adminAccess.requireAdmin(req)};
  app.get('/api/v1/admin/server-settings',auth,async()=>({...settings.metadata,processingOverrides:processingSettings.overrides}));
  app.patch('/api/v1/admin/server-settings',{...auth,schema:{body:{type:'object',additionalProperties:false,required:['currentPassword','values'],properties:{currentPassword:{type:'string',minLength:1,maxLength:128},values:{type:'object',additionalProperties:false,properties:Object.fromEntries(Object.entries(definitions).map(([key,spec])=>[key,spec.type==='boolean'?{type:'boolean'}:{type:'integer',minimum:spec.min,maximum:spec.max}]))}}}}},async req=>{await adminAccess.reauthenticate(req);const result=settings.update(req.body.values);adminAccess.audit(req,'server.settings',null,req.body.values);return result;});
}
