// Persistent, privacy-aware index across all execution queues.
const rowsSql=`WITH identity(user_id,unlocked) AS (VALUES(?,?)), work AS (
 SELECT 'admin' source,j.id,j.asset_id,i.title,s.name shelf,i.shelf_id,i.uploaded_by,s.private,j.kind,j.state,j.state filter_state,j.created_at,j.updated_at
 FROM admin_jobs j LEFT JOIN items i ON i.id=j.asset_id LEFT JOIN shelves s ON s.id=i.shelf_id
 UNION ALL
 SELECT 'media',j.id,j.asset_id,i.title,s.name,i.shelf_id,i.uploaded_by,s.private,j.kind,j.state,j.state,j.created_at,j.updated_at
 FROM media_tasks j LEFT JOIN items i ON i.id=j.asset_id LEFT JOIN shelves s ON s.id=i.shelf_id
 UNION ALL
 SELECT 'upload',u.id,u.id,u.title,s.name,u.shelf_id,u.user_id,s.private,'upload',u.state,
 CASE WHEN u.state='uploading' THEN 'running' WHEN u.state='processing' THEN CASE WHEN COALESCE(json_extract(u.processing_json,'$.stage'),'queued')='queued' THEN 'queued' ELSE 'running' END ELSE u.state END,u.created_at,COALESCE(t.finished_at,t.started_at,u.created_at)
 FROM upload_sessions u LEFT JOIN shelves s ON s.id=u.shelf_id LEFT JOIN job_timings t ON t.id=u.id AND t.scope='upload'
 WHERE (u.state!='uploading' OR u.expires_at>?) AND (u.state!='processing' OR NOT EXISTS(SELECT 1 FROM media_ingest m WHERE m.asset_id=u.id))
 UNION ALL
 SELECT 'ai',j.id,j.asset_id,i.title,s.name,i.shelf_id,i.uploaded_by,s.private,'ai_'||j.feature,j.state,
 CASE WHEN j.state IN ('resource-wait','dependency-wait') THEN 'queued' WHEN j.state='partial' THEN 'failed' ELSE j.state END,j.created_at,j.updated_at
 FROM ai_jobs j JOIN items i ON i.id=j.asset_id JOIN shelves s ON s.id=i.shelf_id
), access AS (
 SELECT w.*,m.user_id IS NOT NULL AND (m.role='owner' OR w.uploaded_by=identity.user_id) owned,
 COALESCE(w.private,0)=0 OR w.shelf_id IN (SELECT value FROM json_each(identity.unlocked)) unlocked
 FROM work w CROSS JOIN identity LEFT JOIN memberships m ON m.shelf_id=w.shelf_id AND m.user_id=identity.user_id
), visible AS (
 SELECT source,id,asset_id,shelf_id,kind,state,filter_state,created_at,updated_at,owned,owned AND unlocked reveal,
 CASE WHEN owned AND unlocked THEN COALESCE(title,'') ELSE '' END title,
 CASE WHEN owned AND unlocked THEN COALESCE(shelf,'') ELSE '' END shelf FROM access
)`;
const kindLabel=`CASE kind WHEN 'thumbnail' THEN '表紙' WHEN 'owner_thumbnail' THEN '表紙（所有者）' WHEN 'preview' THEN '動画プレビュー' WHEN 'transcode' THEN 'トランスコード' WHEN 'repair' THEN '未完了の修復' WHEN 'navigation' THEN 'チャプター・字幕' WHEN 'upload' THEN 'アップロード' WHEN 'backup_metadata' THEN 'メタデータバックアップ' WHEN 'backup_full' THEN '全体バックアップ' WHEN 'ai_tags' THEN 'AI タグ付け' WHEN 'ai_ocr' THEN 'AI 本文・セリフ' WHEN 'ai_transcript' THEN 'AI 文字起こし' WHEN 'ai_structure' THEN 'AI 曲の構成' WHEN 'ai_chapters' THEN 'AI 動画の章' WHEN 'ai_embedding' THEN 'AI 意味検索の索引' ELSE kind END`;
export const JOB_FAMILY_IDS=['thumbnail','preview','transcode','ai','transfer','repair','other'];
const familyKind=`CASE
  WHEN kind IN ('thumbnail','owner_thumbnail') THEN 'thumbnail'
  WHEN kind='preview' THEN 'preview' WHEN kind='transcode' THEN 'transcode'
  WHEN source='ai' THEN 'ai' WHEN source='upload' THEN 'transfer'
  WHEN kind='repair' THEN 'repair' ELSE 'other' END`;
export function adminJobPage(db,{view='current',state='all',family='all',q='',sort='newest',offset=0,limit=100,userId='',unlockedShelfIds=[],ownedOnly=false,shelfId}={},now=Date.now()){
 const active=view==='history'?"filter_state IN ('complete','failed','cancelled')":"filter_state IN ('queued','running','paused')";
 const scope=`(?=0 OR owned=1 AND reveal=1) AND (? IS NULL OR shelf_id=?)`,base=[userId,JSON.stringify(unlockedShelfIds),now],scopeArgs=[Number(ownedOnly),shelfId??null,shelfId??null];
 const filter=`${scope} AND ${active} AND (?='all' OR filter_state=?) AND (?='all' OR ${familyKind}=?) AND instr(lower(title||' '||shelf||' '||kind||' '||${kindLabel}||' '||id||' '||COALESCE(asset_id,'')),lower(?))>0`,args=[...base,...scopeArgs,state,state,family,family,q.trim()];
 const total=db.prepare(rowsSql+' SELECT COUNT(*) n FROM visible WHERE '+filter).get(...args).n;
 const start=total?Math.min(offset,Math.floor((total-1)/limit)*limit):0;
 const order=sort==='oldest'?'created_at,id,source':sort==='state'?"CASE filter_state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,created_at DESC,id,source":'created_at DESC,id,source';
 const rows=db.prepare(rowsSql+' SELECT source,id,filter_state,owned,reveal,title,shelf FROM visible WHERE '+filter+' ORDER BY '+order+' LIMIT ? OFFSET ?').all(...args,limit,start);
 // Use the same permissions and state normalization as the unfiltered summary,
 // never page-local counts. Do not persist or count transient inspect wrappers.
 const families=ownedOnly?undefined:Object.fromEntries(JOB_FAMILY_IDS.map(key=>[key,{running:0,queued:0,paused:0,failed:0}]));
 if(families)for(const {family,...counts} of db.prepare(rowsSql+` SELECT ${familyKind} family,
   SUM(filter_state='running') running,SUM(filter_state='queued') queued,
   SUM(filter_state='paused') paused,SUM(filter_state='failed') failed
   FROM visible WHERE ${scope} AND filter_state IN ('running','queued','paused','failed') GROUP BY ${familyKind}`).all(...base,...scopeArgs)){
   families[family]=counts;
 }
 const summary=families?Object.values(families).reduce((total,counts)=>{
   for(const key of Object.keys(total))total[key]+=counts[key];
   return total;
 },{running:0,queued:0,paused:0,failed:0}):db.prepare(rowsSql+` SELECT COALESCE(SUM(filter_state='running'),0) running,COALESCE(SUM(filter_state='queued'),0) queued,COALESCE(SUM(filter_state='paused'),0) paused,COALESCE(SUM(filter_state='failed'),0) failed FROM visible WHERE ${scope}`).get(...base,...scopeArgs);
 return {rows,total,offset:start,limit,nextOffset:start+limit<total?start+limit:null,previousOffset:start?Math.max(0,start-limit):null,summary,...(families?{families}:{})};
}
