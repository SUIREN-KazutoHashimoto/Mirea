import { chunkKey,validateManifest } from './download-core.js';

let opening;
export function openDownloadDb(){
  return opening??=openDownloadDatabase().catch(error=>{opening=null;throw error;});
}
// An older tab can hold a prior schema open indefinitely. Do not erase it or
// keep startup blank; reject this attempt and close any late-opened connection.
export function openDownloadDatabase({factory=globalThis.indexedDB,ms=2500}={}){
  return new Promise((resolve,reject)=>{
    if(!factory)return reject(new Error('この環境では暗号化ダウンロードを保存できません。'));
    let settled=false;const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);};
    const timer=setTimeout(()=>fail(new Error('端末の保存領域を開けません。ほかのMireaタブを閉じるか再読み込みして、もう一度お試しください。保存データは削除していません。')),ms);
    let request;try{request=factory.open('mirea-encrypted-downloads-v1',2);}catch(error){fail(error);return;}
    request.onblocked=()=>fail(new Error('ほかのMireaタブが保存領域の更新を待たせています。ほかのタブを再読み込みしてください。保存データは削除していません。'));
    request.onupgradeneeded=()=>{
      if(settled){request.transaction.abort();return;}
      if(!request.result.objectStoreNames.contains('packages'))request.result.createObjectStore('packages',{keyPath:'key'}).createIndex('partition','partition');
      if(!request.result.objectStoreNames.contains('chunks'))request.result.createObjectStore('chunks',{keyPath:'key'}).createIndex('downloadId','downloadId');
      if(!request.result.objectStoreNames.contains('vault'))request.result.createObjectStore('vault');
    };
    request.onsuccess=()=>{if(settled){request.result.close();return;}settled=true;clearTimeout(timer);request.result.onversionchange=()=>request.result.close();resolve(createDownloadStore(request.result));};
    request.onerror=()=>fail(request.error);
  });
}
export function createDownloadStore(db,{now=Date.now}={}){
  const run=(names,mode,fn)=>new Promise((resolve,reject)=>{
    const tx=db.transaction(names,mode);let value;
    tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error || new Error('ダウンロード保存が中断されました。'));
    try{fn(tx,result=>{value=result;});}catch(error){tx.abort();reject(error);}
  });
  const erase=(store,id)=>{
    const request=store.index('downloadId').openKeyCursor(IDBKeyRange.only(id));
    request.onsuccess=()=>{const cursor=request.result;if(cursor){store.delete(cursor.primaryKey);cursor.continue();}};
  };
  const candidate=(row,id)=>row?.pending?.manifest.id===id?row.pending:!row?.pending&&row?.manifest.id===id?row:null;
  const hasReader=(row,id)=>Object.values(row.readers??{}).some(reader=>reader.id===id&&reader.expiresAt>now());
  const collect=(chunks,row)=>{
    const readers=Object.fromEntries(Object.entries(row.readers??{}).filter(([,reader])=>reader.expiresAt>now()));
    if(Object.keys(readers).length)row.readers=readers;else delete row.readers;
    const removed=[],retired=[];
    for(const previous of row.retired??[]){if(hasReader(row,previous.id))retired.push(previous);else{erase(chunks,previous.id);removed.push(previous);}}
    if(retired.length)row.retired=retired;else delete row.retired;
    if(row.nativeReady&&!hasReader(row,row.manifest.id))erase(chunks,row.manifest.id);
    return removed;
  };
  const commit=(tx,packages,previous,row,nativeReady,done)=>{
    const ready={...row,state:'ready',savedAt:Date.now()};delete ready.pending;delete ready.nativeReady;
    ready.readers=previous.readers??{};ready.retired=(previous.retired??[]).filter(old=>old.id!==row.manifest.id);
    if(nativeReady)ready.nativeReady=true;
    if(previous.manifest.id!==row.manifest.id){
      if(hasReader(previous,previous.manifest.id))ready.retired.push({id:previous.manifest.id,assetId:previous.assetId});
      else erase(tx.objectStore('chunks'),previous.manifest.id);
    }
    collect(tx.objectStore('chunks'),ready);
    packages.put(ready);done(ready);
  };
  return {
    vaultGet:key=>run(['vault'],'readonly',(tx,done)=>{const r=tx.objectStore('vault').get(key);r.onsuccess=()=>done(r.result);}),
    vaultInit:(key,value)=>run(['vault'],'readwrite',(tx,done)=>{const s=tx.objectStore('vault'),r=s.get(key);r.onsuccess=()=>{if(r.result)done(r.result);else{s.put(value,key);done(value);}};}),
    vaultPut:(key,value)=>run(['vault'],'readwrite',tx=>{tx.objectStore('vault').put(value,key);}),
    vaultDelete:key=>run(['vault'],'readwrite',tx=>{tx.objectStore('vault').delete(key);}),
    getPackage:key=>run(['packages'],'readonly',(tx,done)=>{const r=tx.objectStore('packages').get(key);r.onsuccess=()=>done(r.result);}),
    list:partition=>run(['packages'],'readonly',(tx,done)=>{const r=tx.objectStore('packages').index('partition').getAll(partition);r.onsuccess=()=>done(r.result);}),
    // Readers in other tabs share these pins. The authorization deadline bounds
    // abandoned pins after a crash; a normal close releases them immediately.
    pinReader:(key,id,readerId,expiresAt)=>run(['packages','chunks'],'readwrite',(tx,done)=>{
      if(!Number.isFinite(expiresAt)||expiresAt<=now()){tx.abort();return;}
      const packages=tx.objectStore('packages'),r=packages.get(key);r.onsuccess=()=>{
        const row=r.result;if(!row){tx.abort();return;}collect(tx.objectStore('chunks'),row);
        if(!(row.state==='ready'&&row.manifest.id===id)&&!row.retired?.some(previous=>previous.id===id)){tx.abort();return;}
        row.readers={...row.readers,[readerId]:{id,expiresAt:Math.min(expiresAt,now()+7*86400000)}};packages.put(row);done(true);
      };
    }),
    releaseReader:(key,readerId)=>run(['packages','chunks'],'readwrite',(tx,done)=>{
      const packages=tx.objectStore('packages'),r=packages.get(key);r.onsuccess=()=>{
        const row=r.result;if(!row){done([]);return;}if(row.readers)delete row.readers[readerId];
        const removed=collect(tx.objectStore('chunks'),row);packages.put(row);done(removed);
      };
    }),
    collectExpired:partition=>run(['packages','chunks'],'readwrite',(tx,done)=>{
      const removed=[],r=tx.objectStore('packages').index('partition').openCursor(IDBKeyRange.only(partition));
      r.onsuccess=()=>{const cursor=r.result;if(!cursor){done(removed);return;}const row=cursor.value;
        if(Object.values(row.readers??{}).some(reader=>reader.expiresAt<=now())||(row.retired??[]).some(previous=>!hasReader(row,previous.id))){removed.push(...collect(tx.objectStore('chunks'),row));cursor.update(row);}
        cursor.continue();};
    }),
    savePackage:(key,partition,manifest)=>run(['packages','chunks'],'readwrite',(tx,done)=>{
      validateManifest(manifest);const packages=tx.objectStore('packages'),r=packages.get(key);
      r.onsuccess=()=>{
        const existing=r.result;
        if(existing&&(existing.partition!==partition||existing.assetId!==manifest.assetId)){tx.abort();return;}
        if(existing?.pending?.manifest.id===manifest.id){done(existing.pending);return;}
        if(existing?.pending&&!hasReader(existing,existing.pending.manifest.id))erase(tx.objectStore('chunks'),existing.pending.manifest.id);
        if(existing?.manifest.id===manifest.id){delete existing.pending;packages.put(existing);done(existing);return;}
        // Explicit fields only: never persist an open response or CryptoKey.
        const {id,assetId,version,algorithm,chunkSize,title,kind,pageCount}=manifest;
        const safe={id,assetId,version,algorithm,chunkSize,title,kind,pageCount,files:manifest.files.map(({index,number,size,mime,chunks,width,height,quality})=>({index,number,size,mime,chunks,...(width?{width,height}:{}),...(quality?{quality}:{})}))};
        const record={key,partition,assetId,manifest:safe,state:'downloading',savedAt:Date.now()};
        // Keep the last usable download visible until all replacement chunks
        // and its lease are saved. Closing/cancelling a transfer keeps both the
        // ready package and the resumable candidate, without exposing the latter.
        if(existing?.state==='ready')packages.put({...existing,pending:record});
        else{if(existing)erase(tx.objectStore('chunks'),existing.manifest.id);packages.put(record);}
        done(record);
      };
    }),
    getChunk:(id,file,part)=>run(['chunks'],'readonly',(tx,done)=>{const r=tx.objectStore('chunks').get(chunkKey(id,file,part));r.onsuccess=()=>done(r.result);}),
    putChunk:(packageKey,id,file,part,bytes,sha256)=>run(['packages','chunks'],'readwrite',(tx,done)=>{
      const r=tx.objectStore('packages').get(packageKey);r.onsuccess=()=>{
        if(!candidate(r.result,id)){tx.abort();return;}
        tx.objectStore('chunks').put({key:chunkKey(id,file,part),downloadId:id,file,part,bytes,sha256});done(true);
      };
    }),
    count:id=>run(['chunks'],'readonly',(tx,done)=>{const r=tx.objectStore('chunks').index('downloadId').count(id);r.onsuccess=()=>done(r.result);}),
    complete:(key,id)=>run(['packages','chunks'],'readwrite',(tx,done)=>{
      const packages=tx.objectStore('packages'),r=packages.get(key);r.onsuccess=()=>{
        const row=candidate(r.result,id);if(!row){tx.abort();return;}
        const count=tx.objectStore('chunks').index('downloadId').count(id);count.onsuccess=()=>{
          if(count.result!==row.manifest.files.reduce((n,f)=>n+f.chunks,0)){tx.abort();return;}
          commit(tx,packages,r.result,row,false,done);
        };
      };
    }),
    // Call only after the native bridge confirms a verified timed-media cache.
    // This references encrypted native storage; no media or keys enter this DB.
    completeNative:(key,id)=>run(['packages','chunks'],'readwrite',(tx,done)=>{
      const packages=tx.objectStore('packages'),r=packages.get(key);r.onsuccess=()=>{
        const row=candidate(r.result,id);if(!row||!['audio','video'].includes(row.manifest.kind)){tx.abort();return;}
        commit(tx,packages,r.result,row,true,done);
      };
    }),
    removePartition:partition=>run(['packages','chunks'],'readwrite',tx=>{
      const packages=tx.objectStore('packages'),r=packages.index('partition').openCursor(IDBKeyRange.only(partition));
      r.onsuccess=()=>{const cursor=r.result;if(cursor){erase(tx.objectStore('chunks'),cursor.value.manifest.id);if(cursor.value.pending)erase(tx.objectStore('chunks'),cursor.value.pending.manifest.id);for(const previous of cursor.value.retired??[])erase(tx.objectStore('chunks'),previous.id);cursor.delete();cursor.continue();}};
    }),
    remove:key=>run(['packages','chunks'],'readwrite',tx=>{
      const packages=tx.objectStore('packages'),r=packages.get(key);r.onsuccess=()=>{if(r.result){erase(tx.objectStore('chunks'),r.result.manifest.id);if(r.result.pending)erase(tx.objectStore('chunks'),r.result.pending.manifest.id);for(const previous of r.result.retired??[])erase(tx.objectStore('chunks'),previous.id);}packages.delete(key);};
    })
  };
}
