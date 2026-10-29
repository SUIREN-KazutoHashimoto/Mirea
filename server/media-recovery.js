import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {PREVIEW_SPEC_VERSION} from './video-thumbnail.js';

export async function regularMedia(path,size){const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});return Boolean(info?.isFile()&&!info.isSymbolicLink()&&info.size>0&&(size===undefined||info.size===size));}
export function mediaProcessingState(db,id){
 const source=db.prepare('SELECT canonical_ready FROM media_ingest WHERE asset_id=?').get(id);if(!source)return null;
 const rows=db.prepare('SELECT kind,state FROM media_tasks WHERE asset_id=?').all(id),admin=db.prepare("SELECT state FROM admin_jobs WHERE asset_id=? AND kind IN ('transcode','repair') AND state IN ('queued','running')").all(id),conversion=rows.filter(row=>row.kind==='transcode');
 const relevant=source.canonical_ready?[]:[...conversion,...admin];return relevant.some(r=>r.state==='running')?'running':relevant.some(r=>r.state==='queued')?'queued':!source.canonical_ready?relevant.some(r=>r.state==='failed')?'failed':'incomplete':'ready';
}
// Inspect outputs belonging to current assets, not historical job rows. Large
// media payloads are not read during a candidate scan; repair validates outputs.
export async function assessAssetRecovery(context,asset,{ignoreJobId}={}){
 const {db,thumbnailDir,previewDir,uploadDir,videoDir}=context,id=asset.id,kinds=[],reasons=[];
 const busy=db.prepare("SELECT 1 FROM admin_jobs WHERE asset_id=? AND state IN ('queued','running') AND id!=? UNION ALL SELECT 1 FROM media_tasks WHERE asset_id=? AND state IN ('queued','running') LIMIT 1").get(id,ignoreJobId??'',id);if(busy)return {id,kinds,reasons,busy:true};
 const failed=new Set(db.prepare("SELECT kind FROM media_tasks WHERE asset_id=? AND state IN ('failed','cancelled')").all(id).map(row=>row.kind)),add=(kind,reason)=>{if(!kinds.includes(kind))kinds.push(kind);reasons.push(reason);};
 const cover=db.prepare('SELECT image_id FROM thumbnail_overrides WHERE asset_id=?').get(id),coverBase=cover&&/^[0-9a-f-]{36}$/.test(cover.image_id)?join(thumbnailDir,'custom',cover.image_id):join(thumbnailDir,id);
 if(!asset.thumbnail_ready||failed.has('thumbnail')||!await regularMedia(coverBase+'.webp')&&!await regularMedia(coverBase+'.jpg'))add('thumbnail','サムネイルが未生成、または前回の処理が未完了です。');
 const video=asset.mime_type.startsWith('video/'),timed=video||asset.mime_type.startsWith('audio/');
 if(timed){
  const source=db.prepare('SELECT canonical_ready FROM media_ingest WHERE asset_id=?').get(id);let valid=await regularMedia(join(uploadDir,id));
  if(video){const row=db.prepare('SELECT metadata_json FROM video_assets WHERE item_id=?').get(id);let metadata;try{metadata=row&&JSON.parse(row.metadata_json);}catch{}if(!metadata?.renditions?.length||metadata.generation&&!/^[0-9a-f-]{36}$/.test(metadata.generation))valid=false;else{const root=metadata.generation?join(videoDir,id,metadata.generation):join(videoDir,id);for(const rendition of metadata.renditions){if(!/^\d{2,4}p$/.test(rendition.quality)||!await regularMedia(join(root,rendition.quality+'.mp4'),rendition.size)||!await regularMedia(join(root,rendition.quality+'.m3u8'))){valid=false;break;}}}}
  else if(!db.prepare('SELECT 1 FROM audio_assets WHERE item_id=?').get(id))valid=false;
  if(source&&!source.canonical_ready||failed.has('transcode')||!valid)add('transcode','変換結果が未生成、または公開状態が未完了です。');
  if(video){const state=db.prepare('SELECT preview_version FROM video_thumbnail_state WHERE asset_id=?').get(id);if(kinds.includes('transcode')||failed.has('preview')||state?.preview_version!==PREVIEW_SPEC_VERSION||!await regularMedia(join(previewDir,id+'.mp4')))add('preview','動画プレビューが未生成、または更新待ちです。');}
 }
 return {id,kinds,reasons,busy:false};
}
export async function recoveryCandidates(context,{after='',limit=Infinity}={}){
 const rows=context.db.prepare('SELECT * FROM items WHERE id>? ORDER BY id').all(after),result=[];let busy=0,healthy=0;
 // Yield between batches so scans do not starve playback/transfer requests.
 for(let n=0;n<rows.length;n+=8){for(const [index,state]of (await Promise.all(rows.slice(n,n+8).map(row=>assessAssetRecovery(context,row)))).entries()){const item=rows[n+index];if(state.busy)busy++;else if(state.kinds.length)result.push({...state,title:item.title,mimeType:item.mime_type});else healthy++;}if(result.length>=limit)break;}
 return {assets:result.slice(0,limit),busy,healthy,scanned:Math.min(rows.length,busy+healthy+result.length)};
}
