// The input contains only assets/series already authorized by the library API.
// Group by identity, never by title; bulk operations still use the original assets.
export function collectionEntries(selected, series, {group=true, allItems=selected, filter='all', search='', sort='recent'}={}) {
  if (!group) return selected.map(item=>({type:'asset',item}));
  const metadata=new Map(series.map(row=>[row.id,row])), groups=new Map(), entries=[];
  for (const item of selected) {
    if (!item.series || item.pending) { entries.push({type:'asset',item}); continue; }
    let entry=groups.get(item.series.id);
    if (!entry) { entry={type:'series',id:item.series.id,title:item.series.title,members:[]};groups.set(entry.id,entry);entries.push(entry); }
    entry.members.push(item);
  }
  const query=search.toLocaleLowerCase();
  for (const row of series) if (!groups.has(row.id) && filter==='all' && !allItems.some(i=>i.series?.id===row.id) && row.title.toLocaleLowerCase().includes(query)) {
    const entry={type:'series',id:row.id,title:row.title,members:[]};groups.set(row.id,entry);entries.push(entry);
  }
  for (const entry of groups.values()) {
    const row=metadata.get(entry.id),members=allItems.filter(i=>!i.pending&&i.series?.id===entry.id).sort((a,b)=>a.series.position-b.series.position);
    entry.title=row?.title??entry.title;entry.assetCount=members.length;entry.matchedCount=entry.members.length;
    entry.cover=members.find(i=>i.id===row?.coverId)??members[0];
    entry.role=row?.role??entry.cover?.role??'viewer';
    entry.shelfName=row?.shelfName??entry.cover?.shelfName??'';
    entry.completed=members.filter(i=>i.progress?.completed).length;
    entry.createdAt=Math.max(row?.createdAt??0,...members.map(i=>i.createdAt??0));
  }
  const value=entry=>entry.type==='series'?entry:entry.item;
  return entries.sort((a,b)=>sort==='name'?value(a).title.localeCompare(value(b).title,'ja'):(value(b).createdAt??0)-(value(a).createdAt??0));
}
