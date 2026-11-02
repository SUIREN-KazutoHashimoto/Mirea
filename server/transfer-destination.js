// Account/membership checks run before this helper. No filesystem paths.
export function transferDestination(db,shelfId,seriesId){
 const shelf=db.prepare('SELECT name FROM shelves WHERE id=?').get(shelfId);
 if(!shelf)return null;
 const seriesPath=[],seen=new Set();let id=seriesId;
 while(id&&!seen.has(id)&&seriesPath.length<17){
  seen.add(id);const row=db.prepare('SELECT id,title,parent_id FROM series WHERE id=? AND shelf_id=?').get(id,shelfId);
  if(!row)break;seriesPath.unshift({id:row.id,title:row.title});id=row.parent_id;
 }
 return {shelfId,shelfName:shelf.name,seriesId:seriesPath.at(-1)?.id??null,seriesPath,label:[shelf.name,...seriesPath.map(s=>s.title)].join(' › ')};
}
