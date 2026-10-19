const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
const abortError = () => new Error('アップロードをキャンセルしました。');
const transient = status => !status || [408, 409, 425, 429].includes(status) || status >= 500;

export function createResumableUpload({ endpoint, token, userId, unauthorized }, shelfId, files, title, onProgress) {
  const controller = new AbortController();
  const { signal } = controller;
  let xhr, uploadId, storageKey, cancelled = false;
  const headers = { Authorization: `Bearer ${token}` };
  const readSaved = () => { try { return JSON.parse(localStorage.getItem(storageKey)); } catch { return null; } };
  const save = value => { try { if (value) localStorage.setItem(storageKey, JSON.stringify(value)); else localStorage.removeItem(storageKey); } catch { /* private / full browser storage */ } };
  const sleep = ms => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); reject(abortError()); }
    signal.addEventListener('abort', abort, { once: true });
  });
  async function retry(work) {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortError();
      try { return await work(); } catch (error) {
        if (signal.aborted) throw abortError();
        if (attempt >= 3 || !transient(error.status)) throw error;
        await sleep(500 * 2 ** attempt + Math.random() * 200);
      }
    }
  }
  async function request(path, method = 'GET', body) {
    let response;
    try {
      response = await fetch(`${endpoint}/api/v1${path}`, {
        method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal, cache: 'no-store'
      });
    } catch { throw Object.assign(new Error('通信が途切れました。同じファイルを選んで再試行すると、受信済みの続きから送信します。'), { status: 0 }); }
    const result = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) unauthorized();
      throw Object.assign(new Error(result.error || 'アップロードに失敗しました。'), { status: response.status });
    }
    return result;
  }
  function sendPart(path, blob, sha256, completed, total) {
    return new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open('PUT', `${endpoint}/api/v1${path}`);
      xhr.timeout = 90_000;
      xhr.setRequestHeader('Authorization', headers.Authorization);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Chunk-SHA256', sha256);
      xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(99, Math.floor((completed + event.loaded) / total * 100))); };
      xhr.onload = () => {
        if (xhr.status === 204) return resolve();
        let result = {};
        try { result = JSON.parse(xhr.responseText); } catch { /* proxy HTML error */ }
        if (xhr.status === 401) unauthorized();
        reject(Object.assign(new Error(result.error || '分割データを送信できませんでした。再試行してください。'), { status: xhr.status }));
      };
      xhr.onerror = xhr.ontimeout = () => reject(Object.assign(new Error('通信が途切れました。同じファイルを選んで再試行できます。'), { status: 0 }));
      xhr.onabort = () => reject(abortError());
      xhr.send(blob);
    });
  }
  const promise = (async () => {
    files = Array.isArray(files) ? files : [files];
    // Small samples plus file metadata identify a reselected local file without
    // reading a multi-gigabyte video into memory. Every transferred part has its
    // own full SHA-256 integrity check. No credentials are persisted with uploads.
    const identities = [];
    for (const file of files) {
      const sample = new Blob([file.slice(0, 65536), file.slice(Math.max(0, file.size - 65536))]);
      identities.push([file.name, file.type, file.size, file.lastModified, await digest(await sample.arrayBuffer())]);
    }
    storageKey = `mirea.upload.${await digest(new TextEncoder().encode(JSON.stringify([endpoint, userId, shelfId, title, identities])))}`;
    if (signal.aborted) throw abortError();
    let state;
    const saved = readSaved();
    if (saved?.id && saved.expiresAt > Date.now()) {
      try { state = await retry(() => request(`/uploads/${saved.id}`)); }
      catch (error) { if (![404, 410].includes(error.status)) throw error; save(null); }
      if (state && ['failed', 'cancelled'].includes(state.state)) { state = null; save(null); }
    } else save(null);
    if (!state) {
      // Do not automatically retry creation: a lost response must not allocate
      // several server sessions. Individual parts and completion are idempotent.
      state = await request(`/shelves/${shelfId}/uploads`, 'POST', {
        title, files: files.map(file => ({ filename: file.name, mime: file.type, size: file.size }))
      });
      save({ id: state.id, expiresAt: state.expiresAt });
    }
    uploadId = state.id;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let completed = state.receivedBytes;
    onProgress(Math.min(99, Math.floor(completed / total * 100)));
    if (state.state === 'uploading') {
      for (const [fileIndex, file] of files.entries()) {
        const received = new Set(state.files[fileIndex].receivedParts);
        for (let partIndex = 0; partIndex < Math.ceil(file.size / state.chunkSize); partIndex++) {
          if (signal.aborted) throw abortError();
          const blob = file.slice(partIndex * state.chunkSize, Math.min(file.size, (partIndex + 1) * state.chunkSize));
          const sha256 = await digest(await blob.arrayBuffer());
          if (received.has(partIndex)) {
            // Metadata/samples are only a lookup key. Verify every skipped part
            // too, so a modified middle of a reselected file can never be mixed
            // with the previous upload's bytes.
            if (state.files[fileIndex].receivedHashes?.[partIndex] !== sha256) {
              save(null);
              await request(`/uploads/${uploadId}`, 'DELETE').catch(() => {});
              throw new Error('前回と異なるファイルです。再試行すると、新しいアップロードとして送信します。');
            }
            continue;
          }
          await retry(() => sendPart(`/uploads/${uploadId}/files/${fileIndex}/parts/${partIndex}`, blob, sha256, completed, total));
          completed += blob.size;
          onProgress(Math.min(99, Math.floor(completed / total * 100)));
        }
      }
      state = await retry(() => request(`/uploads/${uploadId}/complete`, 'POST'));
    }
    onProgress(100);
    while (state.state === 'processing') {
      await sleep(1500);
      state = await retry(() => request(`/uploads/${uploadId}`));
    }
    if (state.state !== 'complete' || !state.item) { save(null); throw new Error(state.error || 'コンテンツを保存できませんでした。'); }
    save(null);
    return { item: state.item };
  })().catch(error => {
    if (cancelled) throw abortError();
    throw error;
  });
  return { promise, abort() {
    cancelled = true;
    controller.abort();
    xhr?.abort();
    if (storageKey) save(null);
    if (uploadId) {
      // Independent of the aborted transfer signal. A job already committed as
      // an item is never deleted by this best-effort cancellation request.
      fetch(`${endpoint}/api/v1/uploads/${uploadId}`, { method: 'DELETE', headers, cache: 'no-store' }).catch(() => {});
    }
  } };
}
