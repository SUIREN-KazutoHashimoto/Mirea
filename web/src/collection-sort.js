export const SORTS=[['recent','追加が新しい順'],['oldest','追加が古い順'],['name','タイトル昇順'],['name-desc','タイトル降順'],['size-desc','サイズが大きい順'],['size-asc','サイズが小さい順'],['progress','続きから（未完了優先）'],['series','設定した順']];
export const normalizeSort=value=>SORTS.some(([id])=>id===value)?value:'recent';
const collator=new Intl.Collator('ja',{numeric:true,sensitivity:'base'});
export function compareCollection(a,b,sort='recent'){
  const name=()=>collator.compare(a.title,b.title),id=()=>String(a.id??'').localeCompare(String(b.id??''));
  return (sort==='name'?name():sort==='name-desc'?-name():sort==='oldest'?(a.createdAt??0)-(b.createdAt??0):sort==='size-desc'?(b.size??0)-(a.size??0):sort==='size-asc'?(a.size??0)-(b.size??0):sort==='progress'?Number(Boolean(a.progress?.completed))-Number(Boolean(b.progress?.completed))||(b.progress?.updatedAt??0)-(a.progress?.updatedAt??0):sort==='series'?(a.position??a.series?.position??0)-(b.position??b.series?.position??0):(b.createdAt??0)-(a.createdAt??0))||name()||id();
}
export function loadCollectionSort(storage=globalThis.localStorage){try{return normalizeSort(storage.getItem('mirea.library-sort.v1'));}catch{return 'recent';}}
export function saveCollectionSort(value,storage=globalThis.localStorage){value=normalizeSort(value);try{storage.setItem('mirea.library-sort.v1',value);}catch{}return value;}
