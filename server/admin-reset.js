import {lstat,readdir,readFile,open,rename,mkdir,rm,unlink,link} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {transaction} from './database.js';
import {httpError} from './security.js';
import {adminBody} from './admin.js';
import {MEDIA_GROUPS,STATE_MEDIA_GROUPS} from './storage.js';

export const RESET_CONFIRMATION='RESET MEDIA AND METADATA';
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const RESET_ACTION='media.reset';
const exists=async path=>{try{return await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
async function syncDirectory(path){if(process.platform==='win32')return;const h=await open(path,'r');try{await h.sync();}finally{await h.close();}}

// Only fixed application-owned media/work directories are eligible. Never
// accept a filesystem path over HTTP or recursively remove DATA_DIR/MEDIA_DIR.
export function createMediaReset({db,storage}){
  const journal=join(storage.dataDir,'media-reset.json');
  const groups=[...MEDIA_GROUPS.map(name=>({name,root:join(storage.mediaDir,name)})),...[...STATE_MEDIA_GROUPS,'admin-work'].map(name=>({name,root:join(storage.dataDir,name)}))];
  const quarantine=(g,id)=>join(dirname(g.root),`.mirea-reset-${id}-${g.name}`);
  const committed=id=>Boolean(db.prepare('SELECT 1 FROM admin_audit WHERE action=? AND target_id=?').get(RESET_ACTION,id));
  async function readJournal(){
    const info=await exists(journal);if(!info)return null;
    if(info.isSymbolicLink()||!info.isFile()||info.size>1024)throw Error('Unsafe media reset journal');
    const value=JSON.parse(await readFile(journal,'utf8'));
    if(value.version!==1||!UUID.test(value.id)||Object.keys(value).sort().join(',')!=='id,version')throw Error('Invalid media reset journal');
    return value;
  }
  async function checkRoots(){
    for(const base of new Set([storage.dataDir,storage.mediaDir])){const info=await lstat(base);if(!info.isDirectory()||info.isSymbolicLink())throw httpError(409,'リンク経由のデータ領域はリセットできません。');}
  }
  async function tree(path,hash,{empty=false}={},budget={n:0}){
    if(++budget.n>1000000)throw httpError(409,'ファイル数が多すぎます。停止中の保守作業で対応してください。');
    const info=await lstat(path);
    if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())throw httpError(409,'メディア領域にリンクまたは特殊ファイルがあるためリセットを中止しました。');
    hash?.update(JSON.stringify([path,info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs]));
    if(info.isFile()){if(empty)throw Error('Reset recovery refuses to overwrite new data');return {files:1,bytes:info.size};}
    let files=0,bytes=0;
    for(const name of (await readdir(path)).sort()){const part=await tree(join(path,name),hash,{empty},budget);files+=part.files;bytes+=part.bytes;}
    return {files,bytes};
  }
  const counts=()=>({accounts:db.prepare('SELECT COUNT(*) n FROM users').get().n,shelves:db.prepare('SELECT COUNT(*) n FROM shelves').get().n,series:db.prepare('SELECT COUNT(*) n FROM series').get().n,assets:db.prepare('SELECT COUNT(*) n FROM items').get().n,uploads:db.prepare('SELECT COUNT(*) n FROM upload_sessions').get().n,views:db.prepare('SELECT COUNT(*) n FROM analytics_views').get().n});
  async function snapshot(){
    await checkRoots();const hash=createHash('sha256'),totals={files:0,bytes:0};
    for(const g of groups){const part=await tree(g.root,hash);totals.files+=part.files;totals.bytes+=part.bytes;}
    const metadata=counts();hash.update(JSON.stringify(metadata));return {...metadata,...totals,fingerprint:hash.digest('hex')};
  }
  async function clearJournal(){await unlink(journal);await syncDirectory(storage.dataDir);}
  async function ensureDirectory(path){const info=await exists(path);if(info&&(!info.isDirectory()||info.isSymbolicLink()))throw Error('Unsafe media directory during reset recovery');await mkdir(path,{recursive:true,mode:0o700});}
  async function recover(){
    const state=await readJournal();if(!state)return;
    await checkRoots();
    if(committed(state.id)){
      // A power loss after SQLite commit must finish deletion, not restore
      // unreferenced media into a newly empty catalog.
      for(const g of groups){const old=quarantine(g,state.id);if(await exists(old)){await tree(old);await rm(old,{recursive:true,force:false});await syncDirectory(dirname(old));}await ensureDirectory(g.root);}
      for(const path of [storage.stagingDir,storage.booksDir,join(storage.uploadDir,'transfers'),join(storage.thumbnailDir,'custom')])await ensureDirectory(path);
    }else{
      // Before commit, publication metadata is intact. Restore moved roots.
      // initializeStorage may have recreated empty folders during startup.
      for(const g of [...groups].reverse()){
        const old=quarantine(g,state.id);if(!await exists(old))continue;await tree(old);
        if(await exists(g.root)){await tree(g.root,null,{empty:true});await rm(g.root,{recursive:true,force:false});}
        await rename(old,g.root);await syncDirectory(dirname(old));
      }
    }
    await clearJournal();
  }
  async function execute(audit,authorize){
    if(await readJournal())throw httpError(409,'前のリセットの復旧を先に完了してください。');
    const id=randomUUID(),temporary=journal+'.'+id+'.tmp';
    try{
      const handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(JSON.stringify({version:1,id})+'\n');await handle.sync();}finally{await handle.close();}
      await link(temporary,journal);await syncDirectory(storage.dataDir);
    }finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    try{
      // Renames are same-volume and keep rollback possible until DB commit.
      // No root is deleted in place and no account/secret/config is touched.
      for(const g of groups){authorize();await rename(g.root,quarantine(g,id));await syncDirectory(dirname(g.root));}
      authorize();transaction(db,()=>{
        db.exec("DELETE FROM analytics_views; DELETE FROM upload_sessions; DELETE FROM admin_jobs WHERE kind NOT IN ('backup_metadata','backup_full'); DELETE FROM series; DELETE FROM shelves;");
        audit(id);
      });
      await recover();
      return id;
    }catch(error){if(!committed(id))await recover();throw error;}
  }
  return {snapshot,counts,readJournal,recover,execute};
}

export function registerAdminReset(app,{db,storage,adminAccess:a,maintenance,reset,options={}}){
  const auth={onRequest:async req=>a.requireAdmin(req),config:{rateLimit:options.rateLimit===false?false:{max:6,timeWindow:'1 minute'}}};
  const plans=new Map();let retainedUnlock;
  app.get('/api/v1/admin/reset',auth,async()=>({pending:Boolean(await reset.readJournal()),...reset.counts(),confirmation:RESET_CONFIRMATION}));
  app.post('/api/v1/admin/reset/preview',auth,async req=>{
    const unlock=await maintenance.acquire(req);
    try{
      if(await reset.readJournal())throw httpError(409,'前のリセットの復旧を完了してください。');
      const snapshot=await reset.snapshot();a.requireAdmin(req);
      for(const [id,p] of plans)if(p.expiresAt<Date.now())plans.delete(id);
      while(plans.size>=10)plans.delete(plans.keys().next().value);
      const previewId=randomUUID(),expiresAt=Date.now()+5*60000;
      plans.set(previewId,{snapshot,expiresAt,session:req.session.id});
      const {fingerprint,...summary}=snapshot;return {previewId,expiresAt,...summary};
    }finally{unlock();}
  });
  app.post('/api/v1/admin/reset/apply',{...auth,schema:{body:adminBody({previewId:{type:'string',format:'uuid'},confirmText:{const:RESET_CONFIRMATION},acknowledgeBackup:{const:true},acknowledgeOffline:{const:true}})}},async req=>{
    await a.reauthenticate(req);const plan=plans.get(req.body.previewId);
    if(!plan||plan.session!==req.session.id||plan.expiresAt<Date.now())throw httpError(409,'削除対象を確認し直してください。');
    const unlock=await maintenance.acquire(req);let keepLocked=false;
    try{
      const current=await reset.snapshot();a.requireAdmin(req);
      if(current.fingerprint!==plan.snapshot.fingerprint)throw httpError(409,'確認後にデータが変更されました。削除対象を確認し直してください。');
      plans.delete(req.body.previewId);
      const id=await reset.execute(id=>a.audit(req,RESET_ACTION,id,{assets:current.assets,shelves:current.shelves,files:current.files,bytes:current.bytes}),()=>a.requireAdmin(req));
      app.log.info({resetId:id},'Media and metadata reset completed; accounts preserved');
      return {complete:true,message:'メタデータとアセットを削除しました。アカウント・権限・設定・暗号鍵・バックアップは保持しています。'};
    }catch(error){
      app.log.error({err:error},'Media reset failed');
      keepLocked=Boolean(await reset.readJournal());if(keepLocked){retainedUnlock=unlock;throw httpError(409,'リセットの後処理が未完了です。書き込みを停止しています。「後処理を再試行」してください。解消しない場合はストレージの権限・接続状態を確認してください。');}
      throw error.statusCode?error:httpError(409,'リセットできませんでした。データは復旧しました。保存領域の空き容量と書き込み権限を確認してください。');
    }finally{if(!keepLocked)unlock();}
  });
  app.post('/api/v1/admin/reset/recover',{...auth,schema:{body:adminBody({confirmText:{const:RESET_CONFIRMATION}})}},async req=>{
    await a.reauthenticate(req);
    const unlock=retainedUnlock??await maintenance.acquire(req);retainedUnlock=undefined;
    try{await reset.recover();for(const path of [storage.stagingDir,storage.booksDir,join(storage.uploadDir,'transfers'),join(storage.thumbnailDir,'custom')])await mkdir(path,{recursive:true,mode:0o700});a.audit(req,'media.reset.recover');unlock();return {complete:true,message:'後処理を完了しました。画面を更新してください。'};}
    catch(error){retainedUnlock=unlock;app.log.error({err:error},'Media reset recovery failed');throw httpError(409,'後処理を完了できません。サーバーログと保存領域の権限・接続状態を確認してください。');}
  });
}
