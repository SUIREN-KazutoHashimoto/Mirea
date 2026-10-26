import {MAX_UPLOAD_FILES} from './upload-batch.js';
const fileOrder=new Intl.Collator('ja',{numeric:true});
// Relative paths are labels only; none are sent as filesystem destinations.
export function folderParts(path){
  if(typeof path!=='string'||path.length>4096||path.includes('\\'))throw Error('フォルダのパスが不正です。');
  const parts=path.split('/');if(parts.length<2||parts.length>17||parts.some(p=>!p.trim()||p==='.'||p==='..'||p.length>200||/[\u0000-\u001f\u007f]/.test(p)))throw Error('フォルダは16階層まで、名前は200文字以内にしてください。');
  return parts;
}
export function folderUploadJobs(files,plan){
  if(files.length>MAX_UPLOAD_FILES)throw Error('フォルダの一括アップロードは1000ファイルまでです。');
  const jobs=[],paths=new Set();
  for(const [index,file] of Array.from(files).entries()){
    const path=file.relativePath||file.webkitRelativePath,parts=folderParts(path);
    if(parts.at(-1)!==file.name||paths.has(path))throw Error('重複または不正なファイルパスです。');paths.add(path);
    const [job]=plan([file]);jobs.push({...job,key:'folder-'+index,folderPath:parts.slice(0,-1).join('/'),relativePath:path});
  }
  folderPaths(jobs);return jobs.sort((a,b)=>fileOrder.compare(a.relativePath,b.relativePath));
}
export function folderPaths(jobs){
  const paths=new Set();for(const job of jobs){const parts=folderParts(job.relativePath);for(let n=1;n<parts.length;n++)paths.add(parts.slice(0,n).join('/'));}
  if(paths.size>300)throw Error('一度に作成できるフォルダは300件までです。');return [...paths].sort((a,b)=>a.split('/').length-b.split('/').length||fileOrder.compare(a,b));
}
export async function prepareFolderSeries(jobs,{api,shelfId,parentId=null,records=new Map(),isCurrent=()=>true,onProgress=()=>{}}){
  const paths=folderPaths(jobs);let done=0;onProgress({done,total:paths.length});
  for(const path of paths){
    if(!isCurrent())throw new DOMException('ログイン先が変更されました。','AbortError');
    let row=records.get(path);if(row?.id){onProgress({done:++done,total:paths.length,path});continue;}if(!row){row={requestId:crypto.randomUUID()};records.set(path,row);}
    const parts=path.split('/'),parent=parts.length===1?parentId:records.get(parts.slice(0,-1).join('/'))?.id;
    if(parts.length>1&&!parent)throw Error('親シリーズを作成できません。');
    const response=await api(`/shelves/${shelfId}/series`,{method:'POST',body:{title:parts.at(-1),parentId:parent,requestId:row.requestId,reuseExisting:true}});
    row.id=response.series.id;row.created=response.created!==false;onProgress({done:++done,total:paths.length});
  }
  return new Map(jobs.map(j=>[j.key,records.get(j.folderPath).id]));
}
