// Ownership never substitutes for current access to the shared shelf.
export function canRegenerateThumbnail(db,item,userId){
  if(!item||!userId)return false;
  const role=db.prepare('SELECT role FROM memberships WHERE shelf_id=? AND user_id=?').get(item.shelf_id,userId)?.role;
  return role==='owner'||role==='editor'&&item.uploaded_by===userId;
}
