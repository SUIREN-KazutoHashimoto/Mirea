// Relative paths are labels only; none are sent as filesystem destinations.
export function folderParts(path){
  if(typeof path!=='string'||path.length>4096||path.includes('\\'))throw Error('フォルダのパスが不正です。');
  const parts=path.split('/');if(parts.length<2||parts.length>17||parts.some(p=>!p.trim()||p==='.'||p==='..'||p.length>200||/[\u0000-\u001f\u007f]/.test(p)))throw Error('フォルダは16階層まで、名前は200文字以内にしてください。');
  return parts;
}
export function folderUploadJobs(files,plan){
  if(files.length>10000)throw Error('フォルダの一括アップロードは10000ファイルまでです。');
  const jobs=[],paths=new Set();
  for(const [index,file] of Array.from(files).entries()){
    const path=file.relativePath||file.webkitRelativePath,parts=folderParts(path);
    if(parts.at(-1)!==file.name||paths.has(path))throw Error('重複または不正なファイルパスです。');paths.add(path);
    const [job]=plan([file]);jobs.push({...job,key:'folder-'+index,folderPath:parts.slice(0,-1).join('/'),relativePath:path});
  }
  folderPaths(jobs);return jobs.sort((a,b)=>a.relativePath.localeCompare(b.relativePath,'ja',{numeric:true}));
}
export function folderPaths(jobs){
  const paths=new Set();for(const job of jobs){const parts=folderParts(job.relativePath);for(let n=1;n<parts.length;n++)paths.add(parts.slice(0,n).join('/'));}
  if(paths.size>300)throw Error('一度に作成できるフォルダは300件までです。');return [...paths].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b,'ja',{numeric:true}));
}
export async function prepareFolderSeries(jobs,{api,shelfId,parentId=null,records=new Map(),isCurrent=()=>true}){
  for(const path of folderPaths(jobs)){
    if(!isCurrent())throw new DOMException('ログイン先が変更されました。','AbortError');
    let row=records.get(path);if(row?.id)continue;if(!row){row={requestId:crypto.randomUUID()};records.set(path,row);}
    const parts=path.split('/'),parent=parts.length===1?parentId:records.get(parts.slice(0,-1).join('/'))?.id;
    if(parts.length>1&&!parent)throw Error('親シリーズを作成できません。');
    const response=await api(`/shelves/${shelfId}/series`,{method:'POST',body:{title:parts.at(-1),parentId:parent,requestId:row.requestId,reuseExisting:true}});
    row.id=response.series.id;row.created=response.created!==false;
  }
  return new Map(jobs.map(j=>[j.key,records.get(j.folderPath).id]));
}
