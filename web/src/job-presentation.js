const active=new Set(['queued','running','processing','uploading']);
export function partitionJobs(rows){return {current:rows.filter(row=>!row.state||active.has(row.state)),history:rows.filter(row=>row.state&&!active.has(row.state))};}
export function jobStateClass(state){return state==='complete'?'job-complete':state==='failed'?'job-failed':state==='cancelled'?'job-cancelled':'job-active';}
export const JOB_STATES={queued:'待機中',running:'実行中',processing:'処理中',uploading:'受信中',complete:'完了',failed:'失敗',cancelled:'中止'};
export const JOB_KINDS={thumbnail:'表紙',preview:'動画プレビュー',transcode:'トランスコード',navigation:'チャプター・字幕',upload:'アップロード',processor:'メディア処理','validate-image':'画像検証',backup_metadata:'メタデータバックアップ',backup_full:'全体バックアップ'};
export function jobLabel(row){return row.title||JOB_KINDS[row.kind]||'メディア処理';}
export function jobKind(row){return row.upload?'アップロード':JOB_KINDS[row.kind]||'メディア処理';}
export function filterJobRows(rows,{query='',state='all',sort='newest'}={}){
  const q=query.trim().toLocaleLowerCase();
  return rows.filter(row=>(!q||[jobLabel(row),jobKind(row),row.id,row.assetId,row.shelf].filter(Boolean).join(' ').toLocaleLowerCase().includes(q))&&(state==='all'||state==='running'&&['running','processing','uploading',undefined].includes(row.state)||row.state===state)).slice().sort((a,b)=>{
    const date=row=>Number(row.createdAt??row.created_at)||0;
    if(sort==='oldest')return date(a)-date(b)||String(a._key??a.id).localeCompare(String(b._key??b.id));
    if(sort==='state'){const ranks={running:0,processing:0,uploading:0,queued:1,failed:2,cancelled:3,complete:4};const d=(ranks[a.state]??0)-(ranks[b.state]??0);if(d)return d;}
    return date(b)-date(a)||String(a._key??a.id).localeCompare(String(b._key??b.id));
  });
}
