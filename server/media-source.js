import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {videoMetadata,videoFolder} from './video-stream.js';
import {probeVideo} from './video-transcode.js';

// A missing raw original must never force a second encode of a lower-quality
// recent generation while a better canonical/older rendition still exists.
export async function selectVideoSource({db,item,uploadDir,originalDir,videoDir,probe=probeVideo}){
  const regular=async path=>{const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});return info?.isFile()&&!info.isSymbolicLink()?info:null;};
  const original=join(originalDir,item.id);
  if(await regular(original))return {path:original,kind:'original'};
  const candidates=[],seen=new Set();
  async function add(path,info){if(seen.has(path))return;seen.add(path);const file=await regular(path);if(file)candidates.push({path,kind:'best-available',...info,size:file.size,bitrate:info.duration>0?file.size*8/info.duration:info.bitrate??0});}
  const current=videoMetadata(db,item.id),all=[...(current?[current]:[]),...db.prepare('SELECT metadata_json FROM video_generations WHERE item_id=?').all(item.id).map(row=>JSON.parse(row.metadata_json))];
  for(const metadata of all){
    if(metadata.generation&&!/^[0-9a-f-]{36}$/.test(metadata.generation))continue;
    for(const r of metadata.renditions??[])if(/^\d{2,4}p$/.test(r.quality))await add(join(videoFolder(videoDir,item.id,metadata),r.quality+'.mp4'),{quality:r.quality,width:r.width,height:r.height,duration:metadata.duration,bitrate:r.bitrate??0,generation:metadata.generation??'base'});
  }
  const canonical=join(uploadDir,item.id);
  if(await regular(canonical)){
    try{const info=await probe(canonical);
      await add(canonical,{quality:Math.round(Math.min(info.width??info.video.width,info.height??info.video.height))+'p',width:info.width??info.video.width,height:info.height??info.video.height,duration:info.duration,bitrate:Number(info.video.bit_rate??0),generation:'canonical'});
    }catch(error){if(!candidates.length)throw error;}
  }
  candidates.sort((a,b)=>(b.width*b.height-a.width*a.height)||(b.bitrate-a.bitrate)||(b.size-a.size));
  if(!candidates.length)throw new Error('No usable original or rendition');
  return candidates[0];
}
