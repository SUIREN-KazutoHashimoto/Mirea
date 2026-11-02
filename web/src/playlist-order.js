const collator=new Intl.Collator('ja',{numeric:true,sensitivity:'base'});
export function reorderPlaylist(ids,items,mode){
  if(mode==='reverse')return ids.slice().reverse();
  if(!['asc','desc'].includes(mode))throw Error('並び順が不正です。');
  const byId=new Map(items.map(item=>[item.id,item]));
  return ids.map((id,index)=>({id,index})).sort((a,b)=>(mode==='desc'?-1:1)*collator.compare(byId.get(a.id)?.title??'',byId.get(b.id)?.title??'')||a.index-b.index).map(row=>row.id);
}
export function movePlaylistEntry(ids,index,position){
  if(!Number.isInteger(index)||index<0||index>=ids.length||!Number.isInteger(position)||position<1||position>ids.length)throw Error('移動先は1〜'+ids.length+'で指定してください。');
  const next=ids.slice(),[id]=next.splice(index,1);next.splice(position-1,0,id);return next;
}
