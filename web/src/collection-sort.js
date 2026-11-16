export const SORTS=[['recent','追加が新しい順'],['oldest','追加が古い順'],['name','タイトル昇順'],['name-desc','タイトル降順'],['size-desc','サイズが大きい順'],['size-asc','サイズが小さい順'],['progress','続きから（未完了優先）'],['series','設定した順']];
export const normalizeSort=value=>SORTS.some(([id])=>id===value)?value:'recent';
const collator=new Intl.Collator('ja',{numeric:true,sensitivity:'base'});
export function compareCollection(a,b,sort='recent'){
  const name=()=>collator.compare(a.title,b.title),id=()=>String(a.id??'').localeCompare(String(b.id??''));
  return (sort==='name'?name():sort==='name-desc'?-name():sort==='oldest'?(a.createdAt??0)-(b.createdAt??0):sort==='size-desc'?(b.size??0)-(a.size??0):sort==='size-asc'?(a.size??0)-(b.size??0):sort==='progress'?Number(Boolean(a.progress?.completed))-Number(Boolean(b.progress?.completed))||(b.progress?.updatedAt??0)-(a.progress?.updatedAt??0):sort==='series'?(a.position??a.series?.position??0)-(b.position??b.series?.position??0):(b.createdAt??0)-(a.createdAt??0))||name()||id();
}
// localStorage belongs to this browser profile / app installation. The key adds
// the server, signed-in user and stable collection identity. A series keeps the
// same preference whether reached through a shelf or the complete library.
export function collectionSortKey(context){
  if(!context)return 'mirea.library-sort.v1';
  const {server,userId,shelfId,seriesId,playlistId,history}=context;
  if(typeof server!=='string'||!server||typeof userId!=='string'||!userId)return null;
  const location=history?['history']:playlistId?['playlist',playlistId]:seriesId?['series',seriesId]:shelfId?['shelf',shelfId]:['library'];
  return 'mirea.library-sort.v2|'+JSON.stringify([server.replace(/\/$/,''),userId,...location]);
}
const collectionStorage=()=>{try{return globalThis.localStorage;}catch{return null;}};
export function loadCollectionSort(storage,context,fallback='recent'){
  const key=collectionSortKey(context),defaultValue=normalizeSort(fallback);if(!key)return defaultValue;
  try{const value=(storage??collectionStorage())?.getItem(key);return SORTS.some(([id])=>id===value)?value:defaultValue;}catch{return defaultValue;}
}
export function saveCollectionSort(value,storage,context){
  value=normalizeSort(value);const key=collectionSortKey(context);
  if(key)try{(storage??collectionStorage())?.setItem(key,value);}catch{}return value;
}
export function createCollectionSortPreferences({context,storage}){
  const memory=new Map();
  return {load(fallback='recent'){const scope=context(),key=collectionSortKey(scope);return key&&memory.has(key)?memory.get(key):loadCollectionSort(storage,scope,fallback);},save(value){const scope=context(),key=collectionSortKey(scope),clean=saveCollectionSort(value,storage,scope);if(key)memory.set(key,clean);return clean;}};
}
