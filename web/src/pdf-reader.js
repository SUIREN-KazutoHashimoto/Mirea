import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { absoluteUrl, authHeaders } from './api.js';
import { bookPosition,restoreBookPosition } from './progress-core.js';
import { advanceBook } from './series-continuation.js';
import { createBookChrome, bookScale } from './book-viewer.js';

GlobalWorkerOptions.workerSrc = workerUrl;

export async function openPdf(container, item, onError, tracker, progress, downloaded, seriesNavigation) {
  const chrome = createBookChrome(container, { kind: 'pdf', total: item.pageCount, onError });
  const stage = container.querySelector('.pdf-stage');
  const canvas = container.querySelector('canvas');
  const input = container.querySelector('.page-input');
  const previous = container.querySelector('.previous');
  const next = container.querySelector('.next');
  const zoom = chrome.zoom;
  let pdf, task, current = Math.max(1,Math.min(item.pageCount,progress?.initial?.page??1)), displayedPage=current, ready=false, disposed = false, generation = 0;
  const updateNext=()=>{
    const continues=ready && current===pdf?.numPages && seriesNavigation?.canContinue;
    next.disabled=!ready || (current===pdf?.numPages && !continues);
    next.textContent=continues?'次の作品 →':'→';next.setAttribute('aria-label',continues?'次のアセットへ読み進む':'次のページ');
  };
  const publishPage=()=>{chrome.update({ready,page:current,total:pdf?.numPages??item.pageCount});seriesNavigation?.bookState({ready,page:current,total:pdf?.numPages??item.pageCount});updateNext();};
  const unsubscribeSeries=seriesNavigation?.subscribe(updateNext);
  let anchor=progress?.initial??{scrollX:0,scrollY:0};
  if(progress?.initial?.zoom)zoom.value=progress.initial.zoom;
  progress?.bind(()=>ready?bookPosition(stage,displayedPage,zoom.value):null);
  const load = getDocument({
    url: downloaded?downloaded.url(0):absoluteUrl(`/api/v1/items/${item.id}/content`),
    httpHeaders: downloaded?{}:authHeaders(),
    cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/',
    isEvalSupported: false,
    length: item.size,
    rangeChunkSize: 256 * 1024,
    disableStream: true,
    disableAutoFetch: true
  });
  async function render() {
    if (!pdf || disposed) return;
    progress?.capture();
    anchor=anchor??bookPosition(stage,displayedPage,zoom.value);
    ready=false;
    canvas.hidden=true;
    publishPage();
    tracker?.loading();
    const revision = ++generation;
    if (task) { task.cancel(); await task.promise.catch(() => {}); }
    const page = await pdf.getPage(current);
    if (disposed || revision !== generation) return;
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min(bookScale(base.width,base.height,stage.clientWidth,stage.clientHeight,zoom.value),Math.sqrt(16_000_000/(base.width*base.height*dpr*dpr)));
    stage.style.touchAction=zoom.value==='fit'?'pan-y pinch-zoom':'pan-x pan-y pinch-zoom';
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    input.value = current;
    previous.disabled = current === 1;
    updateNext();
    task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] });
    try {
      await task.promise;
      if (!disposed && revision === generation) {
        canvas.hidden=false;restoreBookPosition(stage,anchor);anchor=null;displayedPage=current;ready=true;
        tracker?.ready(current,canvas,stage,scale);progress?.capture();publishPage();
      }
    } catch (error) { if (error.name !== 'RenderingCancelledException' && !disposed) onError(error); }
  }
  const redraw = () => render().catch(error => { if (!disposed) onError(error); });
  const go = page => { progress?.capture(); ready=false;current = Math.max(1, Math.min(pdf?.numPages || 1, page)); anchor={scrollX:0,scrollY:0};redraw(); };
  previous.onclick = () => go(current - 1);
  const advance=()=>advanceBook({ready,page:current,total:pdf?.numPages??item.pageCount,go,continuation:seriesNavigation});
  next.onclick = advance;
  input.onchange = () => go(Number.parseInt(input.value, 10) || 1);
  zoom.onchange = () => { tracker?.zoom(zoom.value==='fit'?1:Number(zoom.value)); redraw(); };
  let scrollTimer;
  const scroll = () => { if(ready)progress?.capture();clearTimeout(scrollTimer); scrollTimer=setTimeout(()=>tracker?.viewport(),150); };
  stage.addEventListener('scroll',scroll,{passive:true});
  chrome.bind({go,next:advance,previous:()=>go(current-1),outline:async()=>{
    if(!pdf)return;
    const entries=[];
    const collect=(nodes,depth=0)=>{for(const entry of nodes??[]){if(entries.length>=200 || depth>8)break;if(entry.dest)entries.push({title:entry.title,go:async()=>{const dest=typeof entry.dest==='string'?await pdf.getDestination(entry.dest):entry.dest;if(!dest?.length)return;const index=typeof dest[0]==='number'?dest[0]:await pdf.getPageIndex(dest[0]);go(index+1);}});collect(entry.items,depth+1);}};
    collect(await pdf.getOutline());if(!disposed)chrome.outline(entries);
  }});
  let resizeTimer;
  const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redraw, 100); });
  observer.observe(stage,{box:'border-box'});
  load.promise.then(document => {
    if (disposed) return;
    pdf = document;
    container.querySelector('.pdf-loading').remove();
    input.max = pdf.numPages;
    container.querySelector('.page-total').textContent = `/ ${pdf.numPages}`;
    redraw();stage.focus();
  }).catch(error => { if (!disposed) onError(error); });
  const cleanup=() => { disposed = true; unsubscribeSeries?.();generation++; task?.cancel(); observer.disconnect(); clearTimeout(resizeTimer); clearTimeout(scrollTimer); stage.removeEventListener('scroll',scroll); chrome.dispose();load.destroy(); };
  cleanup.restart=()=>{zoom.value='fit';go(1);};return cleanup;
}
