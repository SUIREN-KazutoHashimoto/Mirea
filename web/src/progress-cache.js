// Small positions/revisions only, never credentials/media. Keep acknowledged
// positions as well as pending edits so offline cold starts can resume.
export function createProgressCache(storage,partition,assetId,{now=Date.now}={}){
  const key=`mirea.progress.v1|${partition}|${assetId}`;let ownedId;
  return {
    read(){try{const row=JSON.parse(storage.getItem(key));ownedId=row?.pending?.updateId;return row;}catch{return null;}},
    write(row){
      try{
        if(row){ownedId=row.pending?.updateId;storage.setItem(key,JSON.stringify({...row,at:now()}));}
        else{const current=JSON.parse(storage.getItem(key));if(!current||current.pending?.updateId===ownedId)storage.removeItem(key);}
      }catch{/* Callers retain in-memory retries when device storage is full. */}
    }
  };
}
