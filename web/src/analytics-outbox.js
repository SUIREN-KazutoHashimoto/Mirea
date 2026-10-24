// Offline sessions can queue seven full days of detailed records. Never evict
// accepted local events merely because of age/count; report storage failure.

export function memoryStore() {
  const rows = new Map();
  return { async list() { return [...rows.values()]; }, async put(row) { rows.set(row.key, row); }, async remove(keys) { keys.forEach(key => rows.delete(key)); } };
}

export function openAnalyticsDatabase({factory=globalThis.indexedDB,ms=2500}={}){
  return new Promise((resolve,reject)=>{
    let settled=false;const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);};
    const timer=setTimeout(()=>fail(new Error('閲覧記録の保存領域を開けません。ほかのMireaタブを再読み込みしてください。')),ms);
    let request;try{request=factory.open('mirea-analytics-v1',2);}catch(error){fail(error);return;}
    request.onblocked=()=>fail(new Error('古いMireaタブが閲覧記録の保存領域を使用中です。'));
    request.onupgradeneeded=()=>{
      if(settled){request.transaction.abort();return;}
      let store;
      if(request.result.objectStoreNames.contains('events'))store=request.transaction.objectStore('events');
      else{store=request.result.createObjectStore('events',{keyPath:'key'});store.createIndex('partition','partition');store.createIndex('queuedAt','queuedAt');}
      if(!store.indexNames.contains('pending'))store.createIndex('pending',['partition','queuedAt']);
    };
    request.onsuccess=()=>{if(settled){request.result.close();return;}settled=true;clearTimeout(timer);request.result.onversionchange=()=>request.result.close();resolve(request.result);};request.onerror=()=>fail(request.error);
  });
}

export async function browserStore(partition) {
  if (!globalThis.indexedDB) return memoryStore();
  try {
    const db = await openAnalyticsDatabase();
    const transact = (mode, run) => new Promise((resolve, reject) => {
      const tx = db.transaction('events', mode), store = tx.objectStore('events');
      const request = run(store);
      tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    return {
      async list() { return transact('readonly', store => store.index('pending').getAll(IDBKeyRange.bound([partition,0],[partition,Number.MAX_SAFE_INTEGER]),400)); },
      put: row => transact('readwrite', store => store.put(row)),
      remove: keys => transact('readwrite', store => { keys.forEach(key => store.delete(key)); }),
      close: () => db.close()
    };
  } catch { return memoryStore(); }
}

export function createOutbox({ store, partition, send, now = Date.now, status = () => {} }) {
  let followup,writes = Promise.resolve(), running, stopped = false, retryAt = 0, failures = 0;
  const enqueue = (view, event) => {
    if (stopped) return;
    writes = writes.then(async () => {
      await store.put({ key: `${partition}|${event.id}`, partition, queuedAt: now(), view, event });
    }).catch(() => status('storage-unavailable'));
  };
  async function flush() {
    if (running) return running;
    clearTimeout(followup);
    if (stopped || now() < retryAt) return;
    running = (async () => {
      await writes;
      let rows = (await store.list()).filter(row=>row.partition===partition).sort((a,b) => a.queuedAt - b.queuedAt || a.event.seq - b.event.seq);
      const fullPage=rows.length>=400;
      // Bound work per flush; preserve single-view batches and <64 KiB request size.
      for (let batchNumber=0; rows.length && batchNumber<10 && !stopped; batchNumber++) {
        const view = rows[0].view, batch = [];
        for (const row of rows.filter(row => row.view.id === view.id)) {
          if (batch.length === 40 || JSON.stringify({ view, events: [...batch.map(r=>r.event),row.event] }).length > 58000) break;
          batch.push(row);
        }
        const response = await send({ view, events: batch.map(row=>row.event) });
        if (response.ok || [400,403,404,409,413,422].includes(response.status)) {
          await store.remove(batch.map(row=>row.key));
          if (!response.ok) status('batch-rejected');
          failures=0; retryAt=0;
        } else {
          failures++; retryAt=now()+Math.min(60000,1000*2**Math.min(failures,6)); status('pending'); break;
        }
        const keys = new Set(batch.map(row=>row.key)); rows = rows.filter(row=>!keys.has(row.key));
      }
      if(fullPage&&!stopped&&!retryAt)followup=setTimeout(()=>flush(),100);
    })().catch(() => { failures++; retryAt=now()+Math.min(60000,1000*2**Math.min(failures,6)); status('pending'); }).finally(() => { running=null; });
    return running;
  }
  return { enqueue, flush, async dispose() { stopped=true;clearTimeout(followup); await writes; await running; store.close?.(); } };
}
