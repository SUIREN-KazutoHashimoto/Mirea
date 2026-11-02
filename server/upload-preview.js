import {canonicalName} from './name-rules.js';
import {httpError} from './security.js';

const uuid={type:'string',format:'uuid'},nullableId={anyOf:[uuid,{type:'null'}]};
const location=(shelf,parent=null)=>JSON.stringify([shelf,parent]);
function folderParts(path){
 if(!path)return [];
 if(/^[\\/]|^[a-z]:/i.test(path)||/[\u0000-\u001f]/.test(path))throw httpError(422,'フォルダの相対パスを確認してください。');
 const parts=path.replaceAll('\\','/').split('/').map(canonicalName);
 if(parts.length>16||parts.some(part=>!part||part==='.'||part==='..'||part.length>200))throw httpError(422,'フォルダは16階層以内、各名前は200文字以内にしてください。');
 return parts;
}

// Advisory only: no series, sessions or files are created. The upload admission
// transaction remains authoritative if another device changes the destination.
export function previewUploadNames(db,assets,now=Date.now()){
 const shelfIds=[...new Set(assets.map(asset=>asset.shelfId))],ids=JSON.stringify(shelfIds),series=db.prepare('SELECT id,shelf_id,parent_id,title FROM series WHERE shelf_id IN (SELECT value FROM json_each(?))').all(ids),byId=new Map(series.map(row=>[row.id,row])),children=new Map();
 for(const row of series){const key=location(row.shelf_id,row.parent_id);if(!children.has(key))children.set(key,new Map());const names=children.get(key),title=canonicalName(row.title);if(!names.has(title))names.set(title,[]);names.get(title).push(row);}
 const names=new Map(),at=key=>{if(!names.has(key))names.set(key,{asset:new Set(),upload:new Set(),reserved:new Set(),selected:new Set(),suffix:new Map()});return names.get(key);};
 for(const row of db.prepare('SELECT i.shelf_id,i.title,si.series_id FROM items i LEFT JOIN series_items si ON si.asset_id=i.id WHERE i.shelf_id IN (SELECT value FROM json_each(?))').all(ids))at(location(row.shelf_id,row.series_id)).asset.add(canonicalName(row.title));
 for(const row of db.prepare("SELECT u.shelf_id,u.title,u.target_series_id FROM upload_sessions u WHERE u.shelf_id IN (SELECT value FROM json_each(?)) AND (u.state IN ('processing','failed') OR u.state='uploading' AND u.expires_at>?) AND NOT EXISTS(SELECT 1 FROM items i WHERE i.id=u.id)").all(ids,now)){const target=byId.get(row.target_series_id);at(location(row.shelf_id,target?.shelf_id===row.shelf_id?target.id:null)).upload.add(canonicalName(row.title));}
 for(const row of db.prepare('SELECT shelf_id,title,series_id FROM upload_queue WHERE shelf_id IN (SELECT value FROM json_each(?)) AND upload_id IS NULL AND expires_at>?').all(ids,now))at(location(row.shelf_id,row.series_id)).upload.add(canonicalName(row.title));
 const keys=new Set(),resolved=assets.map(asset=>{
  if(keys.has(asset.key))throw httpError(422,'アップロード候補の識別子が重複しています。');keys.add(asset.key);
  const title=canonicalName(asset.title);if(!title)throw httpError(422,'タイトルを入力してください。');
  let parent=asset.seriesId??null,depth=0,next=parent;
  while(next){const row=byId.get(next);if(!row||row.shelf_id!==asset.shelfId)throw httpError(422,'追加先は同じ本棚のシリーズを選んでください。');if(++depth>16)throw httpError(422,'追加先シリーズの階層を確認してください。');next=row.parent_id;}
  const parts=folderParts(asset.folderPath??'');
  if(asset.newSeriesTitle!==undefined){const newTitle=canonicalName(asset.newSeriesTitle);if(!newTitle)throw httpError(422,'新しいシリーズ名を入力してください。');if(children.get(location(asset.shelfId,parent))?.has(newTitle))throw httpError(409,'同名の追加先シリーズがあります。既存のシリーズを選んでください。');parts.unshift(newTitle);}
  if(depth+parts.length>16)throw httpError(422,'シリーズの入れ子は16階層までです。');
  for(let n=0;n<parts.length;n++){
   const matches=children.get(location(asset.shelfId,parent))?.get(parts[n])??[];
   if(matches.length>1)return {...asset,title,namespace:null};
   if(!matches.length)return {...asset,title,namespace:JSON.stringify([asset.shelfId,parent,parts.slice(n)])};
   parent=matches[0].id;
  }
  return {...asset,title,namespace:location(asset.shelfId,parent)};
 });
 // Reserve all candidate names first so a suggested suffix cannot steal a name
 // from a later (otherwise conflict-free) candidate in the same selection.
 for(const row of resolved)if(row.namespace!==null)at(row.namespace).reserved.add(row.title);
 const results=resolved.map(row=>{
  if(row.namespace===null)return {key:row.key,conflict:true,reason:'ambiguous-series',suggestedTitle:null};
  const used=at(row.namespace),reason=used.asset.has(row.title)?'asset':used.upload.has(row.title)?'upload':used.selected.has(row.title)?'selection':null;used.selected.add(row.title);
  if(!reason)return {key:row.key,conflict:false,reason:null,suggestedTitle:row.title};
  let suffix=used.suffix.get(row.title)??2,suggestedTitle;
  do{const tail=' ('+(suffix++)+')';let base=row.title.slice(0,200-tail.length);if(/[\uD800-\uDBFF]$/.test(base))base=base.slice(0,-1);suggestedTitle=base+tail;}while(used.asset.has(suggestedTitle)||used.upload.has(suggestedTitle)||used.reserved.has(suggestedTitle));
  used.suffix.set(row.title,suffix);used.reserved.add(suggestedTitle);return {key:row.key,conflict:true,reason,suggestedTitle};
 });
 return {assets:results,counts:{total:results.length,conflicts:results.filter(row=>row.conflict).length}};
}

export function registerUploadPreview(app,{db,authenticate,membership}){
 app.post('/api/v1/transfers/upload-preview',{onRequest:async req=>authenticate(req),bodyLimit:16*1024*1024,schema:{body:{type:'object',additionalProperties:false,required:['assets'],properties:{assets:{type:'array',minItems:1,maxItems:1000,items:{type:'object',additionalProperties:false,required:['key','title','shelfId'],properties:{key:{type:'string',minLength:1,maxLength:200},title:{type:'string',minLength:1,maxLength:200},shelfId:uuid,seriesId:nullableId,folderPath:{type:'string',maxLength:4096},newSeriesTitle:{type:'string',minLength:1,maxLength:200}}}}}}}},async req=>{
  for(const id of new Set(req.body.assets.map(asset=>asset.shelfId)))membership(id,req.user.id,['owner','editor']);
  return previewUploadNames(db,req.body.assets);
 });
}
