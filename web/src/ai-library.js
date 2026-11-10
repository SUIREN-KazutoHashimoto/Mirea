import {aiIdentity,sameAiIdentity,aiLabels} from './ai-ui.js';
import {offlineAiSearch} from './ai-offline.js';
import {isOfflineSession} from './api.js';
import {openAiTagDictionary} from './ai-tag-ui.js';
import {openAiJobs} from './ai-jobs-ui.js';
export function mountAiLibrary({root,api,dialog,esc,getScope,getItems,openAsset,openDetails,report}){
 const actor=aiIdentity(),toolbar=root.querySelector('.collection-tools'),grid=root.querySelector('#items'),caption=root.querySelector('.collection-caption');
 const button=document.createElement('button');button.type='button';button.className='button secondary ai-open-search';button.textContent='内容から探す';button.setAttribute('aria-expanded','false');toolbar.append(button);
 const section=document.createElement('section');section.className='ai-library';section.hidden=true;section.setAttribute('aria-label','タグ・内容で検索');grid.before(section);
 section.innerHTML='<form class="ai-search-form"><label>本文・セリフ・章・タグを検索<input name="query" type="search" maxlength="500" placeholder="覚えている言葉や内容"></label><label>タグで絞り込み<input name="tags" maxlength="1600" placeholder="複数はカンマで区切る"></label><label>タグの条件<select name="tagMode"><option value="all">すべてを含む</option><option value="any">いずれかを含む</option></select></label><label>検索方法<select name="mode"><option value="text">言葉が一致する作品</option><option value="semantic">内容が近い作品も探す</option></select></label><label class="ai-check"><input type="checkbox" name="spoilers">本文・章名の抜粋を表示</label><div class="ai-actions"><button class="button primary">検索</button><button type="button" class="button secondary ai-save-search">条件を保存</button><button type="button" class="button secondary ai-close-search">通常の一覧に戻る</button></div></form><div class="ai-saved-searches"></div><p class="ai-status" role="status"></p><div class="ai-search-results"></div><button class="button secondary ai-next" type="button" hidden>続きを表示</button>';
 const form=section.querySelector('form'),results=section.querySelector('.ai-search-results'),status=section.querySelector('[role=status]'),next=section.querySelector('.ai-next');
 let epoch=0,offset=0,scopeKey='',disposed=false,retryTimer,displayed=[],activeSaved,saved=[],selectedScope=null;
 const current=()=>!disposed&&sameAiIdentity(actor)&&root.isConnected;
 const stop=()=>{epoch++;clearTimeout(retryTimer);section.querySelector('.ai-use-semantic')?.remove();};
 const close=()=>{stop();section.hidden=true;grid.hidden=false;if(caption)caption.hidden=false;button.setAttribute('aria-expanded','false');next.hidden=true;};
 button.onclick=()=>{if(!section.hidden){close();return;}section.hidden=false;grid.hidden=true;if(caption)caption.hidden=true;button.setAttribute('aria-expanded','true');form.elements.query.focus();loadSaved();};
 section.querySelector('.ai-close-search').onclick=close;
 const organize=document.createElement('button');organize.type='button';organize.className='button secondary';organize.textContent='タグを整理';organize.disabled=isOfflineSession();organize.onclick=()=>openAiTagDictionary({shelfId:getScope().shelfId,api,dialog}).catch(report);section.querySelector('.ai-actions').append(organize);const jobs=document.createElement('button');jobs.type='button';jobs.className='button secondary';jobs.textContent='解析の状況';jobs.disabled=isOfflineSession();jobs.onclick=()=>openAiJobs({api,dialog,shelfId:getScope().shelfId}).catch(report);section.querySelector('.ai-actions').append(jobs);
 const criteria=()=>({query:form.elements.query.value,tags:form.elements.tags.value.split(/[,、\n]/).map(x=>x.trim()).filter(Boolean),tagMode:form.elements.tagMode.value,mode:form.elements.mode.value,scope:selectedScope??getScope()});
 function render(){
  results.replaceChildren();
  for(const row of displayed){const article=document.createElement('article');article.className='ai-search-card';const item=row.item??getItems().find(i=>i.id===row.assetId);
   const heading=document.createElement('h3'),open=document.createElement('button');open.type='button';open.className='ai-search-title';open.textContent=row.title;open.disabled=!item;open.onclick=()=>openAsset(item);heading.append(open);article.append(heading);const path=document.createElement('small');path.className='ai-search-path';path.textContent=[item?.shelfName,item?.series?.title].filter(Boolean).join(' / ')+(row.reason==='similarity'?' · 内容の近さから候補':'');article.append(path);
   for(const hit of row.hits??[]){const locator=hit.locator,where=locator.page?locator.page+'ページ':locator.chapter!==undefined?(locator.chapter+1)+'章':locator.startMs!==undefined?Math.floor(locator.startMs/60000)+':'+String(Math.floor(locator.startMs/1000)%60).padStart(2,'0'):'内容';
    const jump=document.createElement('button');jump.type='button';jump.className='button secondary';jump.textContent=where;jump.disabled=!item;jump.onclick=()=>openAsset(item,locator);article.append(jump);
    if(form.elements.spoilers.checked){const text=document.createElement('p');text.textContent=hit.text;article.append(text);}
   }
   const details=document.createElement('button');details.type='button';details.className='text-button';details.textContent='タグ・内容を見る';details.disabled=!item;details.onclick=()=>openDetails(item);article.append(details);results.append(article);
  }
 }
 async function loadSaved(){
  if(isOfflineSession())return;const requestScope=JSON.stringify(getScope()),generation=epoch;
  try{const value=await api('/ai/lists'+(getScope().shelfId?'?shelfId='+getScope().shelfId:''),{diagnostics:false});if(!current()||generation!==epoch||requestScope!==JSON.stringify(getScope())||section.hidden)return;saved=value.lists;const box=section.querySelector('.ai-saved-searches');box.replaceChildren();if(!saved.length)return;
   const select=document.createElement('select');select.setAttribute('aria-label','保存した検索条件');select.append(new Option('保存した条件を選ぶ',''));for(const list of saved)select.append(new Option(list.title,list.id));select.value=activeSaved?.id??'';box.append(select);
   select.onchange=()=>{activeSaved=saved.find(l=>l.id===select.value);selectedScope=activeSaved?.filter.scope??null;if(!activeSaved)return;form.elements.query.value=activeSaved.filter.query??'';form.elements.tags.value=(activeSaved.filter.tags??[]).join(', ');form.elements.mode.value=activeSaved.filter.mode??'text';form.elements.tagMode.value=activeSaved.filter.tagMode??'all';search(false,activeSaved.filter.scope);};
   for(const [text,work]of [['現在の条件で更新',()=>save(true)],['選んだ条件を削除',async()=>{if(!activeSaved)return;await api('/ai/lists/'+activeSaved.id,{method:'DELETE'});activeSaved=null;await loadSaved();}]]){const b=document.createElement('button');b.type='button';b.className='button secondary';b.textContent=text;b.onclick=()=>Promise.resolve(work()).catch(error=>{if(current())status.textContent=error.message;});box.append(b);}
  }catch(error){if(current())status.textContent=error.message;}
 }
 async function fetchSearch(body){if(isOfflineSession())return offlineAiSearch(actor,body);try{return await api('/ai/search',{method:'POST',body,diagnostics:false});}catch(error){if(error.status||!current())throw error;return offlineAiSearch(actor,body);}}
 async function search(append=false,savedScope){
  stop();const generation=epoch;if(!append){offset=0;displayed=[];render();}status.textContent='内容を探しています…';next.hidden=true;
  const body={...criteria(),...(savedScope?{scope:savedScope}:{}),offset,limit:40};
  const apply=data=>{displayed=append?[...displayed,...data.items.filter(row=>!displayed.some(old=>old.assetId===row.assetId))]:data.items;offset=data.offset;render();next.hidden=!data.hasMore;next.disabled=Boolean(data.semanticPending);status.textContent=(displayed.length?displayed.length+'作品を表示':'条件に一致する作品はありません。')+(data.semanticPending?' · 意味の近い作品も探しています…':data.semanticPartial?' · 内容の近い候補は索引の一部から表示しています。言葉やタグでも絞り込めます。':body.mode==='semantic'&&!data.semantic?' · 今は言葉の一致で表示しています。':'');};
  try{
   const data=await fetchSearch(body);if(!current()||generation!==epoch)return;apply(data);
   if(data.semanticPending){
    let attempts=0;
    const poll=async()=>{if(!current()||generation!==epoch||section.hidden)return;try{const value=await fetchSearch(body);if(!current()||generation!==epoch)return;if(value.semantic){const choose=document.createElement('button');choose.type='button';choose.className='button secondary ai-use-semantic';choose.textContent='内容の近い候補も表示';choose.onclick=()=>{choose.remove();apply(value);};status.textContent=displayed.length+'作品を表示';status.after(choose);next.disabled=false;return;}if(value.semanticPending&&++attempts<90){retryTimer=setTimeout(poll,2000);return;}next.disabled=false;status.textContent=displayed.length+'作品を表示';}catch{if(current()&&generation===epoch){next.disabled=false;status.textContent=displayed.length+'作品を表示';}}};
    retryTimer=setTimeout(poll,1500);
   }
  }catch(error){if(current()&&generation===epoch)status.textContent=error.message;}
 }
 form.addEventListener('input',stop);form.onsubmit=e=>{e.preventDefault();search();};next.onclick=()=>search(true);form.elements.spoilers.onchange=render;
 async function save(update=false){
  if(update&&!activeSaved)return;
  const modal=dialog(update?'保存した検索条件を更新':'検索条件を保存','<form class="modal-body"><label>名前<input name="title" maxlength="120" required></label><p role="status"></p><button class="button primary">保存</button></form>'),f=modal.querySelector('form');
  f.elements.title.value=update?activeSaved.title:'';
  f.onsubmit=async e=>{e.preventDefault();try{const value=await api('/ai/lists'+(update?'/'+activeSaved.id:''),{method:update?'PATCH':'POST',body:{title:f.elements.title.value,filter:criteria(),...(update?{revision:activeSaved.revision}:{})}});activeSaved=value;modal.close();await loadSaved();}catch(error){f.querySelector('[role=status]').textContent=error.message;}};
 }
 section.querySelector('.ai-save-search').onclick=()=>save();
 return {contextChanged(){const key=JSON.stringify(getScope());if(scopeKey&&scopeKey!==key){activeSaved=null;selectedScope=null;saved=[];displayed=[];offset=0;form.reset();section.querySelector('.ai-saved-searches').replaceChildren();results.replaceChildren();status.textContent='';close();}scopeKey=key;},dispose(){disposed=true;stop();button.remove();section.remove();grid.hidden=false;if(caption)caption.hidden=false;}};
}
export async function openShelfAi({shelfId,api,dialog,esc}){
 const policy=await api('/shelves/'+shelfId+'/ai');
 const modal=dialog('本棚の解析','<form class="modal-body ai-shelf-policy"><p>有効にした後の新しい作品を自動で解析します。既存作品の解析は別に依頼できます。</p><label class="ai-check"><input name="enabled" type="checkbox">新しい作品を自動で解析する</label><div class="ai-feature-options"></div><p role="status"></p><button class="button primary">設定を保存</button><button type="button" class="button secondary ai-analyze-shelf">本棚内の既存作品も解析</button></form>');
 const form=modal.querySelector('form');form.elements.enabled.checked=policy.enabled;
 for(const [feature,label]of Object.entries(aiLabels)){const node=document.createElement('label');node.className='ai-check';const input=document.createElement('input');input.type='checkbox';input.name='feature';input.value=feature;input.checked=policy.features.includes(feature);node.append(input,label);form.querySelector('.ai-feature-options').append(node);}
 const features=()=>[...form.querySelectorAll('[name=feature]:checked')].map(i=>i.value);
 form.onsubmit=async e=>{e.preventDefault();try{const value=await api('/shelves/'+shelfId+'/ai',{method:'PUT',body:{enabled:form.elements.enabled.checked,features:features(),revision:policy.revision}});policy.revision=value.revision;form.querySelector('[role=status]').textContent='本棚の解析設定を保存しました。';}catch(error){form.querySelector('[role=status]').textContent=error.message;}};
 form.querySelector('.ai-analyze-shelf').onclick=async()=>{const b=form.querySelector('.ai-analyze-shelf');b.disabled=true;try{const result=await api('/ai/analyze',{method:'POST',body:{shelfId,features:features(),requestId:crypto.randomUUID()}});form.querySelector('[role=status]').textContent='対象 '+(result.total??'登録済み')+'作品の解析を受け付けました。';}catch(error){form.querySelector('[role=status]').textContent=error.message;}finally{b.disabled=false;}};
}
