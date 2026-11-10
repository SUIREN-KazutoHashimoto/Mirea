export function aiSearchScope(catalog,scope={}) {
  const shelves=new Map(catalog.shelves.map(s=>[s.id,s]));
  let series;
  if(scope.seriesId){series=new Set([scope.seriesId]);for(let round=0;round<16;round++){let added=false;for(const row of catalog.series??[])if(series.has(row.parentId)&&!series.has(row.id)){series.add(row.id);added=true;}if(!added)break;}}
  const playlist=scope.playlistId?new Set(catalog.playlists?.find(p=>p.id===scope.playlistId)?.assetIds??[]):null;
  return item=>{const shelf=shelves.get(item.shelfId);if(!shelf|| (scope.shelfId?item.shelfId!==scope.shelfId:shelf.private))return false;
    if(series&&!series.has(item.series?.id)||playlist&&!playlist.has(item.id))return false;
    return !scope.kind||item.kind===scope.kind||scope.kind==='book'&&['pdf','epub','image-book'].includes(item.kind);
  };
}
export const sameAiRevision=(a,b)=>Boolean(a&&b&&a.revision===b.revision&&a.editRevision===b.editRevision&&a.inputStamp===b.inputStamp);
export const aiTagMatches=(labels,tags,mode='all')=>tags.length===0||(mode==='any'?tags.some(tag=>labels.has(tag)):tags.every(tag=>labels.has(tag)));

export async function aiCacheMarker(vault,partition,id){
  const epoch=await vault.metadataEpoch?.(partition)??null;let value;
  try{value=await vault.unseal(partition,'ai-revoked:'+id);}catch{value='unreadable';}
  const idValue=value&&typeof value==='object'?value.id:value===true?'legacy':value==='unreadable'?'unreadable':null;
  return epoch===null&&idValue===null?null:JSON.stringify([epoch,idValue]);
}
export async function aiCachedPack(vault,partition,id,asset){
  let value;try{value=await vault.metadata(partition,id);}catch{return null;}if(!value)return null;
  return (value.pack?value.authorization??null:null)===await aiCacheMarker(vault,partition,asset)?value.pack??value:null;
}
export async function saveAiCachedPack(vault,partition,id,pack,authorization){
  if(await aiCacheMarker(vault,partition,pack.assetId)!==authorization)throw new DOMException('閲覧許可が変更されました。開き直してください。','AbortError');
  await vault.saveMetadata(partition,id,{serverTime:pack.serverTime,expiresAt:pack.expiresAt},{pack,authorization});
}

export async function aiCacheDenied(vault,partition,id){try{const value=await vault.unseal(partition,'ai-revoked:'+id);return value===true||Boolean(value?.id);}catch{return false;}}
