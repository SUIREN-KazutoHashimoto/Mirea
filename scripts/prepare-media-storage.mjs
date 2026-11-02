// Offline, opt-in, copy-only migration. NEVER deletes the original media.
import {lstat,readdir,mkdir,rename,rm,realpath} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {storagePaths,readLayout,saveLayout,MEDIA_GROUPS,LAYOUT_FILE,MEDIA_MARKER} from '../server/storage.js';
import {copyStorageTree} from '../server/storage-move.js';

export async function prepareMediaStorage({dataDir,mediaDir,acknowledgeStopped=false,acknowledgeBackup=false}){
 if(!acknowledgeStopped||!acknowledgeBackup)throw Error('Stop Mirea and back up the FULL data/configuration first; both acknowledgements are required');
 const paths=storagePaths(dataDir,mediaDir);if(!paths.separate)throw Error('The migration destination must differ from DATA_DIR');
 for(const path of [paths.dataDir,paths.mediaDir]){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Migration roots must be existing directories, not links');}
 storagePaths(await realpath(paths.dataDir),await realpath(paths.mediaDir));
 if((await readdir(paths.mediaDir)).length)throw Error('Destination must be EMPTY; never merge with or overwrite existing media');
 const state=await readLayout(join(paths.dataDir,LAYOUT_FILE));if(state?.mode==='separate')throw Error('This installation is already separated; do not recopy its old media');
 const database=join(paths.dataDir,'mirea.sqlite'),db=new DatabaseSync(database,{readOnly:true});
 try{if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Database integrity check failed');if(db.prepare("SELECT COUNT(*) n FROM upload_sessions WHERE state='processing' OR state='uploading' AND expires_at>?").get(Date.now()).n||db.prepare("SELECT COUNT(*) n FROM admin_jobs WHERE state IN ('queued','running')").get().n)throw Error('Finish or cancel active uploads/jobs before offline migration');}finally{db.close();}
 const layout={version:1,id:state?.id??randomUUID(),mode:'separate'},work=join(paths.mediaDir,'.mirea-migration-'+randomUUID()),copied=[];
 await mkdir(work,{mode:0o700});
 try{
  for(const group of MEDIA_GROUPS){const source=join(paths.dataDir,group),info=await lstat(source).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!info)continue;if(!info.isDirectory()||info.isSymbolicLink())throw Error('Media group must be a real directory');await copyStorageTree(source,join(work,group));copied.push(group);}
  // All bytes were verified before any destination group becomes final.
  for(const group of copied)await rename(join(work,group),join(paths.mediaDir,group));
  await saveLayout(join(paths.mediaDir,MEDIA_MARKER),layout);
  await saveLayout(join(paths.dataDir,LAYOUT_FILE),layout,{replace:Boolean(state)});
  return {success:true,separate:true,copiedGroups:copied,originalMediaDeleted:false,databaseAndKeysUnchanged:true,nextStep:'Set MEDIA_DIR to the destination, keep DATA_DIR unchanged, then start Mirea and verify before manually retiring old copies'};
 }finally{
  if(!resolve(work).startsWith(paths.mediaDir+sep+'.mirea-migration-'))throw Error('Unsafe migration workspace');
  await rm(work,{recursive:true,force:true});
 }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2),value=name=>args.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
 if(args.some(a=>!/^--(?:data-dir|media-dir)=.+$/.test(a)&&!['--acknowledge-stopped','--acknowledge-full-backup'].includes(a)))throw Error('Unknown migration argument');
 console.log(JSON.stringify(await prepareMediaStorage({dataDir:value('data-dir'),mediaDir:value('media-dir'),acknowledgeStopped:args.includes('--acknowledge-stopped'),acknowledgeBackup:args.includes('--acknowledge-full-backup')})));
}
