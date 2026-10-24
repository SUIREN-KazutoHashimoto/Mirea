import {httpError} from './security.js';
export function registerProcessingSettings(app,{processingSettings,jobPool,adminAccess}){
  const auth={onRequest:async req=>adminAccess.requireAdmin(req)};
  app.get('/api/v1/admin/processing-settings',auth,async()=>processingSettings.value);
  app.get('/api/v1/admin/series-name-conflicts',auth,async()=>({groups:dbConflicts()}));
  function dbConflicts(){return processingSettings.conflicts;}
  app.patch('/api/v1/admin/processing-settings',{...auth,schema:{body:{type:'object',additionalProperties:false,required:['maxConcurrentUploads','maxConcurrentJobs','maxUploadAssets','currentPassword'],properties:{maxConcurrentUploads:{type:'integer',minimum:1,maximum:32},maxConcurrentJobs:{type:'integer',minimum:1,maximum:16},maxUploadAssets:{type:'integer',minimum:1,maximum:10000},currentPassword:{type:'string',minLength:1,maxLength:128}}}}},async req=>{
    await adminAccess.reauthenticate(req);const {currentPassword,...value}=req.body;
    processingSettings.update(value);jobPool.pump();adminAccess.audit(req,'processing.settings',null,value);return value;
  });
}
export function createProcessingSettings(db,env=process.env){
  const defaults={maxConcurrentUploads:Number(env.MAX_CONCURRENT_UPLOADS??3),maxConcurrentJobs:Number(env.MAX_CONCURRENT_JOBS??5),maxUploadAssets:Number(env.MAX_UPLOAD_ASSETS??1000)};
  const bounds={maxConcurrentUploads:32,maxConcurrentJobs:16,maxUploadAssets:10000};
  const valid=value=>Object.keys(defaults).every(key=>Number.isInteger(value[key])&&value[key]>=1&&value[key]<=bounds[key]);
  if(!valid(defaults))throw Error('Invalid upload/job concurrency settings');
  let current={...defaults,...JSON.parse(db.prepare("SELECT value FROM server_settings WHERE key='processing'").get()?.value??'{}')};
  if(!valid(current))throw Error('Invalid saved processing settings');
  return {get conflicts(){return db.prepare('SELECT COUNT(*) n FROM (SELECT shelf_id,parent_id,title FROM series GROUP BY shelf_id,parent_id,title HAVING COUNT(*)>1)').get().n;},get value(){return {...current};},update(value){if(!valid(value))throw httpError(400,'転送は1〜32件、後処理は1〜16件、一括選択は1〜10000件で指定してください。');
    db.prepare("INSERT INTO server_settings(key,value) VALUES('processing',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));current={...value};return {...current};}};
}
