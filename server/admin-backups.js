import {backup} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdir,lstat,readdir,stat,unlink,readFile,statfs} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {PROJECT_ROOT} from './runtime.js';
import {httpError,parseRange} from './security.js';
import {removeItemDirectory} from './media.js';
import {encryptBackup} from './backup-archive.js';
import {adminBody} from './admin.js';

const TTL=24*3600000;
export async function registerAdminBackups(app,{db,dataDir,mediaDir=dataDir,adminAccess:a,maintenance,options}){
  const directory=join(dataDir,'admin-backups');await mkdir(directory,{recursive:true,mode:0o700});
  const pathFor=id=>join(directory,id+'.mireabackup');
  const jobs=()=>db.prepare("SELECT id,kind,state,progress_json,error,created_at,updated_at,output_size FROM admin_jobs WHERE kind IN ('backup_metadata','backup_full') ORDER BY created_at DESC LIMIT 100").all();
  const pending=new Set();let closing=false;
  async function sweep(){
    for(const row of jobs())if(row.updated_at<Date.now()-TTL && !pending.size){await unlink(pathFor(row.id)).catch(e=>{if(e.code!=='ENOENT')throw e;});db.prepare('DELETE FROM admin_jobs WHERE id=?').run(row.id);}
  }
  for(const row of jobs())if(['queued','running'].includes(row.state)){
    db.prepare("UPDATE admin_jobs SET state='failed',error=?,updated_at=? WHERE id=?").run('サーバー再起動により中断されました。パスワードを保存していないため作り直してください。',Date.now(),row.id);
    await unlink(pathFor(row.id)).catch(e=>{if(e.code!=='ENOENT')throw e;});await removeItemDirectory(directory,row.id);
  }
  await sweep();const timer=setInterval(()=>{if(!maintenance.locked)sweep().catch(error=>app.log.error({err:error},'Backup expiry cleanup failed'));},600000);timer.unref();
  app.addHook('onClose',async()=>{closing=true;clearInterval(timer);await Promise.allSettled([...pending]);});
  async function run(id,mode,password,userId,release){
    const work=join(directory,id);
    try{
      const authorize=()=>{if(closing||!a.isAdmin(userId))throw httpError(403,'バックアップが中断されたか、管理権限が解除されました。');};
      await mkdir(work,{mode:0o700});
      db.prepare("UPDATE admin_jobs SET state='running',updated_at=? WHERE id=?").run(Date.now(),id);
      const snapshot=join(work,'mirea.sqlite');await backup(db,snapshot);authorize();
      const files=[];
      const add=async(path,name)=>{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new Error('Only regular backup files are allowed');files.push({path,name,size:info.size,mtime:info.mtimeMs});};
      const walk=async(path,name)=>{const info=await lstat(path);if(info.isSymbolicLink())throw new Error('Backup may not follow links');if(info.isDirectory()){for(const entry of await readdir(path))await walk(join(path,entry),name+'/'+entry);}else await add(path,name);};
      await add(snapshot,'data/mirea.sqlite');
      for(const name of mode==='full'?['keys','uploads','videos','originals','previews','thumbnails']:['keys']){
        const path=join(['uploads','videos','originals'].includes(name)?mediaDir:dataDir,name);if(await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))await walk(path,'data/'+name);
      }
      const configPath=options.backupConfigFile??join(PROJECT_ROOT,'.env');
      if(await lstat(configPath).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))await add(configPath,'configuration/server.env');
      const metadata=Buffer.from(JSON.stringify({format:1,mode,createdAt:new Date().toISOString(),schema:db.prepare('SELECT version FROM schema_version').get().version,
        settings:{allowRegistration:options.allowRegistration??process.env.ALLOW_REGISTRATION!=='false',analyticsEnabled:options.analyticsEnabled??process.env.ANALYTICS_ENABLED!=='false',serverAdminUserIds:options.serverAdminUserIds??process.env.SERVER_ADMIN_USER_IDS??'',maxUploadBytes:options.maxUploadBytes??process.env.MAX_UPLOAD_BYTES??2147483648},
        includesPersonalLogs:true,includesDownloadKey:true,mediaIncluded:mode==='full',storage:{separate:mediaDir!==dataDir,archiveLayout:'combined',restore:'Restore logical data/ tree into DATA_DIR; migrate media offline before enabling MEDIA_DIR'},
        files:files.map(file=>({name:file.name,size:file.size,mtimeMs:file.mtime})),
        excluded:['OS/runtime','TLS and CA private keys outside DATA_DIR','APK/update signing keys','other backup archives','maintenance helper configuration']},null,2));
      files.unshift({name:'backup-manifest.json',size:metadata.length,bytes:metadata});
      const total=files.reduce((n,f)=>n+f.size,0),free=await statfs(directory);
      if(Number(free.bavail)*Number(free.bsize)<total+64*1024*1024)throw httpError(507,'バックアップ用の空き容量が不足しています。');
      let reported=0;
      await encryptBackup({files,destination:pathFor(id),password,authorize,progress:value=>{if(Date.now()-reported>500){reported=Date.now();db.prepare('UPDATE admin_jobs SET progress_json=?,updated_at=? WHERE id=?').run(JSON.stringify({stage:'archive',...value}),Date.now(),id);}}});
      authorize();const size=(await stat(pathFor(id))).size;
      db.prepare("UPDATE admin_jobs SET state='complete',output_size=?,progress_json=?,updated_at=? WHERE id=?").run(size,JSON.stringify({stage:'complete',percent:100}),Date.now(),id);
    }catch(error){
      db.prepare("UPDATE admin_jobs SET state='failed',error=?,updated_at=? WHERE id=?").run(error.statusCode?error.message:'バックアップを作成できませんでした。容量と読み取り権限を確認してください。',Date.now(),id);
      await unlink(pathFor(id)).catch(e=>{if(e.code!=='ENOENT')throw e;});app.log.error({err:error,backupId:id},'Backup failed');
    }finally{password='';try{await removeItemDirectory(directory,id);}finally{release();}}
  }
  const auth={onRequest:async req=>a.requireAdmin(req)};
  app.get('/api/v1/admin/backups',auth,async()=>({backups:jobs().map(row=>({id:row.id,mode:row.kind==='backup_full'?'full':'metadata',state:row.state,progress:JSON.parse(row.progress_json),size:row.output_size,error:row.error,createdAt:row.created_at,expiresAt:row.updated_at+TTL}))}));
  app.post('/api/v1/admin/backups',{...auth,config:{rateLimit:options.rateLimit===false?false:{max:3,timeWindow:'1 minute'}},schema:{body:adminBody({mode:{enum:['metadata','full']},backupPassword:{type:'string',minLength:12,maxLength:128},acknowledgeSensitive:{const:true}})}},async(req,reply)=>{
    await a.reauthenticate(req);const release=await maintenance.acquire();
    try{
      if(closing)throw httpError(503,'サーバー停止中です。');
      const id=randomUUID(),now=Date.now();db.prepare("INSERT INTO admin_jobs(id,kind,state,requested_by,created_at,updated_at) VALUES(?,?,'queued',?,?,?)").run(id,'backup_'+req.body.mode,req.user.id,now,now);
      a.audit(req,'backup.create',id,{mode:req.body.mode});
      const task=run(id,req.body.mode,req.body.backupPassword,req.user.id,release);pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{});
      req.body.backupPassword='';return reply.code(202).send({id});
    }catch(error){release();throw error;}
  });
  app.route({method:['GET','HEAD'],url:'/api/v1/admin/backups/:id/content',...auth,handler:async(req,reply)=>{
    const row=db.prepare("SELECT * FROM admin_jobs WHERE id=? AND kind IN ('backup_metadata','backup_full') AND state='complete'").get(req.params.id);
    if(!row||row.updated_at+TTL<Date.now())throw httpError(404,'バックアップが見つからないか、保持期限が切れています。');
    const info=await stat(pathFor(row.id));a.requireAdmin(req);
    let range;try{range=parseRange(req.headers.range,info.size);}catch(error){reply.header('Content-Range',`bytes */${info.size}`);throw error;}
    reply.type('application/octet-stream').header('Content-Disposition',`attachment; filename="mirea-${row.kind}-${row.id}.mireabackup"`).header('Accept-Ranges','bytes').header('Content-Length',range?range.end-range.start+1:info.size);
    if(range)reply.code(206).header('Content-Range',`bytes ${range.start}-${range.end}/${info.size}`);
    return req.method==='HEAD'?reply.send():reply.send(createReadStream(pathFor(row.id),range??{}));
  }});
  app.delete('/api/v1/admin/backups/:id',{...auth,schema:{body:adminBody()}},async(req,reply)=>{
    await a.reauthenticate(req);const row=jobs().find(row=>row.id===req.params.id);if(!row)throw httpError(404,'バックアップが見つかりません。');
    if(['queued','running'].includes(row.state)||maintenance.locked)throw httpError(409,'バックアップ作成中です。');
    await unlink(pathFor(row.id)).catch(e=>{if(e.code!=='ENOENT')throw e;});a.requireAdmin(req);db.prepare('DELETE FROM admin_jobs WHERE id=?').run(row.id);a.audit(req,'backup.delete',row.id);return reply.code(204).send();
  });
}
