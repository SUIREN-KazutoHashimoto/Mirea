import { api, authenticatedBlob } from './api.js';
import {createImagePageCache} from './image-page-cache.js';
import { bookPosition,restoreBookPosition } from './progress-core.js';
import { advanceBook } from './series-continuation.js';
import { createBookChrome, bookScale } from './book-viewer.js';

export function openImageBook(container, item, onError, tracker, progress, downloaded, seriesNavigation) {
  const chrome = createBookChrome(container, { kind: 'image-book', total: item.pageCount, onError });
  const stage = container.querySelector('.image-stage');
  const image = container.querySelector('.image-page');
  const input = container.querySelector('.page-input');
  const previous = container.querySelector('.previous');
  const next = container.querySelector('.next');
  const zoom = chrome.zoom;
  const loading = container.querySelector('.image-loading');
  let pageCache;const prefetchStatus=document.createElement('span');prefetchStatus.className='book-prefetch-status';prefetchStatus.setAttribute('role','status');loading.after(prefetchStatus);
  let pages = [], current = 1, displayedPage=1, ready=false,disposed = false, request, objectUrl, generation = 0,restartRequested=false;
  const updateNext=()=>{
    const continues=ready && current===pages.length && seriesNavigation?.canContinue;
    next.disabled=!ready || (current===pages.length && !continues);
    next.textContent=continues?'次の作品 →':'→';next.setAttribute('aria-label',continues?'次のアセットへ読み進む':'次のページ');
  };
  const publishPage=()=>{chrome.update({ready,page:current,total:pages.length});seriesNavigation?.bookState({ready,page:current,total:pages.length});updateNext();};
  const unsubscribeSeries=seriesNavigation?.subscribe(updateNext);
  if(progress?.initial?.zoom)zoom.value=progress.initial.zoom;
  progress?.bind(()=>ready?bookPosition(stage,displayedPage,zoom.value):null);
  const manifestRequest = new AbortController();
  function resize() {
    const page = pages[current - 1];
    if (!page) return;
    const anchor=ready?bookPosition(stage,displayedPage,zoom.value):null;
    const scale = bookScale(page.width,page.height,stage.clientWidth,stage.clientHeight,zoom.value);
    stage.style.touchAction=zoom.value==='fit'?'pan-y pinch-zoom':'pan-x pan-y pinch-zoom';
    image.style.width = `${Math.max(1, page.width * scale)}px`;
    if(anchor)restoreBookPosition(stage,anchor);
  }
  async function go(value,anchor={scrollX:0,scrollY:0}) {
    if (!pages.length || disposed) return;
    progress?.capture();ready=false;
    tracker?.loading();
    current = Math.max(1, Math.min(pages.length, value));
    const revision = ++generation;
    request?.abort();
    request = new AbortController();
    input.value = current;
    previous.disabled = current === 1;
    publishPage();
    loading.hidden = false;
    loading.textContent = `${current}ページ目を読み込んでいます…`;
    image.hidden = true;
    container.querySelector('.viewer-error')?.remove();
    try {
      const blob = await pageCache.get(current,request.signal);
      if (disposed || revision !== generation) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      image.onload = () => { if (!disposed && revision === generation) { loading.hidden = true; image.hidden = false; resize();restoreBookPosition(stage,anchor);displayedPage=current;ready=true;tracker?.ready(current,image,stage,image.clientWidth/pages[current-1].width);progress?.capture();publishPage(); } };
      image.onerror = () => { if (!disposed) onError(new Error('ページ画像を表示できません。')); };
      image.alt = `${current}ページ目`;
      image.src = objectUrl;
      stage.scrollTop = 0;
      stage.scrollLeft = 0;
      resize();
    } catch (error) {
      if (!disposed && revision === generation && error.name !== 'AbortError') { loading.hidden = true; onError(error); }
    }
  }
  previous.onclick = () => go(current - 1);
  const advance=()=>advanceBook({ready,page:current,total:pages.length,go,continuation:seriesNavigation});
  next.onclick = advance;
  input.onchange = () => go(Number.parseInt(input.value, 10) || 1);
  zoom.onchange = () => { resize(); tracker?.zoom(image.clientWidth/(pages[current-1]?.width || 1)); };
  let scrollTimer;
  const scroll = () => { if(ready)progress?.capture();clearTimeout(scrollTimer); scrollTimer=setTimeout(()=>tracker?.viewport(),150); };
  stage.addEventListener('scroll',scroll,{passive:true});
  chrome.bind({go,next:advance,previous:()=>go(current-1),outline:()=>chrome.outline([])});
  const observer = new ResizeObserver(resize);
  observer.observe(stage,{box:'border-box'});
  previous.disabled = next.disabled = true;
  (downloaded?Promise.resolve({pages:downloaded.pages}):api(`/items/${item.id}/pages`, { signal: manifestRequest.signal })).then(result => {
    if (disposed) return;
    pages = result.pages;
    pageCache=createImagePageCache({count:pages.length,load:(n,signal)=>downloaded?downloaded.pageBlob(pages[n-1].number,signal):authenticatedBlob(pages[n-1].url,signal),onProgress:({ready,total,limited})=>{if(!disposed)prefetchStatus.textContent=ready===total?'全ページを先読みしました':`ページの先読み ${ready}/${total}${limited?' · 空き容量に応じて先読みを調整':''}`;}});
    input.max = pages.length;
    container.querySelector('.page-total').textContent = `/ ${pages.length}`;
    go(restartRequested?1:progress?.initial?.page??1,restartRequested?undefined:progress?.initial);
    pageCache.prefetch(restartRequested?1:progress?.initial?.page??1);
    stage.focus();
  }).catch(error => { if (!disposed) { loading.hidden = true; onError(error); } });
  const cleanup=() => {
    disposed = true;
    unsubscribeSeries?.();
    generation++;
    manifestRequest.abort();
    pageCache?.dispose().catch(()=>{});prefetchStatus.remove();
    request?.abort();
    observer.disconnect();
    clearTimeout(scrollTimer); stage.removeEventListener('scroll',scroll);
    chrome.dispose();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
  cleanup.restart=()=>{restartRequested=true;zoom.value='fit';go(1);};return cleanup;
}
