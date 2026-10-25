// Names are titles, not filenames. Shelf names remain unrestricted.
export const canonicalName=value=>String(value??'').trim().normalize('NFC');
export const nameKey=(shelfId,parentId,title)=>JSON.stringify([shelfId,parentId??null,canonicalName(title)]);
export function duplicateNameGroups(rows){
  const groups=new Map();
  for(const row of rows){const key=nameKey(row.shelfId,row.parentId,row.title);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  return [...groups.values()].filter(rows=>rows.length>1);
}
export function libraryNameConflicts({shelves,series,items}){
  const managed=new Map(shelves.filter(s=>['owner','editor'].includes(s.role)).map(s=>[s.id,s]));
  const bySeries=new Map(series.map(s=>[s.id,s]));
  const path=(shelfId,parentId)=>{const names=[],seen=new Set();let row=bySeries.get(parentId);while(row&&!seen.has(row.id)&&seen.size<16){seen.add(row.id);names.unshift(row.title);row=bySeries.get(row.parentId);}return [managed.get(shelfId)?.name??'本棚',...names].join(' / ');};
  return [['series',series.map(s=>({...s,parentId:s.parentId??null}))],['asset',items.filter(i=>!i.pending).map(i=>({...i,parentId:i.series?.id??i.parentId??null}))]].flatMap(([kind,rows])=>duplicateNameGroups(rows.filter(row=>managed.has(row.shelfId))).map(group=>({kind,shelfId:group[0].shelfId,parentId:group[0].parentId,title:canonicalName(group[0].title),path:path(group[0].shelfId,group[0].parentId),count:group.length,entries:group.slice(0,20).map(row=>({id:row.id,title:row.title}))})));
}
