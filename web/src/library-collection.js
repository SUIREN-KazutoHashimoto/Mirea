import {seriesPath,isInSeries} from './series-tree.js';
// Group only API-authorized rows; folders contain direct assets and child folders.
export function collectionEntries(selected,series,{group=true,parentId=null,allItems=selected,filter='all',search='',sort='recent'}={}){
  if(!group)return selected.map(item=>({type:'asset',item}));
  series=[...series];const known=new Set(series.map(s=>s.id));for(const item of allItems)if(item.series&&!known.has(item.series.id)){known.add(item.series.id);series.push({...item.series,parentId:null});}
  const metadata=new Map(series.map(row=>[row.id,row])),entries=[];
  for(const item of selected)if(item.pending?(parentId===null||item.series?.id===parentId):!item.series?parentId===null:item.series.id===parentId)entries.push({type:'asset',item});
  const query=search.toLocaleLowerCase();
  for(const row of series){
    const parent=metadata.has(row.parentId)?row.parentId:null;if(parent!==parentId)continue;
    const members=allItems.filter(i=>!i.pending&&i.series&&isInSeries(series,i.series.id,row.id)).sort((a,b)=>a.series.position-b.series.position);
    const matching=selected.filter(i=>!i.pending&&i.series&&isInSeries(series,i.series.id,row.id));
    const descendants=series.filter(s=>isInSeries(series,s.id,row.id));
    if(!matching.length&&!(filter==='all'&&descendants.some(s=>seriesPath(series,s.id).map(r=>r.title).join(' / ').toLocaleLowerCase().includes(query))))continue;
    // Search/type filters do not expose unrelated, non-matching populated folders.
    if(!matching.length&&members.length&&!(filter==='all'&&row.title.toLocaleLowerCase().includes(query)))continue;
    const cover=members.find(i=>i.id===row.coverId)??members[0];
    entries.push({type:'series',id:row.id,title:row.title,members:matching,assetCount:members.length,matchedCount:matching.length,cover,childCount:row.childCount??series.filter(s=>s.parentId===row.id).length,
      role:row.role??cover?.role??'viewer',shelfName:row.shelfName??cover?.shelfName??'',completed:members.filter(i=>i.progress?.completed).length,createdAt:Math.max(row.createdAt??0,...members.map(i=>i.createdAt??0))});
  }
  const value=entry=>entry.type==='series'?entry:entry.item;
  return entries.sort((a,b)=>parentId?(a.type!==b.type?(a.type==='series'?-1:1):a.type==='asset'?a.item.series.position-b.item.series.position:a.title.localeCompare(b.title,'ja')):sort==='name'?value(a).title.localeCompare(value(b).title,'ja'):(value(b).createdAt??0)-(value(a).createdAt??0));
}
