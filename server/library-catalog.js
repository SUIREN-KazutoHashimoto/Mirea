import {shelfSeries,shelfSeriesMembership} from './series.js';
import {publicProgress} from './progress.js';
import {pendingShelfUploads} from './pending-uploads.js';
import {userPlaylists} from './playlists.js';
import {createCatalogResponses} from './catalog-response.js';

// A complete, authenticated snapshot. No pagination/selected-shelf ambiguity:
// removing a membership also removes its entire tree from the next snapshot.
export function registerLibraryCatalog(app,{db,authenticate,publicItem}){
  const responses=createCatalogResponses();app.addHook('onClose',async()=>responses.clear());
  app.get('/api/v1/library/catalog',{onRequest:async req=>authenticate(req)},async(req,reply)=>{
    db.exec('BEGIN');let snapshot;
    try{
      const shelves=db.prepare(`SELECT s.*,m.role,
        (SELECT COUNT(*) FROM items i WHERE i.shelf_id=s.id) itemCount,
        (SELECT COUNT(*) FROM memberships n WHERE n.shelf_id=s.id) memberCount
        FROM shelves s JOIN memberships m ON m.shelf_id=s.id WHERE m.user_id=? ORDER BY s.created_at DESC,s.id`).all(req.user.id);
      const progress=new Map(db.prepare('SELECT * FROM asset_progress WHERE user_id=?').all(req.user.id).map(p=>[p.asset_id,publicProgress(p)]));
      const items=[],series=[];
      for(const shelf of shelves){
        const membership=shelfSeriesMembership(db,shelf.id),context={shelfName:shelf.name,role:shelf.role};
        for(const row of shelfSeries(db,shelf.id))series.push({...row,...context});
        const records=db.prepare('SELECT * FROM items WHERE shelf_id=? ORDER BY created_at DESC,id').all(shelf.id);
        for(const item of publicItem.batch(records))items.push({...item,...context,series:membership.get(item.id)??null,progress:progress.get(item.id)??null});
        for(const item of pendingShelfUploads(db,shelf.id))items.push({...item,...context});
      }
      const playlists=userPlaylists(db,req.user.id);
      snapshot={version:1,userId:req.user.id,serverTime:Date.now(),shelves,series,items,playlists};
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    const response=responses.respond(snapshot,{ifNoneMatch:req.headers['if-none-match'],delta:req.query.delta==='1'});
    reply.headers(response.headers).header('Vary',[reply.getHeader('Vary'),'Authorization'].filter(Boolean).join(', '));
    return response.status===304?reply.code(304).send():response.body;
  });
}
