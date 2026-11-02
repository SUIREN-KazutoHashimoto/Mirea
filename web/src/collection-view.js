const key='mirea.library-view.v1';
export function normalizeCollectionView(value={}){
  return {layout:['grid2','grid3','grid5','list'].includes(value?.layout)?value.layout:'grid2',details:value?.details==='compact'?'compact':'full'};
}
const storageKey=context=>context?key+'|'+context:key;
export function loadCollectionView(storage,context=''){try{const store=storage??globalThis.localStorage;return normalizeCollectionView(JSON.parse(store.getItem(storageKey(context))??store.getItem(key)));}catch{return normalizeCollectionView();}}
export function saveCollectionView(value,storage,context=''){const clean=normalizeCollectionView(value);try{(storage??globalThis.localStorage).setItem(storageKey(context),JSON.stringify(clean));}catch{}return clean;}
export function mountCollectionView({container,grid,onChanged=()=>{},storage,context=()=>''}){
  let scope=context(),view=loadCollectionView(storage,scope);
  container.innerHTML='<label>表示形式<select class="collection-layout" aria-label="コンテンツの表示形式"><option value="grid2">2列</option><option value="grid3">3列</option><option value="grid5">5列</option><option value="list">リスト</option></select></label><label>表示情報<select class="collection-details" aria-label="コンテンツの表示情報"><option value="full">詳細</option><option value="compact">サムネイル＋タイトル</option></select></label>';
  const layout=container.querySelector('.collection-layout'),details=container.querySelector('.collection-details');
  function apply(){layout.value=view.layout;details.value=view.details;grid.dataset.layout=view.layout;grid.dataset.details=view.details;}
  const change=()=>{scope=context();view=saveCollectionView({layout:layout.value,details:details.value},storage,scope);apply();onChanged(view);};
  layout.onchange=change;details.onchange=change;apply();return {get value(){return {...view};},refreshContext(){const next=context();if(next===scope)return;scope=next;view=loadCollectionView(storage,scope);apply();}};
}
