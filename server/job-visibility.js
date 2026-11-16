export function jobAccessContext(db,req,requireUnlock){
 const unlockedShelfIds=[];
 for(const row of db.prepare('SELECT s.id FROM shelves s JOIN memberships m ON m.shelf_id=s.id WHERE m.user_id=? AND s.private=1').all(req.user.id)){
  try{requireUnlock(req,row.id);unlockedShelfIds.push(row.id);}catch(error){if(error.statusCode!==423)throw error;}
 }
 return {userId:req.user.id,unlockedShelfIds};
}
export function jobOwnership(db,userId,assetId,uploadId){
 return db.prepare(`SELECT m.user_id IS NOT NULL AND (m.role='owner' OR COALESCE(i.uploaded_by,u.user_id)=?) owned,
 COALESCE(s.private,0) private,s.id shelfId FROM (SELECT 1) seed
 LEFT JOIN items i ON i.id=? LEFT JOIN upload_sessions u ON u.id=?
 LEFT JOIN shelves s ON s.id=COALESCE(i.shelf_id,u.shelf_id)
 LEFT JOIN memberships m ON m.shelf_id=s.id AND m.user_id=?`).get(userId,assetId??null,uploadId??null,userId);
}
export function redactJob(row,access){
 if(access?.reveal)return {...row,title:access.title??row.title,shelf:access.shelf??row.shelf,redacted:false};
 // Older workers may put source names or paths in arbitrary error/progress
 // strings. Only numeric progress is safe to relay for someone else's asset.
 const numeric=value=>Number.isFinite(value)?value:undefined;
 return {...row,title:!row.assetId&&row.source!=='upload'?null:access?.owned?'プライベート本棚のアセット':'他の利用者のアセット',shelf:null,redacted:true,
  progress:{percent:numeric(row.progress?.percent)},processing:row.processing?{percent:numeric(row.processing.percent)}:undefined,
  error:row.error?'処理が完了していません。詳細は所有者が確認できます。':null};
}
export function publicAiJob(row,now=Date.now()){
 return {id:row.id,source:'ai',assetId:row.asset_id,feature:row.feature,kind:'ai_'+row.feature,state:row.state,
  checkpoint:row.checkpoint,totalUnits:row.total_units,errorCode:row.error_code,
  progress:{percent:row.total_units?Math.min(100,Math.round(row.checkpoint/row.total_units*100)):row.state==='complete'?100:undefined},
  createdAt:row.created_at,startedAt:row.started_at,updatedAt:row.updated_at,finishedAt:row.finished_at,
  elapsedMs:row.started_at?Math.max(0,(row.finished_at??now)-row.started_at):0,
  estimatedAt:row.state==='running'&&row.checkpoint>0&&row.total_units>row.checkpoint?now+Math.max(0,row.updated_at-row.started_at)*(row.total_units-row.checkpoint)/row.checkpoint:null};
}
