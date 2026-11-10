import {getSession,getEndpoint,isOfflineSession,authenticatedBlob} from './api.js';
import {readAiPack,saveAiPack,revokeAiPack,aiAuthorization,syncAiContent} from './ai-offline.js';
import {openAiSegmentEditor,openAiHidden} from './ai-segment-editor.js';
import {openAiEditHistory} from './ai-edit-history.js';
export const aiLabels={tags:'タグ付け',ocr:'本文・セリフ',transcript:'文字起こし',structure:'曲の構成',chapters:'動画の章',embedding:'意味検索の索引'};
export const aiStates={queued:'待機中',running:'解析中',paused:'一時停止',complete:'完了',partial:'一部未解析',failed:'失敗',cancelled:'取消','resource-wait':'準備待ち','dependency-wait':'前の解析待ち'};
const button=(label,action,className='button secondary')=>{const b=document.createElement('button');b.type='button';b.className=className;b.textContent=label;b.onclick=action;return b;};
export function aiIdentity(){const session=getSession();return {origin:getEndpoint(),userId:session?.user.id,token:session?.token};}
export function sameAiIdentity(identity){const now=aiIdentity();return identity.origin===now.origin&&identity.userId===now.userId&&identity.token===now.token;}
export async function loadAiContent(item,api,{signal}={}){
  const actor=aiIdentity();
  try{const authorization=await aiAuthorization(actor,item.id).catch(()=>null),pack=await api('/items/'+item.id+'/ai/pack',{signal,diagnostics:false});if(!sameAiIdentity(actor))throw new DOMException('Context changed','AbortError');await saveAiPack(actor,pack,authorization).catch(error=>{if(error.name==='AbortError')throw error;});return pack;}
  catch(error){if(!sameAiIdentity(actor)||signal?.aborted||error.name==='AbortError')throw error;if([401,403,404,423].includes(error.status)){await revokeAiPack(actor,item.id);throw error;}const pack=await readAiPack(actor,item.id);if(pack)return pack;throw error;}
}
export async function openAiAsset({item,api,dialog,esc,openAt}){
  const actor=aiIdentity(),node=dialog('タグ・内容','<div class="modal-body ai-asset"><p role="status">読み込んでいます…</p></div>','ai-modal');
  const panel=node.querySelector('.ai-asset'),controller=new AbortController(),valid=()=>node.isConnected&&sameAiIdentity(actor);
  node.addEventListener('close',()=>controller.abort(),{once:true});
  let info,feature='ocr',offset=0,busy=false,activeTab='tags';
  const status=document.createElement('p');status.className='ai-status';status.setAttribute('role','status');
  const error=e=>{if(valid())status.textContent=e.message;};
  async function load(){
    const pack=await loadAiContent(item,api,{signal:controller.signal});if(!valid())return;
    info=pack;info.canEdit=pack.canEdit??item.role!=='viewer';info.canAnalyze=pack.canAnalyze??info.canEdit;
    if(!info.features?.[feature])feature=Object.keys(info.features??{})[0]??'ocr';render();
  }
  async function action(work){if(busy||!valid())return;busy=true;try{await work();}catch(e){error(e);}finally{busy=false;}}
  function render(){
    panel.replaceChildren();const title=document.createElement('h3');title.textContent=item.title;panel.append(title,status);
    const tabs=document.createElement('div');tabs.className='ai-tabs';const tagPanel=document.createElement('section'),content=document.createElement('section');panel.append(tabs,tagPanel,content);
    const tagButton=button('タグ',()=>{activeTab='tags';tagPanel.hidden=false;content.hidden=true;}),contentButton=button('認識した内容',()=>{activeTab='content';tagPanel.hidden=true;content.hidden=false;});tabs.append(tagButton,contentButton);content.hidden=activeTab!=='content';tagPanel.hidden=activeTab!=='tags';
    for(const scope of ['shared','personal']){
      const form=document.createElement('form');form.className='ai-tag-form';const label=document.createElement('label');label.textContent=scope==='shared'?'共有タグ':'自分だけのタグ';
      const input=document.createElement('textarea');input.rows=2;input.maxLength=6000;input.placeholder='タグを改行で区切って入力';const existing=(info.tags??[]).filter(t=>t.scope===scope);
      input.value=existing.filter(t=>!t.rejected).map(t=>t.label).join('\n');label.append(input);form.append(label);
      if((scope==='personal'||info.canEdit)&&!isOfflineSession()){
        const save=button('タグを保存',()=>form.requestSubmit());form.append(save);
        form.onsubmit=e=>{e.preventDefault();action(async()=>{const value=await api('/items/'+item.id+'/ai/tags',{method:'PUT',body:{scope,revision:info.tagRevisions?.[scope]??0,tags:input.value.split(/[\n,、]/).map(s=>s.trim()).filter(Boolean),rejected:existing.filter(t=>t.rejected).map(t=>t.label)}});info.tags=value.tags;info.tagRevisions={...info.tagRevisions,[scope]:value.revision};status.textContent='タグを保存しました。';});};
      }else input.readOnly=true;
      tagPanel.append(form);
    }
    const hide=document.createElement('details'),hideTitle=document.createElement('summary');hideTitle.textContent='非表示にしたタグ';hide.append(hideTitle);
    for(const tag of (info.tags??[]).filter(t=>t.rejected)){const row=document.createElement('p');row.textContent=tag.label;if(!isOfflineSession()&&(tag.scope==='personal'||info.canEdit))row.append(button('再び表示',()=>action(async()=>{const existing=info.tags.filter(t=>t.scope===tag.scope);await api('/items/'+item.id+'/ai/tags',{method:'PUT',body:{scope:tag.scope,revision:info.tagRevisions[tag.scope],tags:[...existing.filter(t=>!t.rejected),tag].map(t=>t.label),rejected:existing.filter(t=>t.rejected&&t.id!==tag.id).map(t=>t.label)}});await load();})));hide.append(row);}tagPanel.append(hide);
    if(info.canEdit&&!isOfflineSession()){const generated=info.tags.filter(t=>t.scope==='shared'&&t.source==='ai'&&!t.rejected);if(generated.length)tagPanel.append(button('自動タグを採用して保持',()=>action(async()=>{const existing=info.tags.filter(t=>t.scope==='shared');await api('/items/'+item.id+'/ai/tags',{method:'PUT',body:{scope:'shared',revision:info.tagRevisions.shared,tags:existing.filter(t=>!t.rejected).map(t=>t.label),rejected:existing.filter(t=>t.rejected).map(t=>t.label),adopted:generated.map(t=>t.label)}});await load();status.textContent='採用したタグを再解析後も保持します。';})));}
    const select=document.createElement('select');select.setAttribute('aria-label','認識情報の種類');
    for(const name of Object.keys(info.features??{})){const option=new Option(aiLabels[name]??name,name);select.append(option);}select.value=feature;content.append(select);
    const resultList=document.createElement('div');resultList.className='ai-result-list';content.append(resultList);
    async function showResult(data){
      resultList.replaceChildren();if(!data){resultList.textContent='解析結果はまだありません。';return;}
      if(data.unresolved?.length){const review=document.createElement('details'),heading=document.createElement('summary');heading.textContent='対応する箇所が変わった訂正 '+data.unresolved.length+'件';review.append(heading);const help=document.createElement('p');help.textContent='以前の訂正は保持されていますが、現在の認識情報へ自動では適用していません。内容を確認し、必要なら現在の箇所を訂正してください。';review.append(help);for(const old of data.unresolved){const text=document.createElement('p');text.textContent=Array.isArray(old.edit)?old.edit.map(part=>part.label).join(' / '):old.edit.text??old.edit.label??old.id;review.append(text);if(info.canEdit&&!isOfflineSession())review.append(button('この旧訂正を確認済みにする',()=>{const confirm=dialog('以前の訂正を確認','<div class="modal-body"><p>現在の認識情報に対応していない訂正を外します。過去の訂正記録は保持します。</p><button class="button primary">確認済みにする</button></div>');confirm.querySelector('.primary').onclick=()=>action(async()=>{await api('/items/'+item.id+'/ai/'+feature,{method:'PATCH',body:{requestId:crypto.randomUUID(),revision:data.editRevision,resultRevision:data.revision,dropUnresolved:[old.id]}});confirm.close();await load();});}));}resultList.append(review);}
      if(data.provenance){const details=document.createElement('details'),heading=document.createElement('summary'),text=document.createElement('p');heading.textContent='解析した範囲・解析元';text.textContent=data.provenance.successfulUnits+'/'+data.provenance.totalUnits+'単位を解析 · '+(data.provenance.model?.name??'導入済みモデル')+(data.provenance.failedUnits?.length?' · 未解析分があります':'');details.append(heading,text);resultList.append(details);}
      const entries=[...data.result.blocks.map(row=>({row,kind:'blocks'})),...data.result.segments.map(row=>({row,kind:'segments'}))];
      if(data.result.summary){const summary=document.createElement('details'),heading=document.createElement('summary'),text=document.createElement('p');heading.textContent='内容の概要を表示';text.textContent=data.result.summary;summary.append(heading,text);resultList.append(summary);}
      for(const [entryIndex,{row,kind}]of entries.entries()){
        const article=document.createElement('article');article.className='ai-content-row';const place=row.page?row.page+'ページ':row.chapter!==undefined?(row.chapter+1)+'章':Math.floor(row.startMs/60000)+':'+String(Math.floor(row.startMs/1000)%60).padStart(2,'0');
        article.append(button(place,()=>{node.close();openAt?.(item,row);}));
        const text=document.createElement('p');text.textContent=row.text||row.label;article.append(text);
        if(info.canEdit&&!isOfflineSession())article.append(button('訂正',()=>kind==='segments'?action(()=>openAiSegmentEditor({item,feature,data,row,next:entries[entryIndex+1]?.kind==='segments'?entries[entryIndex+1].row:null,api,dialog,valid,onSaved:()=>reloadResult(data)})):editRow(data,row,kind)));
        resultList.append(article);
      }
      if(info.canEdit&&!isOfflineSession())resultList.append(button('訂正の履歴',()=>action(()=>openAiEditHistory({item,feature,data,api,dialog,valid,onSaved:()=>reloadResult(data)}))));
      if(info.canEdit&&!isOfflineSession())resultList.append(button('非表示にした箇所を確認',()=>action(()=>openAiHidden({item,feature,data,api,dialog,valid,onSaved:()=>reloadResult(data)}))));
      if(!entries.length&&!data.result.summary)resultList.append('この解析には表示する本文がありません。');
      if(data.hasMore)resultList.append(button('続きの結果を表示',()=>action(async()=>{offset=data.nextOffset??offset+20;const next=isOfflineSession()?(await readAiPack(actor,item.id,{feature,offset}))?.features[feature]:await api('/items/'+item.id+'/ai/'+feature+'?offset='+offset);await showResult(next);})));
    }
    select.onchange=()=>{feature=select.value;offset=0;showResult(info.features[feature]);};showResult(info.features?.[feature]);
    const actions=document.createElement('div');actions.className='ai-actions';panel.append(actions);
    if(!isOfflineSession())actions.append(button('解析情報を端末に保存',()=>action(async()=>{status.textContent='解析情報を保存しています…';await syncAiContent(actor,item.id,api,valid);status.textContent='解析情報を端末に保存しました。';})));
    if(info.canAnalyze&&!isOfflineSession())actions.append(button('解析・再解析を依頼',()=>requestAnalysis()));
    if(!isOfflineSession())actions.append(button('関連する作品',()=>action(async()=>{const found=await api('/items/'+item.id+'/ai/related'),modal=dialog('共通するタグの作品','<div class="modal-body ai-related"></div>'),box=modal.querySelector('.ai-related');if(!found.items.length)box.textContent='共通するタグの作品はまだありません。';for(const row of found.items){const open=button(row.title+' · 共通タグ: '+row.reason,()=>{modal.close();node.close();openAt?.(row.item);});box.append(open);}})));
    if(!isOfflineSession())actions.append(button('解析情報を書き出す',()=>action(async()=>{const blob=await authenticatedBlob('/api/v1/items/'+item.id+'/ai/export'),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='mirea-analysis.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);})));
    if(info.jobs?.length){const details=document.createElement('details'),heading=document.createElement('summary');heading.textContent='解析の状況';details.append(heading);for(const job of info.jobs){const row=document.createElement('p');row.textContent=(aiLabels[job.feature]??job.feature)+' · '+(aiStates[job.state]??job.state)+' · '+job.checkpoint+'/'+(job.totalUnits??'—');for(const [state,label]of [['paused','再開'],['failed','再試行'],['partial','未解析分を再試行']])if(job.state===state)row.append(button(label,()=>action(async()=>{await api('/ai/jobs/'+job.id+'/'+(state==='paused'?'resume':'retry'),{method:'POST'});await load();})));details.append(row);}panel.append(details);}
  }
  async function reloadResult(data){const value=await api('/items/'+item.id+'/ai/'+feature+'?offset='+(data.offset??0));if(!valid())return;info.features[feature]=value;render();}
  function editRow(data,row,kind){
    const modal=dialog('認識内容を訂正','<form class="modal-body ai-edit"><label>文字・説明<textarea name="text" rows="5" maxlength="16000"></textarea></label><label class="ai-check"><input type="checkbox" name="hidden">この箇所を非表示にする</label><p role="status"></p><button class="button primary">保存</button></form>');
    const form=modal.querySelector('form');form.elements.text.value=row.text??row.label??'';
    if(kind==='blocks'){const advanced=document.createElement('details');advanced.innerHTML='<summary>読む順序・認識領域を調整</summary><label>読む順序<input name="order" type="number" min="1" step="1"></label>';advanced.querySelector('[name=order]').value=(row.order??0)+1;if(row.box){for(const [index,title]of ['左端（%）','上端（%）','幅（%）','高さ（%）'].entries()){const label=document.createElement('label');label.textContent=title;const input=document.createElement('input');input.type='number';input.name='box'+index;input.min=index<2?'0':'.1';input.max='100';input.step='.1';input.value=(row.box[index]*100).toFixed(1);label.append(input);advanced.append(label);}}form.querySelector('button').before(advanced);}
    if(kind==='segments'){const label=document.createElement('label');label.textContent='区間の名前';const input=document.createElement('input');input.name='label';input.maxLength=160;input.value=row.label??'';label.append(input);form.prepend(label);for(const [name,title]of [['startMs','開始位置（秒）'],['endMs','終了位置（秒）']]){const label=document.createElement('label');label.textContent=title;const input=document.createElement('input');input.type='number';input.min='0';input.step='.001';input.name=name;input.value=String(row[name]/1000);label.append(input);form.prepend(label);}}
    form.onsubmit=e=>{e.preventDefault();action(async()=>{const patch={text:form.elements.text.value,hidden:form.elements.hidden.checked};if(kind==='blocks'){patch.order=Number(form.elements.order.value)-1;if(row.box)patch.box=[0,1,2,3].map(i=>Number(form.elements['box'+i].value)/100);}if(kind==='segments'){patch.label=form.elements.label.value;patch.startMs=Math.round(Number(form.elements.startMs.value)*1000);patch.endMs=Math.round(Number(form.elements.endMs.value)*1000);}
      try{const changed=await api('/items/'+item.id+'/ai/'+feature,{method:'PATCH',body:{requestId:crypto.randomUUID(),revision:data.editRevision,resultRevision:data.revision,patch:{[kind]:{[row.id]:patch}}}});modal.close();await reloadResult(data);}
      catch(error){form.querySelector('[role=status]').textContent=error.message;}
    });};
  }
  async function requestAnalysis(){
    const modal=dialog('解析を依頼','<form class="modal-body ai-request"><p>解析中も閲覧・再生を続けられます。訂正した内容は再解析後も保持されます。</p><div class="ai-feature-options"></div><label class="ai-check"><input name="regenerate" type="checkbox">解析済みの内容も作り直す</label><p role="status"></p><button class="button primary">依頼する</button></form>');const form=modal.querySelector('form'),options=form.querySelector('.ai-feature-options');
    const caps=await api('/ai/capabilities').catch(()=>null);if(!caps||!modal.isConnected)return;
    for(const f of info.availableFeatures??Object.keys(aiLabels)){const label=document.createElement('label');label.className='ai-check';const input=document.createElement('input');input.type='checkbox';input.name='feature';input.value=f;input.checked=(caps.availableFeatures??[]).includes(f);input.disabled=!input.checked;label.append(input,aiLabels[f]);options.append(label);}
    if(!caps.enabled||!caps.availableFeatures?.length){form.querySelector('[role=status]').textContent='管理者がAI機能とモデルを準備すると解析を依頼できます。';form.querySelector('.primary').disabled=true;}
    form.onsubmit=e=>{e.preventDefault();action(async()=>{try{await api('/items/'+item.id+'/ai/jobs',{method:'POST',body:{requestId:crypto.randomUUID(),features:[...form.querySelectorAll('[name=feature]:checked')].map(i=>i.value),regenerate:form.elements.regenerate.checked}});modal.close();await load();status.textContent='解析を受け付けました。';}catch(error){form.querySelector('[role=status]').textContent=error.message;}});};
  }
  try{await load();}catch(e){if(valid()){panel.replaceChildren(status);error(e);}}
}
