import {lstat,opendir,rm} from 'node:fs/promises';
import {join,resolve,relative,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {httpError} from './security.js';
import {adminBody} from './admin.js';
import {transaction} from './database.js';

const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const uuid={type:'string',pattern:UUID.source};
const groupNames=['uploads','uploads/books','uploads/staging','uploads/transfers','videos','originals','previews','thumbnails','thumbnails/custom'];

// No arbitrary paths from HTTP. Only these media roots and UUID-named children
// are considered; DB/keys/backups/update packages/work directories are excluded.
export async function registerAdminCleanup(app,{db,dataDir,mediaDir=dataDir,adminAccess:a,maintenance,options={}}){
  const base=resolve(dataDir),mediaBase=resolve(mediaDir),roots=[...new Set([base,mediaBase])],groupPath=name=>join(/^(uploads|videos|originals)(\/|$)/.test(name)?mediaBase:base,name),snapshots=new Map(),graceMs=options.cleanupGraceMs??3600000;
  const child=path=>{const full=resolve(path),rel=relative(base,full);if(!roots.some(root=>{const r=relative(root,full);return r&&r!=='..'&&!r.startsWith('..'+sep)&&resolve(root,r)===full;}))throw new Error('Unsafe cleanup path');return full;};
  const hasReader=id=>Boolean(db.prepare(`SELECT 1 FROM items i JOIN memberships m ON m.shelf_id=i.shelf_id JOIN users u ON u.id=m.user_id LEFT JOIN user_access a ON a.user_id=u.id WHERE i.id=? AND COALESCE(a.disabled,0)=0 LIMIT 1`).get(id));
  const protectedUpload=id=>{const upload=db.prepare('SELECT state,expires_at FROM upload_sessions WHERE id=?').get(id);return Boolean(upload&&(upload.state==='processing'||upload.state==='failed'||upload.state==='uploading'&&upload.expires_at>Date.now()));};
  async function tree(path){
    const hash=createHash('sha256');let bytes=0,files=0,latest=0,count=0;
    async function visit(p){
      if(++count>10000)throw new Error('Cleanup tree exceeds safe scan budget');
      const info=await lstat(child(p));if(info.isSymbolicLink()||!info.isDirectory()&&!info.isFile())throw new Error('Cleanup refuses links/special files');
      latest=Math.max(latest,info.mtimeMs,info.ctimeMs);hash.update(JSON.stringify([(relative(mediaBase,p).startsWith('..')?'state/':'media/')+relative(relative(mediaBase,p).startsWith('..')?base:mediaBase,p),info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs,info.isDirectory()]));
      if(info.isDirectory()){
        const names=[];for await(const entry of await opendir(p)){if(names.length+count>=10000)throw new Error('Cleanup tree exceeds safe scan budget');names.push(entry.name);}
        for(const name of names.sort())await visit(join(p,name));
      }else{files++;bytes+=info.size;}
    }
    try{await visit(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    return {path,bytes,files,latest,fingerprint:hash.digest('hex')};
  }
  const assetPaths=id=>[...groupNames.map(name=>join(groupPath(name),id+(name==='previews'?'.mp4':name.startsWith('thumbnails')?'.jpg':''))),join(groupPath('thumbnails'),id+'.webp')];
  async function describe(candidate){
    const parts=[];let item;
    if(candidate.kind==='asset'){
      item=db.prepare('SELECT id,title,shelf_id FROM items WHERE id=?').get(candidate.assetId);
      if(!item||hasReader(item.id)||protectedUpload(item.id))return null;
      for(const path of assetPaths(item.id)){const part=await tree(path);if(part)parts.push(part);}
    }else{
      if(candidate.custom&&db.prepare('SELECT 1 FROM thumbnail_overrides WHERE image_id=?').get(candidate.assetId))return null;
      if(db.prepare('SELECT 1 FROM items WHERE id=?').get(candidate.assetId)||protectedUpload(candidate.assetId))return null;
      const part=await tree(candidate.path);if(!part||part.latest>Date.now()-graceMs)return null;parts.push(part);
    }
    return {...candidate,parts,bytes:parts.reduce((n,p)=>n+p.bytes,0),files:parts.reduce((n,p)=>n+p.files,0),fingerprint:createHash('sha256').update(JSON.stringify([item??null,parts.map(p=>p.fingerprint)])).digest('hex')};
  }
  const auth={onRequest:async req=>a.requireAdmin(req),config:{rateLimit:options.rateLimit===false?false:{max:4,timeWindow:'1 minute'}}};
  app.post('/api/v1/admin/cleanup/scan',auth,async req=>{
    const unlock=await maintenance.acquire(req);
    try{
      if((await Promise.all(roots.map(root=>lstat(root)))).some(info=>info.isSymbolicLink()))throw httpError(409,'リンク経由のデータ領域は自動整理できません。');
      for(const name of groupNames){const info=await lstat(groupPath(name)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(info?.isSymbolicLink())throw httpError(409,'メディア領域にリンクがあるため整理を中止しました。');}
      const candidates=[];let skipped=0,limited=false,budget=0;
      async function add(value){try{const c=await describe({...value,id:randomUUID()});if(c)candidates.push(c);}catch{skipped++;}}
      for(const item of db.prepare(`SELECT i.id,i.title,s.name AS shelf FROM items i JOIN shelves s ON s.id=i.shelf_id WHERE NOT EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN user_access a ON a.user_id=u.id WHERE m.shelf_id=i.shelf_id AND COALESCE(a.disabled,0)=0) ORDER BY i.id LIMIT 201`).all()){
        if(candidates.length>=200){limited=true;break;}await add({kind:'asset',assetId:item.id,title:item.title,shelf:item.shelf});
      }
      outer:for(const name of groupNames){
        const directory=await opendir(groupPath(name)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!directory)continue;
        for await(const file of directory){const entry=file.name;
          if(++budget>20000||candidates.length>=200){limited=true;break outer;}
          const id=(name==='previews'?entry.replace(/\.mp4$/,''):name.startsWith('thumbnails')?entry.replace(/\.(?:jpg|webp|input)$/,''):entry);
          if(!UUID.test(id)||name==='previews'&&!entry.endsWith('.mp4')||name.startsWith('thumbnails')&&!(/\.(?:jpg|webp|input)$/.test(entry)))continue;
          if(name==='thumbnails/custom'&&db.prepare('SELECT 1 FROM thumbnail_overrides WHERE image_id=?').get(id))continue;
          if(db.prepare('SELECT 1 FROM items WHERE id=?').get(id)||protectedUpload(id))continue;
          await add({kind:'orphan',custom:name==='thumbnails/custom',assetId:id,path:join(groupPath(name),entry),title:name+'/'+entry});
        }
      }
      a.requireAdmin(req);const scanId=randomUUID(),expiresAt=Date.now()+600000;
      for(const [id,value] of snapshots)if(value.expiresAt<Date.now())snapshots.delete(id);
      while(snapshots.size>=5)snapshots.delete(snapshots.keys().next().value);
      snapshots.set(scanId,{userId:req.user.id,expiresAt,candidates});
      return {scanId,expiresAt,limited,skippedUnsafe:skipped,orphanGraceHours:graceMs/3600000,candidates:candidates.map(({id,kind,assetId,title,shelf,bytes,files})=>({id,kind,assetId,title,shelf,bytes,files}))};
    }finally{unlock();}
  });
  app.post('/api/v1/admin/cleanup/delete',{...auth,schema:{body:adminBody({scanId:uuid,ids:{type:'array',items:uuid,minItems:1,maxItems:100,uniqueItems:true},confirmDelete:{const:'DELETE'},acknowledgeUnrecoverable:{const:true}})}},async req=>{
    await a.reauthenticate(req);
    const snapshot=snapshots.get(req.body.scanId);if(!snapshot||snapshot.userId!==req.user.id||snapshot.expiresAt<Date.now())throw httpError(409,'削除候補を再スキャンしてください。');
    const chosen=req.body.ids.map(id=>snapshot.candidates.find(c=>c.id===id));if(chosen.some(c=>!c))throw httpError(400,'候補以外のファイルは削除できません。');
    const unlock=await maintenance.acquire(req),results=[];
    try{
      for(const old of chosen){
        try{
          a.requireAdmin(req);const current=await describe(old);
          if(!current||current.fingerprint!==old.fingerprint){results.push({id:old.id,deleted:false,error:'権限またはファイルが変更されたため除外しました。再スキャンしてください。'});continue;}
          a.requireAdmin(req);
          if(current.kind==='asset')transaction(db,()=>{if(hasReader(current.assetId))throw httpError(409,'閲覧可能なアカウントが追加されました。');db.prepare('DELETE FROM items WHERE id=?').run(current.assetId);a.audit(req,'cleanup.asset.delete',current.assetId,{files:current.files,bytes:current.bytes});});
          // Each target is a previously enumerated UUID child, never a media
          // root. Recheck its complete no-link fingerprint just before removal.
          for(const part of current.parts){const checked=await tree(part.path);if(!checked||checked.fingerprint!==part.fingerprint)throw httpError(409,'ファイルの変更を検出し、削除を中止しました。');await rm(child(part.path),{recursive:true,force:false});}
          if(current.kind==='orphan')a.audit(req,'cleanup.orphan.delete',current.assetId,{mediaPath:groupNames.find(name=>current.path.startsWith(groupPath(name)+sep))+'/'+current.assetId,files:current.files,bytes:current.bytes});
          results.push({id:old.id,deleted:true,bytes:current.bytes});
        }catch(error){app.log.error({err:error,candidateId:old.id},'Cleanup candidate failed');results.push({id:old.id,deleted:false,error:'削除できないファイルがあります。再スキャンして確認してください。'});}
      }
      snapshots.delete(req.body.scanId);return {results};
    }finally{unlock();}
  });
}
