const collections=['shelves','items','series','playlists'];
const validTag=value=>typeof value==='string'&&/^[\x21-\x7e]{1,200}$/.test(value);
const validTime=value=>Number.isSafeInteger(value)&&value>0;
const rowIds=rows=>{if(!Array.isArray(rows)||rows.length>100000)return null;const ids=new Set();for(const row of rows){if(typeof row?.id!=='string'||ids.has(row.id))return null;ids.add(row.id);}return ids;};

// Conditional responses apply only to the exact, in-memory server snapshot.
// The encrypted offline catalog is deliberately lossy and is never a delta base.
export function applyCatalogResponse(previous,response,userId){
  if(response?.notModified){if(!previous||previous.userId!==userId||!validTag(response.etag)||response.etag!==previous.etag||!validTime(response.serverTime))return null;return {...previous,serverTime:response.serverTime};}
  if(response?.version!==1||response.userId!==userId||!validTime(response.serverTime))return null;
  if(!response.delta){if(collections.some(name=>!rowIds(response[name]??(name==='playlists'?[]:null))))return null;return response;}
  if(!previous||previous.userId!==userId||!validTag(response.etag)||!validTag(previous.etag)||response.baseEtag!==previous.etag)return null;
  const result={...previous,serverTime:response.serverTime,etag:response.etag};
  for(const name of collections){const change=response.delta[name],original=previous[name]??[];
    if(!change||!rowIds(change.upsert)||!Array.isArray(change.remove)||change.remove.length>100000||new Set(change.remove).size!==change.remove.length)return null;
    if(!change.upsert.length&&!change.remove.length&&!change.order){result[name]=original;continue;}
    const rows=new Map(original.map(row=>[row.id,row]));for(const id of change.remove){if(typeof id!=='string')return null;rows.delete(id);}for(const row of change.upsert)rows.set(row.id,row);if(rows.size>100000)return null;
    if(change.order){if(!Array.isArray(change.order)||change.order.length!==rows.size||new Set(change.order).size!==rows.size||change.order.some(id=>!rows.has(id)))return null;result[name]=change.order.map(id=>rows.get(id));}else result[name]=[...rows.values()];
  }
  return result;
}

export function createCatalogClient({request,scope}){
  let identity,previous,latest=0;
  return {
    async fetch({signal,current=()=>true,userId}={}){
      const ownScope=scope(),generation=++latest;if(identity!==ownScope){identity=ownScope;previous=null;}
      const base=previous,tag=validTag(base?.etag)?base.etag:null,valid=()=>current()&&identity===ownScope&&scope()===ownScope&&generation===latest&&!signal?.aborted;
      const check=()=>{if(!valid())throw new DOMException('一覧の取得を中止しました。','AbortError');};check();
      let response=await request(tag?'/library/catalog?delta=1':'/library/catalog',{signal,allowNotModified:true,...(tag?{headers:{'If-None-Match':tag}}:{})});check();
      let catalog=applyCatalogResponse(base,response,userId),unchanged=Boolean(response?.notModified);
      if(!catalog&&tag){response=await request('/library/catalog',{signal,allowNotModified:true});check();catalog=applyCatalogResponse(null,response,userId);unchanged=false;}
      if(!catalog)throw Error('一覧情報の差分を確認できません。もう一度更新してください。');previous=catalog;return {catalog,unchanged};
    },
    clear(){latest++;identity=undefined;previous=null;}
  };
}
