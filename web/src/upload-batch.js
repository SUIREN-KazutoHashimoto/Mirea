import {canonicalName} from '../../server/name-rules.js';
import {VIDEO_EXTENSIONS,VIDEO_TYPES} from '../../server/video-types.js';
import {AUDIO_EXTENSIONS,AUDIO_TYPES} from '../../server/audio-types.js';
export const MAX_UPLOAD_FILES=1000;
const fileOrder=new Intl.Collator('ja',{numeric:true,sensitivity:'base'});
const images=new Set(['image/jpeg','image/png','image/webp']);
const mimeByExtension={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',pdf:'application/pdf',epub:'application/epub+zip',...VIDEO_EXTENSIONS,...AUDIO_EXTENSIONS};
const supported=new Set([...Object.values(mimeByExtension),...VIDEO_TYPES,...AUDIO_TYPES]);
export const isUploadImage=file=>images.has(file.type);
const titleOf=file=>file.name.replace(/\.[^.]+$/,'').slice(0,200)||'無題';
export function planUploads(incoming) {
  incoming=Array.from(incoming);if(incoming.length>MAX_UPLOAD_FILES)throw Error('一度に選択できるファイルは1000件までです。');
  const files=incoming.map(file=>{
    const ext=file.name.split('.').pop().toLowerCase(),mime=ext==='webm'&&file.type==='audio/webm'?'audio/webm':mimeByExtension[ext]||file.type||'application/octet-stream';
    return file.nativeId?{...file,type:mime}:file.type===mime?file:new File([file],file.name,{type:mime,lastModified:file.lastModified});
  });
  const pages=files.filter(isUploadImage).sort((a,b)=>fileOrder.compare(a.name,b.name)),jobs=[];
  let book=false;
  for (const file of files) {
    if (isUploadImage(file)) { if(book)continue;book=true;jobs.push({key:'images',files:pages,title:titleOf(pages[0]),imageBook:true}); }
    else jobs.push({key:'file-'+jobs.length,files:[file],title:titleOf(file),imageBook:false});
  }
  return jobs;
}
export function validateUploadPlan(jobs,{maxUploadBytes,maxBookPages,maxImageBytes,maxEpubBytes=64*1024*1024,maxUploadAssets=1000}) {
  if(!jobs.length)return 'ファイルを選択してください。';
  if(jobs.reduce((n,job)=>n+job.files.length,0)>MAX_UPLOAD_FILES)return '一度に選択できるファイルは1000件までです。';
  if(jobs.length>Math.min(MAX_UPLOAD_FILES,maxUploadAssets))return `一度に選択できるアセットは${maxUploadAssets}件までです。`;
  const identities=new Set(),names=new Set();
  for(const job of jobs) {
    const name=JSON.stringify([job.folderPath??'',canonicalName(job.title)]);if(names.has(name))return '同じ階層に同じタイトルのアセットが選択されています。タイトルまたは追加先を変更してください。';names.add(name);
    const prefix=job.title||job.files[0]?.name||'アセット';
    if(!job.title.trim()||job.title.trim().length>200)return `${prefix}：タイトルを1〜200文字で入力してください。`;
    if(!job.files.length||job.files.some(f=>!supported.has(f.type)))return `${prefix}：対応していないファイル形式です。`;
    if(job.files.some(f=>f.name.length>255))return `${prefix}：ファイル名は255文字以内にしてください。`;
    if(job.files.some(f=>!Number.isSafeInteger(f.size)||f.size<=0))return `${prefix}：空のファイルは追加できません。`;
    if(job.files.length>1&&!job.files.every(isUploadImage))return `${prefix}：複数ファイルを1冊にできるのは画像だけです。`;
    if(job.files.length>maxBookPages)return `${prefix}：1冊は${maxBookPages}ページまでです。`;
    if(job.files.some(f=>isUploadImage(f)&&f.size>maxImageBytes))return `${prefix}：画像1枚のサイズ上限を超えています。`;
    if(job.files.some(f=>f.type==='application/epub+zip'&&f.size>maxEpubBytes))return `${prefix}：EPUBのサイズ上限を超えています。`;
    if(job.files.reduce((sum,f)=>sum+f.size,0)>maxUploadBytes)return `${prefix}：1アセットのサイズ上限を超えています。`;
    if(!job.imageBook){const f=job.files[0],key=JSON.stringify([job.relativePath??f.name,f.type,f.size,f.lastModified]);if(identities.has(key))return `${prefix}：同じ名前・サイズ・更新日時のファイルが重複しています。別々に追加してください。`;identities.add(key);}
  }
  return '';
}

// Transfer slots are released at server acceptance; completion is monitored separately.
// A failed file is not silently retried/re-created; completed jobs are never resent.
export function createUploadBatch(jobs,{start,concurrency=3,isCurrent=()=>true,changed=()=>{},eager=false,progressIntervalMs=0}) {
  const monitors=[];
  const rows=jobs.map(job=>({job,state:'queued',percent:0,processing:null,error:''})),active=new Map();
  let next=0,cancelled=false,halted=false;
  let emission;
  const emit=(force=false)=>{if(force||!progressIntervalMs){clearTimeout(emission);emission=null;changed(rows.map(row=>({...row})));}else if(!emission)emission=setTimeout(()=>{emission=null;changed(rows.map(row=>({...row})));},progressIntervalMs);};
  function cancel({detachProcessing=false}={}){if(cancelled)return;cancelled=true;for(const [row,task]of active){row.state=detachProcessing&&task.processing?'detached':'cancelled';try{detachProcessing&&task.processing?task.detach():task.abort();}catch{} }emit(true);}
  async function worker(){
    while(!cancelled&&!halted&&isCurrent()&&next<rows.length){
      const row=rows[next++];row.state='uploading';emit();
      if(!isCurrent())cancel();if(cancelled||halted){row.state='cancelled';emit();break;}
      let settled=false;
      try {
        const task=start(row.job,(percent,processing)=>{if(settled||cancelled)return;if(!isCurrent()){cancel();return;}row.percent=Math.max(0,Math.min(100,Number(percent)||0));row.processing=processing;row.state=row.percent===100?'processing':'uploading';emit();});
        active.set(row,task);if(cancelled||!isCurrent()){row.state='cancelled';try{task.abort();}catch{}}const monitoring=task.promise.then(result=>{row.warning=result?.seriesWarning??'';row.item=result?.item;if(!cancelled&&isCurrent()){row.state=result?.accepted?'processing':'complete';row.uploadId??=result?.uploadId;row.percent=100;if(!result?.accepted)row.processing=null;}emit();},error=>{if(!cancelled&&isCurrent()){row.state='failed';row.error=error.message;emit();}}).finally(()=>active.delete(row));monitors.push(monitoring);
        const accepted=await (task.transferred??task.promise);row.uploadId=accepted?.id;
        if(!cancelled&&isCurrent()&&task.transferred&&!['complete','failed'].includes(row.state)){row.state='processing';emit();}
      } catch(error) {
        if(!cancelled&&isCurrent()){row.state='failed';row.error=error.message||'アップロードに失敗しました。';if([401,403].includes(error.status))halted=true;}
      } finally {if(!isCurrent())cancel();emit();}
    }
  }
  const transferred=Promise.resolve().then(async()=>{emit();await Promise.all(Array.from({length:Math.min(eager?rows.length:32,Math.max(1,Math.floor(concurrency)||1),rows.length)},worker));if(!isCurrent())cancel();emit(true);return {rows:rows.map(row=>({...row})),cancelled,halted};});
  const promise=transferred.then(async()=>{await Promise.all(monitors);emit(true);return {rows:rows.map(row=>({...row})),cancelled,halted};});
  return {promise,transferred,cancel};
}
