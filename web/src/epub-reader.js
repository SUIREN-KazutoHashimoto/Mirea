import { api } from './api.js';
import { createBookChrome } from './book-viewer.js';
import { validateEpubBundle,renderEpubChapter,epubScreen,epubFraction } from './epub-core.js';

export function openEpub(container,item,onError,tracker,progress,downloaded,seriesNavigation) {
  const chrome=createBookChrome(container,{kind:'epub',total:item.pageCount,onError}),stage=chrome.stage,zoom=chrome.zoom;
  stage.classList.remove('image-stage');stage.classList.add('epub-stage');stage.setAttribute('aria-label','電子書籍の本文');
  const input=container.querySelector('.page-input'),previous=container.querySelector('.previous'),next=container.querySelector('.next');
  input.setAttribute('aria-label','章番号');zoom.setAttribute('aria-label','文字サイズ');
  zoom.options[0].textContent='標準の文字';zoom.options[1].textContent='文字 100%';zoom.options[2].textContent='文字 150%';zoom.options[3].textContent='文字 200%';
  let book,chapter=0,screen=0,count=1,ready=false,disposed=false,generation=0,viewport,flow,anchors=new Map(),resizeTimer,restartRequested=false;
  const controller=new AbortController(),urls=new Map();
  if(progress?.initial?.zoom)zoom.value=progress.initial.zoom;
  const scale=()=>zoom.value==='fit'?1:Number(zoom.value);
  const position=()=>ready?{page:chapter+1,scrollX:epubFraction(screen,count),scrollY:0,zoom:zoom.value}:null;
  progress?.bind(position);
  const stride=()=>viewport.clientWidth+48;
  function updateNext() {
    if(!ready||!book)return;
    const atEnd=chapter===book.chapters.length-1&&screen===count-1;
    next.disabled=atEnd&&!seriesNavigation?.canContinue;
    next.textContent=atEnd&&seriesNavigation?.canContinue?'次の作品 →':'→';
    next.setAttribute('aria-label',atEnd&&seriesNavigation?.canContinue?'次のアセットへ読み進む':'次のページ');
  }
  function publish() {
    if(!book||!ready)return;
    flow.style.transform=`translateX(${-screen*stride()}px)`;
    chrome.update({ready,page:chapter+1,total:book.chapters.length});
    input.value=String(chapter+1);input.max=String(book.chapters.length);
    container.querySelector('.page-total').textContent=`/ ${book.chapters.length}章`;
    container.querySelector('.book-percent').textContent=`${screen+1}/${count}ページ`;
    previous.disabled=chapter===0&&screen===0;
    const atEnd=chapter===book.chapters.length-1&&screen===count-1;
    updateNext();
    seriesNavigation?.bookState({ready,page:chapter+1,total:book.chapters.length,atEnd});
    progress?.capture();
  }
  const unsubscribeSeries=seriesNavigation?.subscribe(updateNext);
  function layout(fraction=epubFraction(screen,count)) {
    if(!flow||disposed)return;
    const width=viewport.clientWidth;
    flow.style.fontSize=`${scale()}em`;flow.style.columnWidth=`${width}px`;flow.style.transform='none';
    count=Math.max(1,Math.round((flow.scrollWidth+48)/(width+48)));
    screen=epubScreen(fraction,count);publish();tracker?.viewport('resize');
  }
  function imageUrl(index) {
    if(!urls.has(index)) {const resource=book.resources[index],bytes=Uint8Array.from(atob(resource.data),c=>c.charCodeAt(0));urls.set(index,URL.createObjectURL(new Blob([bytes],{type:resource.mime})));}
    return urls.get(index);
  }
  async function go(value,fraction=0,anchor='') {
    if(!book||disposed)return;
    progress?.capture();ready=false;tracker?.loading();const revision=++generation;
    chapter=Math.max(0,Math.min(book.chapters.length-1,value-1));screen=0;count=1;
    stage.replaceChildren();viewport=document.createElement('div');viewport.className='epub-viewport';flow=document.createElement('article');flow.className='epub-flow';flow.setAttribute('aria-label',book.chapters[chapter].title);viewport.append(flow);stage.append(viewport);
    const rendered=renderEpubChapter(book.chapters[chapter],{imageUrl,onLink:(target,hash)=>go(target+1,0,hash)});anchors=rendered.anchors;flow.append(rendered.fragment);
    flow.style.fontSize=`${scale()}em`;
    await Promise.all([...flow.querySelectorAll('img')].map(img=>img.decode().catch(()=>{})));
    await document.fonts.ready;
    if(disposed||revision!==generation)return;
    ready=true;layout(fraction);
    if(anchor&&anchors.has(anchor)) { const rect=anchors.get(anchor).getBoundingClientRect(),base=flow.getBoundingClientRect();screen=Math.max(0,Math.min(count-1,Math.floor((rect.left-base.left)/stride())));publish(); }
    // Analytics coordinates describe the visible fraction of the complete chapter.
    const geometry={getBoundingClientRect(){const rect=viewport.getBoundingClientRect(),width=count*stride()-48,left=rect.left-screen*stride();return {left,top:rect.top,right:left+width,bottom:rect.bottom,width,height:rect.height};}};
    tracker?.ready(chapter+1,geometry,viewport,scale());progress?.capture();
  }
  const navigate=async step=>{
    if(!ready)return;
    if(screen+step>=0&&screen+step<count){progress?.capture();screen+=step;publish();tracker?.viewport('page');}
    else if(chapter+step>=0&&chapter+step<book.chapters.length)await go(chapter+step+1,step<0?1:0);
    else if(step>0)await seriesNavigation?.nextBook();
  };
  const safely=fn=>Promise.resolve().then(fn).catch(error=>{if(!disposed&&error.name!=='AbortError')onError(error);});
  previous.onclick=()=>safely(()=>navigate(-1));next.onclick=()=>safely(()=>navigate(1));input.onchange=()=>safely(()=>go(Number(input.value)||1));
  zoom.onchange=()=>{progress?.capture();layout();tracker?.zoom(scale());};
  chrome.bind({go:page=>go(page),next:()=>navigate(1),previous:()=>navigate(-1),outline:()=>chrome.outline(book?.chapters.map((entry,index)=>({title:entry.title,go:()=>go(index+1)}))??[])});
  const observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>layout(),100);});observer.observe(stage);
  safely(async()=>{
    let data;
    if(downloaded){const response=await fetch(downloaded.url(0),{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('暗号化したEPUBを開けません。オンラインで開き直してください。');data=await response.json();}
    else data=await api(`/items/${item.id}/epub`,{signal:controller.signal});
    if(disposed)return;book=validateEpubBundle(data);chrome.direction.value=book.direction;
    await go(restartRequested?1:progress?.initial?.page??1,restartRequested?0:progress?.initial?.scrollX??0);stage.focus();
  });
  const cleanup=()=>{disposed=true;generation++;controller.abort();observer.disconnect();clearTimeout(resizeTimer);unsubscribeSeries?.();chrome.dispose();for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();stage.replaceChildren();book=null;};
  cleanup.restart=()=>{restartRequested=true;zoom.value='fit';safely(()=>go(1));};return cleanup;
}
