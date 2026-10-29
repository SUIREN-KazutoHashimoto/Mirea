import {constants} from 'node:fs';
import {open,link,copyFile,rename,unlink,lstat} from 'node:fs/promises';
import {join} from 'node:path';
export async function publishCanonical({source,id,jobId,uploadDir,authorize=()=>{}}){
 const info=await lstat(source);if(!info.isFile()||info.isSymbolicLink()||!info.size)throw Error('Invalid canonical source');
 const temporary=join(uploadDir,id+'.'+jobId+'.canonical');authorize();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});
 try{try{await link(source,temporary);}catch(error){if(!['EXDEV','EPERM','ENOTSUP','EACCES'].includes(error.code))throw error;await copyFile(source,temporary,constants.COPYFILE_EXCL);}const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}authorize();await rename(temporary,join(uploadDir,id));if(process.platform!=='win32'){const folder=await open(uploadDir,'r');try{await folder.sync();}finally{await folder.close();}}}
 finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
