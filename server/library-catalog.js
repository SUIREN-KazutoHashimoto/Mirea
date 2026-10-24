import {shelfSeries,shelfSeriesMembership} from './series.js';
import {publicProgress} from './progress.js';
import {pendingShelfUploads} from './pending-uploads.js';
import {userPlaylists} from './playlists.js';

// A complete, authenticated snapshot. No pagination/selected-shelf ambiguity:
// removing a membership also removes its entire tree from the next snapshot.
export function registerLibraryCatalog(app,{db,authenticate,publicItem}){
  app.get('/api/v1/library/catalog',{onRequest:async req=>authenticate(req)},async req=>{
    db.exec('BEGIN');
    try{
      const shelves=db.prepare(`SELECT s.*,m.role,
        (SELECT COUNT(*) FROM items i WHERE i.shelf_id=s.id) itemCount,
        (SELECT COUNT(*) FROM memberships n WHERE n.shelf_id=s.id) memberCount
        FROM shelves s JOIN memberships m ON m.shelf_id=s.id WHERE m.user_id=? ORDER BY s.created_at DESC,s.id`).all(req.user.id);
      const progress=new Map(db.prepare('SELECT * FROM asset_progress WHERE user_id=?').all(req.user.id).map(p=>[p.asset_id,publicProgress(p)]));
      const items=[],series=[];
      for(const shelf of shelves){
        const membership=shelfSeriesMembership(db,shelf.id),context={shelfName:shelf.name,role:shelf.role};
        series.push(...shelfSeries(db,shelf.id).map(s=>({...s,...context})));
        items.push(...db.prepare('SELECT * FROM items WHERE shelf_id=? ORDER BY created_at DESC,id').all(shelf.id).map(i=>({...publicItem(i),...context,series:membership.get(i.id)??null,progress:progress.get(i.id)??null})),
          ...pendingShelfUploads(db,shelf.id).map(i=>({...i,...context})));
      }
      const playlists=userPlaylists(db,req.user.id);
      db.exec('COMMIT');return {version:1,userId:req.user.id,serverTime:Date.now(),shelves,series,items,playlists};
    }catch(error){db.exec('ROLLBACK');throw error;}
  });
}
