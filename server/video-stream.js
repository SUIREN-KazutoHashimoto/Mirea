import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { hashToken, httpError } from './security.js';

export function videoMetadata(db,id) {
  const row=db.prepare('SELECT * FROM video_assets WHERE item_id=?').get(id);
  return row?{...JSON.parse(row.metadata_json),originalRetained:Boolean(row.original_retained)}:null;
}
export function registerVideoStreams(app,{db,videoDir,authenticate,findItem}) {
  const authorize=req=>{
    if(req.headers.authorization){authenticate(req);return findItem(req.params.id,req.user.id);}
    const token=typeof req.query.ticket==='string'&&/^[A-Za-z0-9_-]{43}$/.test(req.query.ticket)?req.query.ticket:'';
    const ticket=token&&db.prepare(`SELECT s.user_id FROM playback_tickets t JOIN sessions s ON s.id=t.session_id
      WHERE t.token_hash=? AND t.item_id=? AND t.expires_at>? AND s.expires_at>?`).get(hashToken(token),req.params.id,Date.now(),Date.now());
    if(!ticket)throw httpError(401,'配信URLの期限が切れました。再接続してください。');
    return findItem(req.params.id,ticket.user_id);
  };
  app.get('/api/v1/items/:id/video',{onRequest:async req=>authenticate(req)},async req=>{
    const item=findItem(req.params.id,req.user.id),metadata=videoMetadata(db,item.id);
    if(!item.mime_type.startsWith('video/'))throw httpError(400,'動画ではありません。');
    return metadata??{legacy:true,renditions:[],originalRetained:true};
  });
  app.route({method:['GET','HEAD'],url:'/api/v1/items/:id/hls/:file',handler:async(req,reply)=>{
    const item=authorize(req),metadata=videoMetadata(db,item.id),file=req.params.file;
    if(!metadata)throw httpError(404,'この動画にはHLS配信データがありません。');
    const suffix=req.query.ticket?`?ticket=${encodeURIComponent(req.query.ticket)}`:'';
    const allowed=new Set(metadata.renditions.flatMap(r=>r.files));
    reply.header('Cache-Control','private, no-store, no-transform');
    if(file==='master.m3u8'){
      const body='#EXTM3U\n#EXT-X-VERSION:7\n'+[...metadata.renditions].reverse().map(r=>
        `#EXT-X-STREAM-INF:BANDWIDTH=${r.bitrate},RESOLUTION=${r.width}x${r.height},FRAME-RATE=30.000,CODECS="avc1.640029,mp4a.40.2"\n${r.quality}.m3u8${suffix}\n`).join('');
      authorize(req);return reply.type('application/vnd.apple.mpegurl').send(req.method==='HEAD'?undefined:body);
    }
    if(!/^[0-9]+p(?:\.m3u8|-(?:init\.mp4|\d{5}\.m4s))$/.test(file)||!allowed.has(file))throw httpError(404,'配信ファイルが見つかりません。');
    const path=join(videoDir,item.id,file);
    if(file.endsWith('.m3u8')){
      const playlist=await readFile(path,'utf8');
      // Only server-generated allowlisted basenames are ever returned. Tickets
      // are propagated to MAP and media URIs; every request rechecks the ACL.
      const body=playlist.replace(/URI="([^"]+)"|^([^#\s][^\r\n]*)/gm,(match,map,segment)=>{
        const name=map||segment;if(!allowed.has(name))throw httpError(500,'Invalid generated playlist');
        return map?`URI="${name}${suffix}"`:`${name}${suffix}`;
      });
      authorize(req);return reply.type('application/vnd.apple.mpegurl').send(req.method==='HEAD'?undefined:body);
    }
    const info=await stat(path);authorize(req);
    reply.type(file.endsWith('.m4s')?'video/iso.segment':'video/mp4').header('Content-Length',info.size);
    return req.method==='HEAD'?reply.send():reply.send(createReadStream(path));
  }});
}
