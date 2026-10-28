import {rename,copyFile,lstat,readdir,mkdir,open,rm,unlink} from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import {dirname,join,resolve,relative,sep,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

async function digest(path){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}
async function syncDirectory(path){if(process.platform!=='win32'){const h=await open(path,'r');try{await h.sync();}finally{await h.close();}}}
export async function copyStorageTree(source,destination,{authorize=()=>{}}={}){
 authorize();const before=await lstat(source);if(before.isSymbolicLink()||!before.isFile()&&!before.isDirectory())throw Error('Storage copy refuses links and special files');
 if(before.isDirectory()){
  await mkdir(destination,{mode:0o700});for(const name of await readdir(source))await copyStorageTree(join(source,name),join(destination,name),{authorize});await syncDirectory(destination);
 }else{
  await copyFile(source,destination,constants.COPYFILE_EXCL);const h=await open(destination,'r+');try{await h.sync();}finally{await h.close();}
  const after=await lstat(source),copy=await lstat(destination);
  if(after.isSymbolicLink()||after.size!==before.size||after.mtimeMs!==before.mtimeMs||copy.size!==before.size||await digest(source)!==await digest(destination))throw Error('Storage copy verification failed');
 }
 authorize();
}
// Only internally generated, private outputs use this helper. For EXDEV, copy
// into a unique destination-side staging directory, verify+fsync, then publish
// with a same-filesystem rename. Raw sources remain recoverable until success.
export async function moveStorage(source,destination,{authorize=()=>{},renameFile=rename,onSourceCleanupError=()=>{}}={}){
 source=resolve(source);destination=resolve(destination);const rel=relative(source,destination);if(!rel||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep))throw Error('Invalid storage move');
 authorize();try{await renameFile(source,destination);await syncDirectory(dirname(destination));return;}catch(error){if(error.code!=='EXDEV')throw error;}
 const parent=dirname(destination),work=join(parent,'.mirea-publish-'+randomUUID()),payload=join(work,'payload');await mkdir(work,{mode:0o700});
 try{await copyStorageTree(source,payload,{authorize});authorize();await rename(payload,destination);await syncDirectory(parent);}
 catch(error){throw error;}
 finally{await rm(work,{recursive:true,force:true});}
 // Cleanup failure must never undo an already published generation. Its old
 // private workspace is retried/cleaned by the caller's existing job lifecycle.
 try{const info=await lstat(source);if(info.isDirectory())await rm(source,{recursive:true,force:false});else await unlink(source);}catch(error){onSourceCleanupError(error);}
}
