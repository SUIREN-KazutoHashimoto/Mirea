import { chunkKey,validateManifest } from './download-core.js';

let opening;
export function openDownloadDb(){
  return opening??=(new Promise((resolve,reject)=>{
    if(!globalThis.indexedDB)return reject(new Error('この環境では暗号化ダウンロードを保存できません。'));
    const request=indexedDB.open('mirea-encrypted-downloads-v1',1);
    request.onupgradeneeded=()=>{
      request.result.createObjectStore('packages',{keyPath:'key'}).createIndex('partition','partition');
      request.result.createObjectStore('chunks',{keyPath:'key'}).createIndex('downloadId','downloadId');
    };
    request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(createDownloadStore(request.result));};
    request.onerror=()=>reject(request.error);
  })).catch(error=>{opening=null;throw error;});
}
export function createDownloadStore(db){
  const run=(names,mode,fn)=>new Promise((resolve,reject)=>{
    const tx=db.transaction(names,mode);let value;
    tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error || new Error('ダウンロード保存が中断されました。'));
    try{fn(tx,result=>{value=result;});}catch(error){tx.abort();reject(error);}
  });
  const erase=(store,id)=>{
    const request=store.index('downloadId').openKeyCursor(IDBKeyRange.only(id));
    request.onsuccess=()=>{const cursor=request.result;if(cursor){store.delete(cursor.primaryKey);cursor.continue();}};
  };
  return {
    getPackage:key=>run(['packages'],'readonly',(tx,done)=>{const r=tx.objectStore('packages').get(key);r.onsuccess=()=>done(r.result);}),
    list:partition=>run(['packages'],'readonly',(tx,done)=>{const r=tx.objectStore('packages').index('partition').getAll(partition);r.onsuccess=()=>done(r.result);}),
    savePackage:(key,partition,manifest)=>run(['packages','chunks'],'readwrite',(tx,done)=>{
      validateManifest(manifest);const packages=tx.objectStore('packages'),r=packages.get(key);
      r.onsuccess=()=>{
        if(r.result?.manifest.id===manifest.id){done(r.result);return;}
        if(r.result)erase(tx.objectStore('chunks'),r.result.manifest.id);
        // Explicit fields only: never persist an open response or CryptoKey.
        const {id,assetId,version,algorithm,chunkSize,title,kind,pageCount}=manifest;
        const safe={id,assetId,version,algorithm,chunkSize,title,kind,pageCount,files:manifest.files.map(({index,number,size,mime,chunks,width,height})=>({index,number,size,mime,chunks,...(width?{width,height}:{})}))};
        const record={key,partition,assetId,manifest:safe,state:'downloading',savedAt:Date.now()};packages.put(record);done(record);
      };
    }),
    getChunk:(id,file,part)=>run(['chunks'],'readonly',(tx,done)=>{const r=tx.objectStore('chunks').get(chunkKey(id,file,part));r.onsuccess=()=>done(r.result);}),
    putChunk:(packageKey,id,file,part,bytes,sha256)=>run(['packages','chunks'],'readwrite',(tx,done)=>{
      const r=tx.objectStore('packages').get(packageKey);r.onsuccess=()=>{
        if(r.result?.manifest.id!==id){tx.abort();return;}
        tx.objectStore('chunks').put({key:chunkKey(id,file,part),downloadId:id,file,part,bytes,sha256});done(true);
      };
    }),
    count:id=>run(['chunks'],'readonly',(tx,done)=>{const r=tx.objectStore('chunks').index('downloadId').count(id);r.onsuccess=()=>done(r.result);}),
    complete:(key,id)=>run(['packages','chunks'],'readwrite',(tx,done)=>{
      const packages=tx.objectStore('packages'),r=packages.get(key);r.onsuccess=()=>{
        const row=r.result;if(row?.manifest.id!==id){tx.abort();return;}
        const count=tx.objectStore('chunks').index('downloadId').count(id);count.onsuccess=()=>{
          if(count.result!==row.manifest.files.reduce((n,f)=>n+f.chunks,0)){tx.abort();return;}
          row.state='ready';row.savedAt=Date.now();packages.put(row);done(row);
        };
      };
    }),
    remove:key=>run(['packages','chunks'],'readwrite',tx=>{
      const packages=tx.objectStore('packages'),r=packages.get(key);r.onsuccess=()=>{if(r.result)erase(tx.objectStore('chunks'),r.result.manifest.id);packages.delete(key);};
    })
  };
}
