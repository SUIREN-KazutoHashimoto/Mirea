import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { absoluteUrl, authHeaders } from './api.js';
import { bookPosition,restoreBookPosition } from './progress-core.js';
import { advanceBook } from './series-continuation.js';

GlobalWorkerOptions.workerSrc = workerUrl;

export async function openPdf(container, item, onError, tracker, progress, downloaded, seriesNavigation) {
  container.innerHTML = `<div class="pdf-toolbar"><button class="icon-button previous" aria-label="前のページ">←</button>
    <label><input class="page-input" type="number" min="1" value="1" aria-label="ページ番号"> <span class="page-total">/ …</span></label>
    <button class="icon-button next" aria-label="次のページ">→</button><span class="toolbar-divider"></span>
    <label class="sr-only" for="pdf-zoom">表示倍率</label><select id="pdf-zoom"><option value="fit">幅に合わせる</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select></div>
    <div class="pdf-stage" tabindex="0" aria-label="PDFの本"><p class="pdf-loading" role="status">PDFを読み込んでいます…</p><canvas aria-label="PDFのページ"></canvas></div>`;
  const stage = container.querySelector('.pdf-stage');
  const canvas = container.querySelector('canvas');
  const input = container.querySelector('.page-input');
  const previous = container.querySelector('.previous');
  const next = container.querySelector('.next');
  const zoom = container.querySelector('select');
  let pdf, task, current = Math.max(1,Math.min(item.pageCount,progress?.initial?.page??1)), displayedPage=current, ready=false, disposed = false, generation = 0;
  const updateNext=()=>{
    const continues=ready && current===pdf?.numPages && seriesNavigation?.canContinue;
    next.disabled=!ready || (current===pdf?.numPages && !continues);
    next.textContent=continues?'次の作品 →':'→';next.setAttribute('aria-label',continues?'次のアセットへ読み進む':'次のページ');
  };
  const publishPage=()=>{seriesNavigation?.bookState({ready,page:current,total:pdf?.numPages??item.pageCount});updateNext();};
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
    publishPage();
    tracker?.loading();
    const revision = ++generation;
    if (task) { task.cancel(); await task.promise.catch(() => {}); }
    const page = await pdf.getPage(current);
    if (disposed || revision !== generation) return;
    const base = page.getViewport({ scale: 1 });
    const scale = zoom.value === 'fit' ? Math.min((stage.clientWidth - 48) / base.width, 2) : Number(zoom.value);
    const viewport = page.getViewport({ scale: Math.max(0.2, scale) });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
        restoreBookPosition(stage,anchor);anchor=null;displayedPage=current;ready=true;
        tracker?.ready(current,canvas,stage,Math.max(0.2,scale));progress?.capture();publishPage();
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
  const onKey = e => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (['ArrowLeft','PageUp'].includes(e.key)) { e.preventDefault(); go(current - 1); }
    if (['ArrowRight','PageDown'].includes(e.key)) { e.preventDefault(); advance(); }
  };
  container.addEventListener('keydown', onKey);
  let resizeTimer;
  const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redraw, 100); });
  observer.observe(stage);
  load.promise.then(document => {
    if (disposed) return;
    pdf = document;
    container.querySelector('.pdf-loading').remove();
    input.max = pdf.numPages;
    container.querySelector('.page-total').textContent = `/ ${pdf.numPages}`;
    redraw();
  }).catch(error => { if (!disposed) onError(error); });
  const cleanup=() => { disposed = true; unsubscribeSeries?.();generation++; task?.cancel(); observer.disconnect(); clearTimeout(resizeTimer); clearTimeout(scrollTimer); stage.removeEventListener('scroll',scroll); container.removeEventListener('keydown',onKey); load.destroy(); };
  cleanup.restart=()=>{zoom.value='fit';go(1);};return cleanup;
}
