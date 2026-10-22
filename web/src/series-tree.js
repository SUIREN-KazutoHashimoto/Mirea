export function seriesPath(rows,id){
  const map=new Map(rows.map(s=>[s.id,s])),seen=new Set(),path=[];let row=map.get(id);
  while(row&&!seen.has(row.id)&&path.length<16){seen.add(row.id);path.unshift(row);row=map.get(row.parentId);}
  return path;
}
export const seriesPathLabel=(rows,id)=>seriesPath(rows,id).map(s=>s.title).join(' / ');
export const isInSeries=(rows,id,parent)=>seriesPath(rows,id).some(s=>s.id===parent);
