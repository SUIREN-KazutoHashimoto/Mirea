// Page persistent work across every queue before applying the display limit.
// Account authorization remains on the admin route; no payloads or filenames
// are fetched by this index query.
const rowsSql=`WITH work AS (
 SELECT 'admin' source,j.id,j.asset_id,COALESCE(i.title,'') title,COALESCE(s.name,'') shelf,j.kind,j.state,j.state filter_state,j.created_at,j.updated_at
 FROM admin_jobs j LEFT JOIN items i ON i.id=j.asset_id LEFT JOIN shelves s ON s.id=i.shelf_id
 UNION ALL
 SELECT 'media',j.id,j.asset_id,COALESCE(i.title,''),COALESCE(s.name,''),j.kind,j.state,j.state,j.created_at,j.updated_at
 FROM media_tasks j LEFT JOIN items i ON i.id=j.asset_id LEFT JOIN shelves s ON s.id=i.shelf_id
 UNION ALL
 SELECT 'upload',u.id,u.id,u.title,COALESCE(s.name,''),'upload',u.state,
 CASE WHEN u.state='uploading' THEN 'running' WHEN u.state='processing' THEN CASE WHEN COALESCE(json_extract(u.processing_json,'$.stage'),'queued')='queued' THEN 'queued' ELSE 'running' END ELSE u.state END,u.created_at,COALESCE(t.finished_at,t.started_at,u.created_at)
 FROM upload_sessions u LEFT JOIN shelves s ON s.id=u.shelf_id LEFT JOIN job_timings t ON t.id=u.id AND t.scope='upload'
 WHERE (u.state!='uploading' OR u.expires_at>?) AND (u.state!='processing' OR NOT EXISTS(SELECT 1 FROM media_ingest m WHERE m.asset_id=u.id))
)`;
const kindLabel=`CASE kind WHEN 'thumbnail' THEN '表紙' WHEN 'owner_thumbnail' THEN '表紙（所有者）' WHEN 'preview' THEN '動画プレビュー' WHEN 'transcode' THEN 'トランスコード' WHEN 'repair' THEN '未完了の修復' WHEN 'navigation' THEN 'チャプター・字幕' WHEN 'upload' THEN 'アップロード' WHEN 'backup_metadata' THEN 'メタデータバックアップ' WHEN 'backup_full' THEN '全体バックアップ' ELSE kind END`;
export function adminJobPage(db,{view='current',state='all',q='',sort='newest',offset=0,limit=100}={},now=Date.now()){
 const active=view==='history'?"filter_state IN ('complete','failed','cancelled')":"filter_state IN ('queued','running')";
 const filter=`${active} AND (?='all' OR filter_state=?) AND instr(lower(title||' '||shelf||' '||kind||' '||${kindLabel}||' '||id||' '||COALESCE(asset_id,'')),lower(?))>0`,args=[now,state,state,q.trim()];
 const total=db.prepare(rowsSql+' SELECT COUNT(*) n FROM work WHERE '+filter).get(...args).n;
 const start=total?Math.min(offset,Math.floor((total-1)/limit)*limit):0;
 const order=sort==='oldest'?'created_at,id,source':sort==='state'?"CASE filter_state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 WHEN 'cancelled' THEN 3 ELSE 4 END,created_at DESC,id,source":'created_at DESC,id,source';
 const rows=db.prepare(rowsSql+' SELECT source,id,filter_state FROM work WHERE '+filter+' ORDER BY '+order+' LIMIT ? OFFSET ?').all(...args,limit,start);
 const summary=db.prepare(rowsSql+" SELECT COALESCE(SUM(filter_state='running'),0) running,COALESCE(SUM(filter_state='queued'),0) queued,COALESCE(SUM(filter_state='failed'),0) failed FROM work").get(now);
 return {rows,total,offset:start,limit,nextOffset:start+limit<total?start+limit:null,previousOffset:start?Math.max(0,start-limit):null,summary};
}
