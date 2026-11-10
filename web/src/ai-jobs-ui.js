import {aiIdentity,sameAiIdentity,aiLabels,aiStates} from './ai-ui.js';
const errorLabels={AI_MODEL_NOT_READY:'解析モデルの準備を待っています。',AI_RESOURCE_WAIT:'空きメモリーや他の解析の終了を待っています。',AI_MEMORY_LIMIT:'解析に必要なメモリーが不足しています。',AI_TEMPORARY_LIMIT:'一時保存の予算を増やす必要があります。',AI_STORAGE_FULL:'保存先の空き容量が不足しています。',AI_RUNTIME_UNAVAILABLE:'実行エンジンの準備が必要です。',AI_MODEL_CORRUPT:'モデルの再検証が必要です。',AI_PARTIAL_RESULT:'未解析分を再試行できます。',AI_AUTHORITY_EXPIRED:'この作品の解析権限が変更されました。'};
const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.className='button secondary';b.textContent=text;b.onclick=fn;return b;};
export async function openAiJobs({api,dialog,shelfId}){
 const actor=aiIdentity(),node=dialog('解析の状況','<div class="modal-body ai-user-jobs"><p>作品の解析はサーバー側で続きます。画面を閉じても停止しません。</p><label>表示する状態<select><option value="active">待機・解析中・一時停止</option><option value="attention">失敗・一部未解析</option><option value="complete">完了</option><option value="">すべて</option></select></label><p role="status"></p><div class="ai-user-job-list"></div><div class="ai-actions ai-user-job-pager"></div><details><summary>一括依頼の登録状況</summary><div class="ai-user-batches"></div></details></div>','ai-modal');
 const panel=node.querySelector('.ai-user-jobs'),select=panel.querySelector('select'),status=panel.querySelector('[role=status]');let disposed=false,busy=false,offset=0,epoch=0,timer;
 const current=()=>!disposed&&node.isConnected&&sameAiIdentity(actor);
 async function refresh(){
  if(!current()||busy)return;busy=true;const generation=++epoch;
  try{
   const [data,batches]=await Promise.all([api('/ai/jobs?limit=50&offset='+offset+(select.value?'&state='+select.value:'')+(shelfId?'&shelfId='+shelfId:''),{diagnostics:false}),api('/ai/batches'+(shelfId?'?shelfId='+shelfId:''),{diagnostics:false})]);if(!current()||generation!==epoch)return;
   const list=panel.querySelector('.ai-user-job-list');list.replaceChildren();status.textContent=data.jobs.length?'':'この条件の解析はありません。';
   for(const job of data.jobs){const row=document.createElement('article');row.className='ai-user-job';const title=document.createElement('h3');title.textContent=job.title;const detail=document.createElement('p');detail.textContent=(aiLabels[job.feature]??job.feature)+' · '+(aiStates[job.state]??job.state)+' · '+job.checkpoint+'/'+(job.totalUnits??'—')+' · 経過 '+Math.floor(job.elapsedMs/60000)+'分'+(job.estimatedAt?' · '+new Date(job.estimatedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'ごろ完了見込み':'');row.append(title,detail);
    if(job.errorCode){const text=document.createElement('p');text.textContent=errorLabels[job.errorCode]??'解析が完了していません。再試行するか、管理者へ確認してください。';row.append(text);}
    const actions=document.createElement('div');actions.className='ai-actions';for(const [action,label]of ['queued','running','resource-wait','dependency-wait'].includes(job.state)?[['pause','一時停止'],['cancel','取消']]:job.state==='paused'?[['resume','再開'],['cancel','取消']]:['failed','partial'].includes(job.state)?[['retry','未解析分を再試行']]:[])actions.append(button(label,async()=>{if(!current())return;try{await api('/ai/jobs/'+job.id+'/'+action,{method:'POST'});await refresh();}catch(error){if(current())status.textContent=error.message;}}));row.append(actions);list.append(row);
   }
   const pager=panel.querySelector('.ai-user-job-pager');pager.replaceChildren();for(const [label,enabled,delta]of [['前へ',offset>0,-50],['次へ',data.hasMore,50]]){const b=button(label,()=>{offset+=delta;refresh();});b.disabled=!enabled;pager.append(b);}
   const group=panel.querySelector('.ai-user-batches');group.replaceChildren();if(!batches.batches.length)group.textContent='一括依頼はありません。';
   for(const batch of batches.batches){const row=document.createElement('p');row.textContent=new Date(batch.createdAt).toLocaleString()+' · 対象の登録 '+(batch.total-batch.waiting)+'/'+batch.total+(batch.failed?' · 登録失敗 '+batch.failed:'');for(const [action,label]of batch.state==='queued'?[['pause','登録を一時停止'],['cancel','残りの登録を取消']]:batch.state==='paused'?[['resume','登録を再開']]:batch.failed?[['retry','登録失敗分を再試行']]:[])row.append(button(label,async()=>{try{await api('/ai/batches/'+batch.id+'/'+action,{method:'POST'});await refresh();}catch(error){if(current())status.textContent=error.message;}}));group.append(row);}
  }catch(error){if(current())status.textContent=error.message;}finally{busy=false;}
 }
 select.onchange=()=>{offset=0;refresh();};node.addEventListener('close',()=>{disposed=true;epoch++;clearInterval(timer);},{once:true});await refresh();if(current())timer=setInterval(refresh,4000);
}
export async function openAiBatch({items,api,dialog}){
 const actor=aiIdentity(),assets=items.filter(item=>!item.pending);if(!assets.length)return;
 const caps=await api('/ai/capabilities');if(!sameAiIdentity(actor))return;
 const node=dialog('一覧の作品を解析','<form class="modal-body ai-request"><p class="ai-target-count"></p><div class="ai-feature-options"></div><label class="ai-check"><input name="regenerate" type="checkbox">解析済みの情報も作り直す</label><label class="ai-check"><input name="confirmed" type="checkbox" required>対象と内容を確認しました</label><p role="status"></p><button class="button primary">解析を依頼</button></form>','ai-modal'),form=node.querySelector('form'),status=form.querySelector('[role=status]');
 form.querySelector('.ai-target-count').textContent='現在の一覧に含まれる '+assets.length+'作品が対象です。登録完了後は画面を閉じても解析が続きます。';
 for(const feature of caps.availableFeatures??[]){const label=document.createElement('label');label.className='ai-check';const input=document.createElement('input');input.type='checkbox';input.name='feature';input.value=feature;input.checked=true;label.append(input,aiLabels[feature]);form.querySelector('.ai-feature-options').append(label);}
 if(!caps.enabled||!caps.availableFeatures?.length){status.textContent='管理者が解析を準備すると利用できます。手動タグと通常の検索は今から利用できます。';form.querySelector('.primary').disabled=true;}
 let busy=false,stamp='',requests=new Map();
 form.onsubmit=async event=>{event.preventDefault();if(busy||!sameAiIdentity(actor))return;const features=[...form.querySelectorAll('[name=feature]:checked')].map(i=>i.value),regenerate=form.elements.regenerate.checked,next=JSON.stringify({features,regenerate});if(stamp!==next){requests.clear();stamp=next;}busy=true;const b=form.querySelector('.primary');b.disabled=true;
  try{for(let offset=0;offset<assets.length;offset+=1000){if(!node.isConnected||!sameAiIdentity(actor))return;if(!requests.has(offset))requests.set(offset,crypto.randomUUID());await api('/ai/analyze',{method:'POST',body:{assetIds:assets.slice(offset,offset+1000).map(item=>item.id),features,regenerate,requestId:requests.get(offset)}});if(node.isConnected)status.textContent=Math.min(assets.length,offset+1000)+'/'+assets.length+'作品を登録しました。';}b.textContent='依頼しました';}
  catch(error){if(node.isConnected)status.textContent=error.message;b.disabled=false;}finally{busy=false;}
 };
}
