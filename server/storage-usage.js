import {lstat,opendir} from 'node:fs/promises';
import {join} from 'node:path';
import {MEDIA_GROUPS,STATE_MEDIA_GROUPS} from './storage.js';

// Metadata only. Never follow links, read media contents, or expose paths.
export async function scanMediaUsage({dataDir,mediaDir=dataDir,signal}){
 let totalBytes=0,fileCount=0,skippedLinks=0;const linked=new Set();
 async function walk(path){
  signal?.throwIfAborted();let info;try{info=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(info.isSymbolicLink()){skippedLinks++;return;}
  if(info.isDirectory()){
   try{const directory=await opendir(path);for await(const entry of directory){signal?.throwIfAborted();await walk(join(path,entry.name));}}catch(error){if(error.code!=='ENOENT')throw error;}
  }else if(info.isFile()){
   if(info.nlink>1n&&info.ino!==0n){const key=info.dev+':'+info.ino;if(linked.has(key))return;linked.add(key);}
   const size=Number(info.size);if(!Number.isSafeInteger(size)||!Number.isSafeInteger(totalBytes+size))throw Error('Storage total exceeds numeric range');totalBytes+=size;fileCount++;
  }
 }
 for(const [base,names]of [[mediaDir,MEDIA_GROUPS],[dataDir,STATE_MEDIA_GROUPS]])for(const name of names)await walk(join(base,name));
 return {totalBytes,fileCount,skippedLinks};
}

export function createMediaUsage(paths,{now=Date.now,maxAge=60000,scan=scanMediaUsage}={}){
 let value={state:'calculating',totalBytes:null,fileCount:null,measuredAt:null},finishedAt=-Infinity,running,closed=false;const controller=new AbortController();
 return {snapshot(){
  if(!closed&&!running&&now()-finishedAt>=maxAge){
   value={...value,state:'calculating'};
   running=Promise.resolve().then(()=>scan({...paths,signal:controller.signal})).then(result=>{value={...result,state:'ready',measuredAt:now()};},()=>{value={state:'unavailable',totalBytes:null,fileCount:null,measuredAt:now()};}).finally(()=>{finishedAt=now();running=null;});
  }
  return {...value};
 },async idle(){await running;},async close(){closed=true;controller.abort();await running;}};
}
