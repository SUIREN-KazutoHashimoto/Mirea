// Build once per catalog/render, not once per asset x folder comparison.
const indexes=new WeakMap();
export function seriesIndex(rows){
  let cached=indexes.get(rows);if(cached&&cached.size===rows.length)return cached;
  const map=new Map(rows.map(s=>[s.id,s])),paths=new Map(),children=new Map();
  for(const row of rows){const parent=map.has(row.parentId)?row.parentId:null;if(!children.has(parent))children.set(parent,[]);children.get(parent).push(row);}
  const path=id=>{if(paths.has(id))return paths.get(id);const seen=new Set(),result=[];let row=map.get(id);while(row&&!seen.has(row.id)&&result.length<16){seen.add(row.id);result.unshift(row);row=map.get(row.parentId);}paths.set(id,result);return result;};
  cached={map,path,children,size:rows.length};indexes.set(rows,cached);return cached;
}
export function seriesPath(rows,id){return seriesIndex(rows).path(id);}
export const seriesPathLabel=(rows,id)=>seriesPath(rows,id).map(s=>s.title).join(' / ');
export const isInSeries=(rows,id,parent)=>seriesPath(rows,id).some(s=>s.id===parent);
