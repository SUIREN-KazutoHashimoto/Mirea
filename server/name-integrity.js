import {canonicalName,nameKey,duplicateNameGroups,libraryNameConflicts} from './name-rules.js';
import {httpError} from './security.js';
import {transaction} from './database.js';

export function uploadSeriesDestination(db,upload){
  const row=db.prepare('SELECT target_series_id,series_requested FROM upload_sessions WHERE id=?').get(upload.id)??upload;
  if(!row.series_requested&&!row.target_series_id)return {seriesId:null,warning:''};
  const series=db.prepare('SELECT id,shelf_id FROM series WHERE id=?').get(row.target_series_id);
  if(!series||series.shelf_id!==upload.shelf_id)return {seriesId:null,warning:'追加先のシリーズが変更・削除されたため、単独のアセットとして保存しました。'};
  if(db.prepare('SELECT COUNT(*) n FROM series_items WHERE series_id=?').get(series.id).n>=1000)return {seriesId:null,warning:'シリーズの上限に達したため、単独のアセットとして保存しました。'};
  return {seriesId:series.id,warning:''};
}
export function assertSeriesChanges(db,shelfId,changes){
  const rows=db.prepare('SELECT id,title,shelf_id shelfId,parent_id parentId FROM series WHERE shelf_id=?').all(shelfId),before=new Map(duplicateNameGroups(rows).map(group=>[nameKey(shelfId,group[0].parentId,group[0].title),new Set(group.map(row=>row.id))])),after=new Map(rows.map(row=>[row.id,{...row}]));
  for(const change of changes){if(change.remove)after.delete(change.id);else after.set(change.id,{...after.get(change.id),...change,shelfId});}
  for(const group of duplicateNameGroups([...after.values()])){const old=before.get(nameKey(shelfId,group[0].parentId,group[0].title));if(!old||group.some(row=>!old.has(row.id)))throw httpError(409,'同じ階層に同じ名前のシリーズがあります。');}
}
export function shelfAssetNames(db,shelfId){return db.prepare('SELECT i.id,i.title,i.shelf_id shelfId,si.series_id parentId FROM items i LEFT JOIN series_items si ON si.asset_id=i.id WHERE i.shelf_id=?').all(shelfId);}
// Validate the final transaction state, not temporary detaches during reordering.
// Old duplicates may be reduced, never enlarged or silently renamed/merged.
export function assertAssetChanges(db,shelfId,changes,{uploadId,checkPending=true}={}){
  const before=shelfAssetNames(db,shelfId),byId=new Map(before.map(row=>[row.id,{...row}]));
  for(const change of changes){if(change.remove)byId.delete(change.id);else byId.set(change.id,{...byId.get(change.id),...change,shelfId});}
  const after=[...byId.values()],oldGroups=new Map(duplicateNameGroups(before).map(group=>[nameKey(shelfId,group[0].parentId,group[0].title),new Set(group.map(row=>row.id))]));
  for(const group of duplicateNameGroups(after)){const old=oldGroups.get(nameKey(shelfId,group[0].parentId,group[0].title));if(!old||group.some(row=>!old.has(row.id)))throw httpError(409,'同じ階層に同じタイトルのアセットがあります。タイトルまたは追加先を変更してください。');}
  if(!checkPending)return;
  const previous=new Map(before.map(row=>[row.id,row]));
  const changed=after.filter(row=>!previous.has(row.id)||nameKey(shelfId,row.parentId,row.title)!==nameKey(shelfId,previous.get(row.id).parentId,previous.get(row.id).title));
  if(!changed.length)return;
  const pending=db.prepare("SELECT u.* FROM upload_sessions u WHERE u.shelf_id=? AND u.id!=? AND (u.state IN ('processing','failed') OR u.state='uploading' AND u.expires_at>?) AND NOT EXISTS(SELECT 1 FROM items i WHERE i.id=u.id)").all(shelfId,uploadId??'',Date.now());
  const reserved=new Set(pending.map(row=>nameKey(shelfId,uploadSeriesDestination(db,row).seriesId,row.title)));
  if(changed.some(row=>reserved.has(nameKey(shelfId,row.parentId,row.title))))throw httpError(409,'同じ階層・タイトルのアップロードが処理中または再試行待ちです。完了・整理してから追加してください。');
}
export function assertUploadName(db,upload){const destination=uploadSeriesDestination(db,upload);assertAssetChanges(db,upload.shelf_id,[{id:upload.id,title:upload.title,parentId:destination.seriesId}],{uploadId:upload.id});return destination;}

export function registerNameIntegrity(app,{db,authenticate,membership,findItem,publicItem}){
  const auth={onRequest:async req=>authenticate(req)};
  app.get('/api/v1/library/integrity',auth,async req=>{
    const shelves=db.prepare("SELECT s.id,s.name,m.role FROM shelves s JOIN memberships m ON m.shelf_id=s.id WHERE m.user_id=? AND m.role IN ('owner','editor')").all(req.user.id);
    const ids=JSON.stringify(shelves.map(s=>s.id));
    const series=db.prepare('SELECT id,shelf_id shelfId,parent_id parentId,title FROM series WHERE shelf_id IN (SELECT value FROM json_each(?))').all(ids);
    const items=db.prepare('SELECT i.id,i.shelf_id shelfId,i.title,si.series_id parentId FROM items i LEFT JOIN series_items si ON si.asset_id=i.id WHERE i.shelf_id IN (SELECT value FROM json_each(?))').all(ids);
    const conflicts=libraryNameConflicts({shelves,series,items});return {groups:conflicts.slice(0,200),total:conflicts.length};
  });
  app.patch('/api/v1/items/:id',{...auth,bodyLimit:4096,schema:{body:{type:'object',additionalProperties:false,required:['title','expectedTitle'],properties:{title:{type:'string',minLength:1,maxLength:200},expectedTitle:{type:'string',maxLength:200}}}}},async req=>transaction(db,()=>{
    const item=findItem(req.params.id,req.user.id,['owner','editor']);membership(item.shelf_id,req.user.id,['owner','editor']);
    if(item.title!==req.body.expectedTitle)throw httpError(409,'タイトルが更新されています。最新の内容を確認してください。');
    const title=canonicalName(req.body.title);if(!title)throw httpError(422,'タイトルを入力してください。');
    assertAssetChanges(db,item.shelf_id,[{id:item.id,title}]);db.prepare('UPDATE items SET title=? WHERE id=?').run(title,item.id);
    return {item:publicItem(db.prepare('SELECT * FROM items WHERE id=?').get(item.id))};
  }));
}
