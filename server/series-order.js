const names=new Intl.Collator('ja',{numeric:true,sensitivity:'variant'});
export const compareSeriesAssets=(a,b)=>names.compare(a.title,b.title)||a.id.localeCompare(b.id);

// Call inside the caller's transaction. Temporary positive positions avoid
// UNIQUE collisions without deleting memberships or firing removal triggers.
export function orderSeriesItems(db,id,{force=false}={}){
 const series=db.prepare('SELECT order_mode FROM series WHERE id=?').get(id);if(!series||!force&&series.order_mode==='manual')return false;
 const rows=db.prepare('SELECT si.asset_id id,si.position,i.title FROM series_items si JOIN items i ON i.id=si.asset_id WHERE si.series_id=?').all(id),sorted=rows.slice().sort(compareSeriesAssets);
 if(sorted.every((row,index)=>row.position===index+1))return false;
 const update=db.prepare('UPDATE series_items SET position=? WHERE series_id=? AND asset_id=?'),offset=rows.reduce((maximum,row)=>Math.max(maximum,row.position),0)+rows.length+1;
 sorted.forEach((row,index)=>update.run(offset+index,id,row.id));sorted.forEach((row,index)=>update.run(index+1,id,row.id));return true;
}
