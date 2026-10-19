import { api, authenticatedBlob } from './api.js';
import { bookPosition,restoreBookPosition } from './progress-core.js';
import { advanceBook } from './series-continuation.js';

export function openImageBook(container, item, onError, tracker, progress, downloaded, seriesNavigation) {
  container.innerHTML = `<div class="pdf-toolbar image-toolbar"><button class="icon-button previous" aria-label="前のページ">←</button>
    <label><input class="page-input" type="number" min="1" value="1" aria-label="ページ番号"> <span class="page-total">/ ${item.pageCount}</span></label>
    <button class="icon-button next" aria-label="次のページ">→</button><span class="toolbar-divider"></span>
    <label class="sr-only" for="image-zoom">表示倍率</label><select id="image-zoom"><option value="fit">幅に合わせる</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select></div>
    <div class="image-stage" tabindex="0" aria-label="画像の本"><p class="image-loading" role="status">ページを読み込んでいます…</p><img class="image-page" alt="1ページ目" hidden></div>`;
  const stage = container.querySelector('.image-stage');
  const image = container.querySelector('.image-page');
  const input = container.querySelector('.page-input');
  const previous = container.querySelector('.previous');
  const next = container.querySelector('.next');
  const zoom = container.querySelector('select');
  const loading = container.querySelector('.image-loading');
  let pages = [], current = 1, displayedPage=1, ready=false,disposed = false, request, objectUrl, generation = 0,restartRequested=false;
  const updateNext=()=>{
    const continues=ready && current===pages.length && seriesNavigation?.canContinue;
    next.disabled=!ready || (current===pages.length && !continues);
    next.textContent=continues?'次の作品 →':'→';next.setAttribute('aria-label',continues?'次のアセットへ読み進む':'次のページ');
  };
  const publishPage=()=>{seriesNavigation?.bookState({ready,page:current,total:pages.length});updateNext();};
  const unsubscribeSeries=seriesNavigation?.subscribe(updateNext);
  if(progress?.initial?.zoom)zoom.value=progress.initial.zoom;
  progress?.bind(()=>ready?bookPosition(stage,displayedPage,zoom.value):null);
  const manifestRequest = new AbortController();
  function resize() {
    const page = pages[current - 1];
    if (!page) return;
    const anchor=ready?bookPosition(stage,displayedPage,zoom.value):null;
    const scale = zoom.value === 'fit' ? Math.min(1, (stage.clientWidth - 40) / page.width) : Number(zoom.value);
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
      const blob = downloaded?await downloaded.pageBlob(pages[current-1].number,request.signal):await authenticatedBlob(pages[current - 1].url, request.signal);
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
  const keydown = event => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
    if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); go(current - 1); }
    if (['ArrowRight', 'PageDown'].includes(event.key)) { event.preventDefault(); advance(); }
  };
  container.addEventListener('keydown', keydown);
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  previous.disabled = next.disabled = true;
  (downloaded?Promise.resolve({pages:downloaded.pages}):api(`/items/${item.id}/pages`, { signal: manifestRequest.signal })).then(result => {
    if (disposed) return;
    pages = result.pages;
    input.max = pages.length;
    container.querySelector('.page-total').textContent = `/ ${pages.length}`;
    go(restartRequested?1:progress?.initial?.page??1,restartRequested?undefined:progress?.initial);
    stage.focus();
  }).catch(error => { if (!disposed) { loading.hidden = true; onError(error); } });
  const cleanup=() => {
    disposed = true;
    unsubscribeSeries?.();
    generation++;
    manifestRequest.abort();
    request?.abort();
    observer.disconnect();
    clearTimeout(scrollTimer); stage.removeEventListener('scroll',scroll);
    container.removeEventListener('keydown', keydown);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
  cleanup.restart=()=>{restartRequested=true;zoom.value='fit';go(1);};return cleanup;
}
