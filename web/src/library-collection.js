import {seriesIndex,seriesPath,isInSeries} from './series-tree.js';
import {compareCollection} from './collection-sort.js';
// Aggregate descendants in O((assets + folders) * maximum depth). Pending rows
// keep their real destination; they are never synthesized at shelf root.
export function collectionEntries(selected,series,{group=true,parentId=null,allItems=selected,filter='all',search='',sort=parentId?'series':'recent'}={}){
  if(!group)return selected.map(item=>({type:'asset',item}));
  series=[...series];const known=new Set(series.map(s=>s.id));for(const item of allItems)if(item.series&&!known.has(item.series.id)){known.add(item.series.id);series.push({...item.series,parentId:null});}
  const index=seriesIndex(series),metadata=index.map,entries=[],members=new Map(),matching=new Map();
  const add=(map,row)=>{for(const s of index.path(row.series?.id)){if(!map.has(s.id))map.set(s.id,[]);map.get(s.id).push(row);}};
  for(const item of allItems)add(members,item);for(const item of selected){add(matching,item);if(!item.series?parentId===null:item.series.id===parentId)entries.push({type:'asset',item});}
  const query=search.toLocaleLowerCase(),matchingFolders=new Set();
  if(filter==='all')for(const row of series)if(index.path(row.id).map(s=>s.title).join(' / ').toLocaleLowerCase().includes(query))for(const s of index.path(row.id))matchingFolders.add(s.id);
  for(const row of index.children.get(parentId)??[]){
    const contents=(members.get(row.id)??[]).sort((a,b)=>(a.series?.position??0)-(b.series?.position??0)),matches=matching.get(row.id)??[];
    if(!matches.length&&!(filter==='all'&&matchingFolders.has(row.id)))continue;
    if(!matches.length&&contents.length&&!(filter==='all'&&row.title.toLocaleLowerCase().includes(query)))continue;
    const cover=contents.find(i=>!i.pending&&i.id===row.coverId)??contents.find(i=>!i.pending);
    let createdAt=row.createdAt??0,size=0,completed=0,progress;
    for(const item of contents){createdAt=Math.max(createdAt,item.createdAt??0);size+=item.size??0;if(item.progress?.completed)completed++;if((item.progress?.updatedAt??0)>(progress?.updatedAt??-1))progress=item.progress;}
    entries.push({type:'series',id:row.id,title:row.title,members:matches,assetCount:contents.length,matchedCount:matches.length,cover,childCount:row.childCount??index.children.get(row.id)?.length??0,role:row.role??cover?.role??'viewer',shelfName:row.shelfName??cover?.shelfName??'',completed,size,progress,createdAt});
  }
  const value=entry=>entry.type==='series'?entry:entry.item;
  return entries.sort((a,b)=>parentId&&sort==='series'?(a.type!==b.type?(a.type==='series'?-1:1):a.type==='asset'?(a.item.series?.position??0)-(b.item.series?.position??0):a.title.localeCompare(b.title,'ja')):compareCollection(value(a),value(b),sort));
}
