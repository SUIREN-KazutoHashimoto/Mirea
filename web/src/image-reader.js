import { api, authenticatedBlob } from './api.js';
import {createImagePageCache} from './image-page-cache.js';
import { bookPosition,restoreBookPosition } from './progress-core.js';
import { advanceBook } from './series-continuation.js';
import { createBookChrome, bookScale } from './book-viewer.js';
import { createReaderLoad } from './reader-load.js';

export function openImageBook(container, item, onError, tracker, progress, downloaded, seriesNavigation,prepared) {
  const chrome = createBookChrome(container, { kind: 'image-book', total: item.pageCount, onError });
  const stage = container.querySelector('.image-stage');
  const image = container.querySelector('.image-page');
  const input = container.querySelector('.page-input');
  const previous = container.querySelector('.previous');
  const next = container.querySelector('.next');
  const zoom = chrome.zoom;
  const loading = container.querySelector('.image-loading');
  let pageCache,quality='display';try{if(localStorage.getItem('mirea.book-image-quality')==='original')quality='original';}catch{}const prefetchStatus=document.createElement('span');prefetchStatus.className='book-prefetch-status';prefetchStatus.setAttribute('role','status');loading.after(prefetchStatus);
  let pages = [], current = 1, displayedPage=1, ready=false,disposed = false, request, objectUrl, generation = 0,restartRequested=false,completed=Boolean(progress?.initial?.completed),failedPage;
  const updateNext=()=>{
    const continues=ready && current===pages.length && seriesNavigation?.canContinue;
    next.disabled=!ready;
    next.textContent=continues?'次の作品 →':current===pages.length?'読了':'→';next.setAttribute('aria-label',continues?'次のアセットへ読み進む':current===pages.length?'読み終えた本にする':'次のページ');
  };
  const publishPage=()=>{chrome.update({ready,page:current,total:pages.length,completed});seriesNavigation?.bookState({ready,page:current,total:pages.length});updateNext();};
  const unsubscribeSeries=seriesNavigation?.subscribe(updateNext);
  if(progress?.initial?.zoom)zoom.value=progress.initial.zoom;
  progress?.bind(()=>{const position=ready?bookPosition(stage,displayedPage,zoom.value):null;return position?{...position,completed}:null;});
  const manifestRequest = new AbortController();
  const makeCache=()=>createImagePageCache({count:pages.length,load:(n,signal)=>{const page=pages[n-1],representation=quality==='display'&&page.displayUrl?'display':'original';if(!downloaded&&n===1&&prepared?.firstPage&&prepared.quality===representation){const first=prepared.firstPage;prepared.firstPage=null;return Promise.resolve(first);}return downloaded?downloaded.pageBlob(page.number,signal):authenticatedBlob(representation==='display'?page.displayUrl:page.url,signal);},onProgress:({ready,total,limited})=>{if(!disposed)prefetchStatus.textContent=ready===total?'全ページを先読みしました':`ページの先読み ${ready}/${total}${limited?' · 空き容量に応じて先読みを調整':''}`;}});
  if(!downloaded){const label=document.createElement('label'),select=document.createElement('select');label.className='book-image-quality';select.setAttribute('aria-label','画像の品質');select.innerHTML='<option value="display">表示用（通信量を節約）</option><option value="original">原本</option>';select.value=quality;label.append(select);chrome.displayOptions.append(label);select.onchange=()=>{quality=select.value;try{localStorage.setItem('mirea.book-image-quality',quality);}catch{}if(!pages.length||disposed)return;const anchor=bookPosition(stage,displayedPage,zoom.value);generation++;request?.abort();void pageCache?.dispose().catch(()=>{});if(warm)URL.revokeObjectURL(warm.url);warm=null;pageCache=makeCache();void go(displayedPage,anchor);pageCache.prefetch(displayedPage);};}
  function resize() {
    const page = pages[displayedPage - 1];
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
    // Keep the current page visible until its replacement has decoded.
    container.querySelector('.viewer-error')?.remove();
    try {
      const blob = await pageCache.get(current,request.signal);
      if (disposed || revision !== generation) return;
      const cached=warm?.number===current?warm:null;if(cached)warm=null;
      const nextUrl=cached?.url??URL.createObjectURL(blob),decoded=cached?.decoded??new Image();if(!cached)decoded.src=nextUrl;
      try{await(cached?.promise??decoded.decode());}catch(error){URL.revokeObjectURL(nextUrl);throw error;}
      if(disposed||revision!==generation){URL.revokeObjectURL(nextUrl);return;}
      const oldUrl=objectUrl;objectUrl=nextUrl;
      image.alt = `${current}ページ目`;
      image.src = objectUrl;
      if(oldUrl)URL.revokeObjectURL(oldUrl);
      loading.hidden=true;image.hidden=false;
      stage.scrollTop = 0;
      stage.scrollLeft = 0;
      displayedPage=current;failedPage=undefined;resize();restoreBookPosition(stage,anchor);ready=true;tracker?.ready(current,image,stage,image.clientWidth/pages[current-1].width);progress?.capture();publishPage();
      void warmNext(current+1,revision);
    } catch (error) {
      if (!disposed && revision === generation && error.name !== 'AbortError') { loading.hidden = true;failedPage=current;current=displayedPage;ready=Boolean(objectUrl);input.value=current;previous.disabled=current===1;publishPage();onError(Object.assign(error,{retry:()=>go(failedPage??current)})); }
    }
  }
  let warm;
  async function warmNext(number,revision){
    if(warm){URL.revokeObjectURL(warm.url);warm=null;}
    const page=pages[number-1];if(!page)return;const width=!downloaded&&quality==='display'&&page.displayUrl?page.displayWidth:page.width,height=!downloaded&&quality==='display'&&page.displayUrl?page.displayHeight:page.height;if(width*height>16_000_000)return;
    try{const blob=await pageCache.get(number,undefined,{foreground:false});if(disposed||revision!==generation)return;const url=URL.createObjectURL(blob),decoded=new Image();decoded.src=url;const promise=decoded.decode();warm={url,decoded,number,promise};await promise;}catch{/* Optional page predecode never interrupts reading. */}
  }
  previous.onclick = () => go(current - 1);
  const markComplete=(value=!completed)=>{if(!ready)return;completed=value;progress?.checkpoint();publishPage();};
  const advance=()=>{if(ready&&current===pages.length)markComplete(true);return advanceBook({ready,page:current,total:pages.length,go,continuation:seriesNavigation});};
  next.onclick = advance;
  input.onchange = () => go(Number.parseInt(input.value, 10) || 1);
  zoom.onchange = () => { resize(); tracker?.zoom(image.clientWidth/(pages[current-1]?.width || 1)); };
  let scrollTimer;
  const scroll = () => { if(ready)progress?.capture();clearTimeout(scrollTimer); scrollTimer=setTimeout(()=>tracker?.viewport(),150); };
  stage.addEventListener('scroll',scroll,{passive:true});
  chrome.bind({go,next:advance,previous:()=>go(current-1),complete:()=>markComplete(),outline:()=>chrome.outline([])});
  const retryOnline=()=>{if(failedPage&&!disposed)void go(failedPage);};window.addEventListener('online',retryOnline);
  const observer = new ResizeObserver(resize);
  observer.observe(stage,{box:'border-box'});
  previous.disabled = next.disabled = true;
  const initialLoad=createReaderLoad({onError(error){loading.hidden=true;onError(error);},onStart(){container.querySelector('.viewer-error')?.remove();loading.hidden=false;loading.textContent='本を開いています…';},load:async()=>{
    const result=downloaded?{pages:downloaded.pages}:prepared?.pages?prepared:await api(`/items/${item.id}/pages`, { signal: manifestRequest.signal });
    if (disposed) return;
    pages = result.pages;
    pageCache=makeCache();
    input.max = pages.length;
    container.querySelector('.page-total').textContent = `/ ${pages.length}`;
    go(restartRequested?1:progress?.initial?.page??1,restartRequested?undefined:progress?.initial);
    pageCache.prefetch(restartRequested?1:progress?.initial?.page??1);
    stage.focus();
  }});void initialLoad.run();
  const cleanup=() => {
    disposed = true;
    initialLoad.dispose();
    unsubscribeSeries?.();
    generation++;
    manifestRequest.abort();
    pageCache?.dispose().catch(()=>{});prefetchStatus.remove();
    request?.abort();
    observer.disconnect();
    clearTimeout(scrollTimer); stage.removeEventListener('scroll',scroll);
    window.removeEventListener('online',retryOnline);
    chrome.dispose();
    if (objectUrl) URL.revokeObjectURL(objectUrl);objectUrl=null;image.removeAttribute('src');
    if(warm)URL.revokeObjectURL(warm.url);warm=null;
  };
  cleanup.restart=()=>{restartRequested=true;completed=false;zoom.value='fit';go(1);};return cleanup;
}
