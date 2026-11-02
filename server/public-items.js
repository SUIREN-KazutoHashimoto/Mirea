import {customThumbnailRevision} from './custom-thumbnails.js';
import {processingStateFromRows} from './media-recovery.js';

// Only serialize rows already selected by a route's membership checks. Batch
// metadata reads stay inside that selected set and do not cache across users.
export function createPublicItemSerializer(db,base){
 const selected=' IN (SELECT value FROM json_each(?))';
 const queries={
  covers:db.prepare('SELECT asset_id,image_id,updated_at FROM thumbnail_overrides WHERE asset_id'+selected),
  video:db.prepare('SELECT asset_id,updated_at FROM video_thumbnail_state WHERE asset_id'+selected),
  generated:db.prepare("SELECT asset_id,MAX(updated_at) updated_at FROM admin_jobs WHERE kind IN ('thumbnail','owner_thumbnail','repair') AND state='complete' AND asset_id"+selected+' GROUP BY asset_id'),
  sources:db.prepare('SELECT asset_id,canonical_ready,source_mime,metadata_json FROM media_ingest WHERE asset_id'+selected),
  tasks:db.prepare('SELECT asset_id,kind,state FROM media_tasks WHERE asset_id'+selected+' ORDER BY asset_id,kind'),
  active:db.prepare("SELECT asset_id,state FROM admin_jobs WHERE kind IN ('transcode','repair') AND state IN ('queued','running') AND asset_id"+selected)
 };
 function batch(items){
  if(!items.length)return [];
  const ids=JSON.stringify(items.map(item=>item.id)),one=name=>new Map(queries[name].all(ids).map(row=>[row.asset_id,row])),many=name=>{const map=new Map();for(const {asset_id,...row}of queries[name].all(ids)){if(!map.has(asset_id))map.set(asset_id,[]);map.get(asset_id).push(row);}return map;};
  const covers=one('covers'),video=one('video'),generated=one('generated'),sources=one('sources'),tasks=many('tasks'),active=many('active');
  return items.map(item=>{
   const stamp=Math.max(video.get(item.id)?.updated_at??0,generated.get(item.id)?.updated_at??0),cover=covers.get(item.id),revision=cover?customThumbnailRevision(cover):stamp?customThumbnailRevision({image_id:item.id,updated_at:stamp}):null,source=sources.get(item.id),processingTasks=tasks.get(item.id)??[];
   return {...base(item),...(source?{...(!source.canonical_ready?{mimeType:source.source_mime}:{}),processingState:processingStateFromRows(source.canonical_ready,processingTasks,active.get(item.id)),originalPlayback:!source.canonical_ready,downloadReady:Boolean(source.canonical_ready),mediaInfo:JSON.parse(source.metadata_json),processingTasks}:{}),...(revision?{thumbnailUrl:'/api/v1/items/'+item.id+'/thumbnail?revision='+revision}:{})};
  });
 }
 const serialize=item=>batch([item])[0];serialize.batch=batch;return serialize;
}
