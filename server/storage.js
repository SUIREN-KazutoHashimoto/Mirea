import {mkdir,lstat,readdir,readFile,rename,unlink,realpath,open,link} from 'node:fs/promises';
import {join,resolve,relative,sep,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';

export const MEDIA_GROUPS=['uploads','videos','originals'];
export const STATE_MEDIA_GROUPS=['previews','thumbnails'];
export const LAYOUT_FILE='storage-layout.json',MEDIA_MARKER='.mirea-media.json';
const within=(parent,child)=>{const r=relative(parent,child);return r===''||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r)&&!r.includes(':');};
export function storagePaths(dataDir,mediaDir){
 if(typeof dataDir!=='string'||!dataDir.trim()||mediaDir!==undefined&&(typeof mediaDir!=='string'||!mediaDir.trim()))throw Error('DATA_DIR / MEDIA_DIR must not be empty');
 const data=resolve(dataDir),chosen=resolve(mediaDir??data),media=relative(data,chosen)===''?data:chosen;
 if(data!==media&&(within(data,media)||within(media,data)))throw Error('DATA_DIR and MEDIA_DIR must be disjoint (or identical for legacy storage)');
 return {dataDir:data,mediaDir:media,separate:data!==media,uploadDir:join(media,'uploads'),stagingDir:join(media,'uploads','staging'),booksDir:join(media,'uploads','books'),videoDir:join(media,'videos'),originalDir:join(media,'originals'),thumbnailDir:join(data,'thumbnails'),previewDir:join(data,'previews')};
}
export async function readLayout(file){
 try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1024)throw Error('Unsafe storage identity');const value=JSON.parse(await readFile(file,'utf8'));if(value.version!==1||!/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(value.id)||!['combined','separate'].includes(value.mode))throw Error('Invalid storage identity');return value;}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export async function saveLayout(file,value,{replace=false}={}){
 const temporary=file+'.'+randomUUID()+'.tmp';
 try{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}if(replace)await rename(temporary,file);else await link(temporary,file);if(process.platform!=='win32'){const parent=await open(resolve(file,'..'),'r');try{await parent.sync();}finally{await parent.close();}}}finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function initializeStorage(paths){
 const {dataDir,mediaDir,separate}=paths;
 await mkdir(dataDir,{recursive:true,mode:0o700});
 if(separate){
  // An explicit media mount MUST already exist. Never create its root: a
  // missing dataset must not silently become empty local/container storage.
  const info=await lstat(mediaDir);if(!info.isDirectory()||info.isSymbolicLink())throw Error('MEDIA_DIR must be an existing mounted directory, not a link');
  if((await lstat(dataDir)).isSymbolicLink())throw Error('Separate storage roots must not be links');
  const actual=storagePaths(await realpath(dataDir),await realpath(mediaDir));if(!actual.separate)throw Error('Storage roots alias the same directory');
 }
 const statePath=join(dataDir,LAYOUT_FILE),state=await readLayout(statePath),mode=separate?'separate':'combined';
 if(state){
  if(state.mode!==mode)throw Error('Storage mode changed: stop Mirea and use prepare-media-storage.mjs before changing MEDIA_DIR');
  if(separate){const media=await readLayout(join(mediaDir,MEDIA_MARKER));if(media?.id!==state.id||media.mode!=='separate')throw Error('MEDIA_DIR identity mismatch or missing mount; restore the correct media dataset');}
 }else if(separate){
  const database=await lstat(join(dataDir,'mirea.sqlite')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(database)throw Error('Existing database requires offline media migration before enabling MEDIA_DIR');
  if((await readdir(mediaDir)).length)throw Error('Fresh MEDIA_DIR must be empty; use offline media migration for existing data');
  const layout={version:1,id:randomUUID(),mode};await saveLayout(join(mediaDir,MEDIA_MARKER),layout);await saveLayout(statePath,layout);
 }else await saveLayout(statePath,{version:1,id:randomUUID(),mode});
 await Promise.all([paths.uploadDir,paths.stagingDir,paths.booksDir,paths.thumbnailDir,paths.videoDir,paths.originalDir,paths.previewDir].map(p=>mkdir(p,{recursive:true,mode:0o700})));
}
