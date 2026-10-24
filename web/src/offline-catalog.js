import {offlineVault} from './offline-vault.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text=(v,max)=>typeof v==='string'?v.slice(0,max):'';
const number=v=>Number.isFinite(v)&&v>=0?v:0;
const role=v=>['owner','editor','viewer'].includes(v)?v:'viewer';
const fields=(value,names)=>Object.fromEntries(names.filter(n=>value[n]!==undefined).map(n=>[n,value[n]]));
const coverSlot=id=>'catalog-cover:'+id;
const COVER_BYTES=2097152,COVER_AGE=86400000;
const validCover=(item,url)=>typeof url==='string'&&new RegExp('^/api/v1/items/'+item.id+'/thumbnail(?:\\?revision=[0-9a-f-]{36})?$').test(url);

// Explicit allowlists: never persist an API response containing tokens, paths,
// member profiles, download keys, raw analytics, or file contents.
export function normalizeCatalog(input,userId){
  if(input?.version!==1||input.userId!==userId||!uuid.test(userId)||!Number.isSafeInteger(input.serverTime)||input.serverTime<=0)throw Error('一覧情報が不正です。');
  for(const name of ['shelves','series','items'])if(!Array.isArray(input[name])||input[name].length>100000)throw Error('一覧情報が不正です。');
  const unique=rows=>{const ids=new Set();for(const row of rows){if(!uuid.test(row.id)||ids.has(row.id))throw Error('一覧情報が不正です。');ids.add(row.id);}return ids;};
  const shelfIds=unique(input.shelves),seriesIds=unique(input.series);unique(input.items);
  const shelves=input.shelves.map(s=>({id:s.id,name:text(s.name,100),description:text(s.description,500),createdAt:number(s.created_at??s.createdAt),role:role(s.role),private:Boolean(s.private),itemCount:number(s.itemCount),memberCount:number(s.memberCount)}));
  const byShelf=new Map(shelves.map(s=>[s.id,s]));
  const series=input.series.map(s=>{
    if(!shelfIds.has(s.shelfId)||s.parentId&&!seriesIds.has(s.parentId))throw Error('シリーズ情報が不正です。');
    return {id:s.id,shelfId:s.shelfId,title:text(s.title,200),description:text(s.description,2000),parentId:s.parentId??null,revision:number(s.revision),createdAt:number(s.createdAt),updatedAt:number(s.updatedAt),assetCount:number(s.assetCount),directAssetCount:number(s.directAssetCount),childCount:number(s.childCount),coverId:uuid.test(s.coverId)?s.coverId:null,role:byShelf.get(s.shelfId).role,shelfName:byShelf.get(s.shelfId).name};
  });
  const bySeries=new Map(series.map(s=>[s.id,s]));
  for(const s of series){let row=s;const seen=new Set();while(row){if(row.shelfId!==s.shelfId||seen.has(row.id)||seen.size>=16)throw Error('シリーズ情報が不正です。');seen.add(row.id);row=bySeries.get(row.parentId);}}
  const items=input.items.filter(i=>!i.pending).map(i=>{
    if(!shelfIds.has(i.shelfId)||!['pdf','epub','image-book','video','audio'].includes(i.kind)||!validCover(i,i.thumbnailUrl))throw Error('アセット情報が不正です。');
    const s=i.series&&bySeries.get(i.series.id);if(i.series&&(!s||s.shelfId!==i.shelfId))throw Error('アセットのシリーズ情報が不正です。');
    return {id:i.id,shelfId:i.shelfId,title:text(i.title,200),kind:i.kind,mimeType:text(i.mimeType,100),size:number(i.size),pageCount:number(i.pageCount),createdAt:number(i.createdAt),thumbnailUrl:i.thumbnailUrl,
      shelfName:byShelf.get(i.shelfId).name,role:byShelf.get(i.shelfId).role,series:s?{id:s.id,title:s.title,position:number(i.series.position),label:text(i.series.label,80)}:null,
      progress:i.progress?fields(i.progress,['revision','positionMs','durationMs','page','scrollX','scrollY','zoom','completed','updatedAt']):null};
  });
  const inputPlaylists=input.playlists??[],assetIds=new Set(items.map(i=>i.id));
  if(!Array.isArray(inputPlaylists)||inputPlaylists.length>200)throw Error('プレイリスト情報が不正です。');unique(inputPlaylists);
  const playlists=inputPlaylists.map(p=>{
    if(!Array.isArray(p.assetIds)||p.assetIds.length>1000||new Set(p.assetIds).size!==p.assetIds.length||p.assetIds.some(id=>!uuid.test(id)))throw Error('プレイリスト情報が不正です。');
    return {id:p.id,title:text(p.title,200),revision:number(p.revision),createdAt:number(p.createdAt),updatedAt:number(p.updatedAt),assetIds:p.assetIds.filter(id=>assetIds.has(id))};
  });
  return {version:1,userId,serverTime:input.serverTime,shelves,series,items,playlists};
}

export function offlineCollection(catalog,rows,playable){
  const downloads=new Map(rows.map(row=>[row.assetId,row]));
  const items=catalog?catalog.items:rows.filter(row=>row.state==='ready').map(row=>{const m=row.manifest;return {id:row.assetId,title:m.title,kind:m.kind,mimeType:m.files[0].mime,pageCount:m.pageCount,size:m.files.reduce((n,f)=>n+f.size,0),createdAt:row.savedAt,shelfName:'端末のダウンロード',role:'viewer'};});
  return {shelves:catalog?.shelves??[],series:catalog?.series??[],playlists:catalog?.playlists??[],items:items.map(item=>({...item,offlineUnavailable:!playable.has(item.id),offlineStatus:playable.has(item.id)?'オフラインで利用できます':downloads.get(item.id)?.state==='ready'?'オフライン視聴期限切れ':downloads.has(item.id)?'ダウンロード未完了':'未ダウンロード · オンラインで保存してください'}))};
}

export function offlineSeriesContext(catalog,assetId){
  const item=catalog.items.find(i=>i.id===assetId),series=catalog.series.find(s=>s.id===item?.series?.id);
  if(!series)return {series:null,items:[],currentIndex:-1};
  const items=catalog.items.filter(i=>i.series?.id===series.id).sort((a,b)=>a.series.position-b.series.position);
  return {series,items,currentIndex:items.findIndex(i=>i.id===assetId)};
}

export function createCatalogCache(vault,{now=Date.now}={}){
  let generation=0,tail=Promise.resolve();
  return {
    load:partition=>vault.catalog(partition),
    save(partition,input,userId,{current=()=>true}={}){
      const own=++generation;
      const work=async()=>{const catalog=normalizeCatalog(input,userId);if(!current()||own!==generation)return null;
      const previous=await vault.catalog(partition).catch(()=>null);if(!current()||own!==generation)return null;
      await vault.saveCatalog(partition,catalog,userId);if(!current()||own!==generation)return null;
      // Prune only metadata/cover blobs absent from a COMPLETE new snapshot.
      const ids=new Set(catalog.items.map(i=>i.id));
      for(const item of previous?.items??[])if(!ids.has(item.id)&&current()&&own===generation)await vault.revoke(partition,coverSlot(item.id));
      return catalog;};
      const result=tail.catch(()=>{}).then(work);tail=result;return result;
    },
    async cover(partition,item){
      const saved=await vault.unseal(partition,coverSlot(item.id));
      if(!saved||saved.url!==item.thumbnailUrl||!['image/jpeg','image/png','image/webp'].includes(saved.mime)||typeof saved.base64!=='string'||saved.base64.length>2796204)return null;
      return new Blob([Uint8Array.from(atob(saved.base64),c=>c.charCodeAt(0))],{type:saved.mime});
    },
    async saveCover(partition,item,blob,{current=()=>true}={}){
      if(!current()||!blob?.size||blob.size>COVER_BYTES||!['image/jpeg','image/png','image/webp'].includes(blob.type)||!validCover(item,item.thumbnailUrl))return false;
      const bytes=new Uint8Array(await blob.arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
      if(!current())return false;
      await vault.seal(partition,coverSlot(item.id),{url:item.thumbnailUrl,mime:blob.type,base64:btoa(raw),savedAt:now()});return current();
    },
    async syncCovers(partition,catalog,fetchCover,{current=()=>true,force=false,onProgress=()=>{}}={}){
      const queue=[...catalog.items];let saved=0,failed=0,skipped=0,done=0;
      const active=()=>current();
      const worker=async()=>{while(queue.length&&active()){
        const item=queue.shift();try{
          const cached=await vault.unseal(partition,coverSlot(item.id));if(!active())break;
          if(!force&&cached?.url===item.thumbnailUrl&&cached.savedAt<=now()&&cached.savedAt>now()-COVER_AGE){skipped++;continue;}
          let blob;for(let attempt=0;attempt<3;attempt++){try{blob=await fetchCover(item,AbortSignal.timeout(force?30000:10000));break;}catch(error){if(!active()||attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,300*(attempt+1)));}}
          if(!active())break;
          if(await this.saveCover(partition,item,blob,{current:active}))saved++;else failed++;
        }catch{failed++;}finally{done++;if(active())onProgress({done,total:catalog.items.length,saved,failed,skipped});}
      }};
      await Promise.all(Array.from({length:2},worker));return {saved,failed,skipped,cancelled:!active()};
    }
  };
}
let cache;
export const offlineCatalog=()=>cache??=(offlineVault().then(createCatalogCache).catch(error=>{cache=null;throw error;}));
