import {randomUUID} from 'node:crypto';
import {transaction} from './database.js';
import {httpError} from './security.js';
import {playlistKind} from './playlist-kind.js';

const uuid={type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'};
const revision={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER-10000};
const title={type:'string',minLength:1,maxLength:200};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
// Personal references never bypass shelf ACLs, including offline snapshots.
export function userPlaylists(db,userId){
  const rows=db.prepare('SELECT * FROM playlists WHERE user_id=? ORDER BY updated_at DESC,id').all(userId);
  const assets=db.prepare(`SELECT pi.asset_id,i.mime_type FROM playlist_items pi JOIN items i ON i.id=pi.asset_id
    JOIN memberships m ON m.shelf_id=i.shelf_id AND m.user_id=? WHERE pi.playlist_id=? ORDER BY pi.position`);
  return rows.map(p=>{const members=assets.all(userId,p.id),kinds=new Set(members.map(playlistKind));return {id:p.id,title:p.title,revision:p.revision,createdAt:p.created_at,updatedAt:p.updated_at,assetIds:members.map(i=>i.asset_id),kind:kinds.size===1?[...kinds][0]:null,mixed:kinds.size>1};});
}
export function registerPlaylists(app,{db,authenticate,findItem,publicItem}){
  const auth={onRequest:async req=>authenticate(req)};
  const find=(id,userId)=>{const p=db.prepare('SELECT * FROM playlists WHERE id=? AND user_id=?').get(id,userId);if(!p)throw httpError(404,'プレイリストが見つかりません。');return p;};
  const read=(id,userId)=>userPlaylists(db,userId).find(p=>p.id===id);
  app.get('/api/v1/playlists',auth,async req=>({playlists:userPlaylists(db,req.user.id)}));
  app.get('/api/v1/playlists/:id/playback',{...auth,schema:{params:object({id:uuid}),querystring:object({assetId:uuid})}},async req=>{
    find(req.params.id,req.user.id);const playlist=read(req.params.id,req.user.id);
    if(!playlist||playlist.mixed||!['audio','video'].includes(playlist.kind))throw httpError(422,'同じ種類の動画または音声のプレイリストを選んでください。');
    const items=playlist.assetIds.map((id,index)=>({...publicItem(findItem(id,req.user.id)),series:{label:String(index+1)}})),currentIndex=items.findIndex(item=>item.id===req.query.assetId);
    if(currentIndex<0)throw httpError(404,'この作品はプレイリストにありません。');
    return {series:{id:playlist.id,title:playlist.title,playlist:true},items,currentIndex};
  });
  app.post('/api/v1/playlists',{...auth,schema:{body:object({title,requestId:uuid},['title'])}},async(req,reply)=>{
    const name=req.body.title.trim();if(!name)throw httpError(422,'名前を入力してください。');const id=req.body.requestId??randomUUID(),now=Date.now();
    transaction(db,()=>{const existing=db.prepare('SELECT user_id FROM playlists WHERE id=?').get(id);if(existing){if(existing.user_id!==req.user.id)throw httpError(409,'別の作成要求としてやり直してください。');return;}if(db.prepare('SELECT COUNT(*) n FROM playlists WHERE user_id=?').get(req.user.id).n>=200)throw httpError(422,'プレイリストは200件までです。');db.prepare('INSERT INTO playlists VALUES(?,?,?,?,?,?)').run(id,req.user.id,name,1,now,now);});
    return reply.code(201).send({playlist:read(id,req.user.id)});
  });
  app.put('/api/v1/playlists/:id',{...auth,bodyLimit:65536,schema:{body:object({revision,title,assetIds:{type:'array',maxItems:1000,uniqueItems:true,items:uuid}})}},async req=>transaction(db,()=>{
    const p=find(req.params.id,req.user.id);if(p.revision!==req.body.revision)throw httpError(409,'別の画面で更新されました。読み直してください。');
    const name=req.body.title.trim();if(!name)throw httpError(422,'名前を入力してください。');const kinds=new Set(req.body.assetIds.map(id=>playlistKind(findItem(id,req.user.id))));if(kinds.size>1)throw httpError(422,'プレイリストには同じ種類（音声・動画・本）の作品だけを追加できます。種類を分けて保存してください。');
    db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run(p.id);const insert=db.prepare('INSERT INTO playlist_items VALUES(?,?,?)');req.body.assetIds.forEach((id,index)=>insert.run(p.id,id,index+1));
    db.prepare('UPDATE playlists SET title=?,revision=revision+1,updated_at=? WHERE id=?').run(name,Date.now(),p.id);return {playlist:read(p.id,req.user.id)};
  }));
  app.delete('/api/v1/playlists/:id',{...auth,schema:{body:object({revision})}},async(req,reply)=>{
    transaction(db,()=>{const p=find(req.params.id,req.user.id);if(p.revision!==req.body.revision)throw httpError(409,'別の画面で更新されました。読み直してください。');db.prepare('DELETE FROM playlists WHERE id=?').run(p.id);});return reply.code(204).send();
  });
}
