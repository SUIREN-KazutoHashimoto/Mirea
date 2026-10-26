// Session-only prefetch: media persisted here is encrypted; the non-exportable
// key lives only in this reader. Never award view/progress events for prefetch.
const DATABASE='mirea-image-prefetch-v1',STORE='pages';
function request(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function openStore(){
  if(!globalThis.indexedDB||!globalThis.crypto?.subtle)return null;
  const req=indexedDB.open(DATABASE,1);req.onupgradeneeded=()=>req.result.createObjectStore(STORE,{keyPath:'id'}).createIndex('createdAt','createdAt');
  return request(req);
}
function transaction(db,mode,work){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,mode);work(tx.objectStore(STORE));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
export function createImagePageCache({count,load,onProgress=()=>{},concurrency=4,memoryBytes=64*1024*1024,storage=openStore,cryptoApi=globalThis.crypto}){
  const session=cryptoApi?.randomUUID?.()??String(Math.random()),memory=new Map(),tasks=new Map(),queue=[],ready=new Set(),controllers=new Set();let used=0,running=0,disposed=false,diskFailed=false;
  const disk=Promise.resolve().then(storage).then(async db=>{if(!db){diskFailed=true;return null;}const key=await cryptoApi.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    // Discard day-old ciphertext, including leftovers after a crash. An unusually
    // long-lived reader can safely fetch an evicted page again.
    await transaction(db,'readwrite',store=>{const req=store.index('createdAt').openCursor(IDBKeyRange.upperBound(Date.now()-86400000));req.onsuccess=()=>{const cursor=req.result;if(cursor){cursor.delete();cursor.continue();}};});return {db,key};
  }).catch(()=>{diskFailed=true;return null;});
  function remember(n,blob){if(memory.has(n)){used-=memory.get(n).size;memory.delete(n);}if(blob.size>memoryBytes)return;while(used+blob.size>memoryBytes&&memory.size){const [old,value]=memory.entries().next().value;memory.delete(old);used-=value.size;}memory.set(n,blob);used+=blob.size;}
  async function read(n){const cached=memory.get(n);if(cached){memory.delete(n);memory.set(n,cached);return cached;}const target=await disk;if(!target)return null;const row=await request(target.db.transaction(STORE).objectStore(STORE).get(session+':'+n));if(!row)return null;const bytes=await cryptoApi.subtle.decrypt({name:'AES-GCM',iv:row.iv},target.key,row.bytes);return new Blob([bytes],{type:row.type});}
  async function save(n,blob){const target=await disk;if(!target||diskFailed||disposed)return;try{const iv=cryptoApi.getRandomValues(new Uint8Array(12)),bytes=await cryptoApi.subtle.encrypt({name:'AES-GCM',iv},target.key,await blob.arrayBuffer());if(!disposed)await transaction(target.db,'readwrite',store=>store.put({id:session+':'+n,createdAt:Date.now(),iv,bytes,type:blob.type}));}catch{diskFailed=true;}}
  function pump(){while(!disposed&&running<concurrency&&queue.length){const task=queue.shift();running++;const controller=new AbortController();controllers.add(controller);
      (async()=>{let blob=await read(task.n);if(disposed)throw new DOMException('Closed','AbortError');if(!blob){blob=await load(task.n,controller.signal);if(disposed)throw new DOMException('Closed','AbortError');await save(task.n,blob);}if(disposed)throw new DOMException('Closed','AbortError');remember(task.n,blob);ready.add(task.n);onProgress({ready:ready.size,total:count,limited:diskFailed});task.resolve(blob);})().catch(task.reject).finally(()=>{running--;controllers.delete(controller);tasks.delete(task.n);pump();});
    }}
  function get(n,signal){if(disposed||signal?.aborted)return Promise.reject(new DOMException('Closed','AbortError'));if(!Number.isInteger(n)||n<1||n>count)return Promise.reject(Error('ページ番号が不正です。'));let task=tasks.get(n);
    if(!task){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});task={n,resolve,reject,promise};tasks.set(n,task);queue.unshift(task);pump();}
    else{const index=queue.indexOf(task);if(index>=0){queue.splice(index,1);queue.unshift(task);}}
    if(!signal)return task.promise;return new Promise((resolve,reject)=>{const abort=()=>reject(new DOMException('Cancelled','AbortError'));signal.addEventListener('abort',abort,{once:true});task.promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
  }
  function prefetch(start=1){const order=Array.from({length:count},(_,n)=>n+1).sort((a,b)=>Math.abs(a-start)-Math.abs(b-start));for(const n of order){if(tasks.has(n))continue;let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});const task={n,resolve,reject,promise};tasks.set(n,task);queue.push(task);}pump();}
  async function dispose(){if(disposed)return;disposed=true;for(const c of controllers)c.abort();for(const task of queue.splice(0)){tasks.delete(task.n);task.reject(new DOMException('Closed','AbortError'));}await Promise.allSettled([...tasks.values()].map(t=>t.promise));memory.clear();used=0;const target=await disk;if(target){try{await transaction(target.db,'readwrite',store=>store.delete(IDBKeyRange.bound(session+':',session+':\uffff')));}finally{target.db.close();}}}
  return {get,prefetch,dispose,stats:()=>({ready:ready.size,total:count,memoryBytes:used,limited:diskFailed})};
}
