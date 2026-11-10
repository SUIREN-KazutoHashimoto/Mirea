import {aiIdentity,sameAiIdentity} from './ai-ui.js';
import {readAiPack,saveAiPack,revokeAiPack,aiAuthorization} from './ai-offline.js';
import {isOfflineSession} from './api.js';
export function mountAiReader({body,item,api,dialog,openDetails,highlight}){
 const stage=body.querySelector('.book-stage'),surface=stage?.querySelector('canvas,.image-page');if(!stage||!surface)return()=>{};
 const actor=aiIdentity(),button=document.createElement('button'),layer=document.createElement('div'),note=document.createElement('p');
 button.type='button';button.className='icon-button ai-reader-toggle';button.textContent='文';button.title='認識した文字を表示';button.setAttribute('aria-label','認識した文字を表示');button.setAttribute('aria-pressed','false');
 (body.assetTools?.querySelector('.book-toolbar')??body.closest('.viewer-screen')?.querySelector('.book-toolbar')??body).append(button);
 layer.className='ai-reader-layer';note.className='ai-reader-status';note.setAttribute('role','status');stage.append(layer,note);
 let enabled=false,disposed=false,epoch=0,controller,blocks=[],page=Number(body.querySelector('.page-input')?.value)||1,ready=!surface.hidden,highlightUntil=Date.now()+8000;
 const current=()=>!disposed&&sameAiIdentity(actor);
 function layout(){
  layer.replaceChildren();if(!ready||!current())return;const a=surface.getBoundingClientRect(),b=stage.getBoundingClientRect();layer.style.left=(a.left-b.left+stage.scrollLeft-stage.clientLeft)+'px';layer.style.top=(a.top-b.top+stage.scrollTop-stage.clientTop)+'px';layer.style.width=a.width+'px';layer.style.height=a.height+'px';
  if(highlight?.page===page&&highlight.box&&Date.now()<highlightUntil){const mark=document.createElement('span');mark.className='ai-reader-highlight';position(mark,highlight.box);layer.append(mark);}
  if(enabled)for(const row of blocks){const mark=document.createElement('button');mark.type='button';mark.className='ai-reader-region';mark.title=row.text;mark.setAttribute('aria-label',row.text);position(mark,row.box??[0,0,1,1]);mark.onclick=()=>showText(row);layer.append(mark);}
 }
 function position(node,box){for(const [key,value]of [['left',box[0]],['top',box[1]],['width',box[2]],['height',box[3]]])node.style[key]=(value*100)+'%';}
 function showText(row){
  const modal=dialog('認識した文字','<div class="modal-body ai-recognized-text"><p></p><div class="ai-actions"></div></div>');modal.querySelector('p').textContent=row.text;
  const copy=document.createElement('button');copy.type='button';copy.className='button secondary';copy.textContent='文字をコピー';copy.onclick=async()=>{try{await navigator.clipboard.writeText(row.text);copy.textContent='コピーしました';}catch{copy.textContent='文字を選択してコピーしてください';}};modal.querySelector('.ai-actions').append(copy);
  const edit=document.createElement('button');edit.type='button';edit.className='button secondary';edit.textContent='タグ・内容から訂正';edit.onclick=()=>{modal.close();openDetails();};modal.querySelector('.ai-actions').append(edit);
 }
 async function load(){
  const generation=++epoch;controller?.abort();controller=new AbortController();blocks=[];layout();if(!enabled||!ready)return;note.textContent='認識した文字を読み込んでいます…';
  try{
   const unit=page-1;let pack;
   if(!isOfflineSession()){try{const authorization=await aiAuthorization(actor,item.id).catch(()=>null);pack=await api('/items/'+item.id+'/ai/pack?feature=ocr&offset='+unit,{signal:controller.signal,diagnostics:false});if(!current()||generation!==epoch)return;await saveAiPack(actor,pack,authorization).catch(error=>{if(error.name==='AbortError')throw error;});}catch(error){if([401,403,404,423].includes(error.status)){await revokeAiPack(actor,item.id);throw error;}if(error.status||controller.signal.aborted||error.name==='AbortError')throw error;}}
   if(!pack){const root=await readAiPack(actor,item.id);pack=root?.features?.ocr?.result.blocks.some(row=>row.page===page)?root:await readAiPack(actor,item.id,{feature:'ocr',offset:unit});}
   if(!current()||generation!==epoch)return;blocks=pack?.features?.ocr?.result.blocks.filter(row=>row.page===page)??[];note.textContent=blocks.length?'領域を選ぶと認識文字を確認・コピーできます。':'このページの認識文字はまだありません。';layout();
  }catch(error){if(current()&&generation===epoch&&error.name!=='AbortError')note.textContent=error.message;}
 }
 const change=event=>{page=event.detail.page;ready=event.detail.ready;if(!ready){epoch++;controller?.abort();blocks=[];layout();}else if(enabled)load();else layout();};
 body.addEventListener('mirea:book-page',change);button.onclick=()=>{enabled=!enabled;button.setAttribute('aria-pressed',String(enabled));note.hidden=!enabled;if(enabled)load();else{epoch++;controller?.abort();blocks=[];layout();}};
 note.hidden=true;const observer=new ResizeObserver(layout);observer.observe(surface);observer.observe(stage);const timer=setTimeout(layout,8100);layout();
 return()=>{disposed=true;epoch++;controller?.abort();clearTimeout(timer);observer.disconnect();body.removeEventListener('mirea:book-page',change);layer.remove();note.remove();button.remove();};
}
