import {join} from 'node:path';
import {mediaContentSource} from './media-pipeline.js';
import {videoMetadata,videoFolder} from './video-stream.js';
import {httpError} from './security.js';

// Existing generation-bound tickets must keep their bytes and size while a
// repair publishes a different canonical rendition or resets ingest readiness.
export function playbackSource(db,item,storage,generation){
 const source=mediaContentSource(db,item,storage,{raw:generation==='source'});
 const metadata=generation==='source'||source.original&&!generation?null:videoMetadata(db,item.id,generation);
 if(generation&&generation!=='source'&&!metadata)throw httpError(409,'再生中の配信データが見つかりません。プレイヤーを開き直してください。');
 const best=metadata?.renditions?.slice().sort((a,b)=>b.width*b.height-a.width*a.height||b.size-a.size)[0];
 if(!best)return {source,metadata:null};
 if(!/^\d{2,4}p$/.test(best.quality))throw Error('Invalid playback rendition');
 return {source:{path:join(videoFolder(storage.videoDir,item.id,metadata),best.quality+'.mp4'),mimeType:'video/mp4',size:best.size,filename:item.filename,original:false},metadata};
}
