// Preview decisions apply to this selection only. Existing assets and originals
// are never modified, replaced, or assumed identical just because names match.
export function applyUploadReview(jobs,rows,decisions=new Map()){
  const byKey=new Map(rows.map(row=>[row.key,row])),selected=[],skipped=[],removed=[];
  for(const job of jobs){const row=byKey.get(job.key);if(!row)throw Error('追加内容をもう一度確認してください。');
    const action=decisions.get(job.key)??(row.conflict?'skip':'add');
    if(action==='skip'){skipped.push(job);continue;}
    if(action==='remove'){removed.push(job);continue;}
    if(action==='rename'){if(!row.suggestedTitle)throw Error('追加先の同名シリーズを整理するか、この候補を除外してください。');selected.push({...job,title:row.suggestedTitle,titleEdited:true});continue;}
    if(row.conflict||action!=='add')throw Error('同名候補の扱いを確認してください。');selected.push(job);
  }
  return {selected,skipped,removed};
}
export function uploadReviewRequest(jobs,requested,{folderMode=false,seriesRows=[]}={}){
  let seriesId=requested.choice||null,prefix='';
  if(seriesId==='new'){
    if(!requested.title)throw Error('新しいシリーズ名を入力してください。');
    if(seriesRows.some(row=>(row.parentId||null)===(requested.parentId||null)&&row.title.trim().normalize('NFC')===requested.title.normalize('NFC')))throw Error('同じ階層に同じ名前のシリーズがあります。既存のシリーズを選ぶか、別の名前を指定してください。');
    seriesId=requested.parentId||null;prefix=requested.title;
  }
  return {assets:jobs.map(job=>({key:job.key,title:job.title.trim(),shelfId:requested.shelf,seriesId,...(prefix?{newSeriesTitle:prefix}:{}),...(folderMode?{folderPath:job.folderPath}:{})}))};
}
