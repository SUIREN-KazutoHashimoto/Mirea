import {aiIdentity,sameAiIdentity} from './ai-ui.js';
import {readAiTimeline,saveAiTimeline,revokeAiPack,aiAuthorization} from './ai-offline.js';

export function mountAiPlayer({body,tools,item,video,api,openDetails}){
 const actor=aiIdentity(),controller=new AbortController(),title=item.kind==='audio'?'曲の構成':'動画の章';
 let disposed=false,loop=null,pack,expiryTimer,loading,segments=[];
 const current=()=>!disposed&&sameAiIdentity(actor);
 const button=document.createElement('button');
 button.type='button';button.className='icon-button ai-player-toggle';button.setAttribute('aria-label',title);button.title=title;
 button.innerHTML='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 4h16v16H4zM8 8h8M8 12h8M8 16h5"/></svg>';
 (body.querySelector('.player-mode-controls')??body.querySelector('.player-controls')??tools??body).append(button);
 const panel=document.createElement('section');panel.className='ai-player-panel';panel.hidden=true;panel.setAttribute('aria-label',title);body.append(panel);
 const markers=document.createElement('span');markers.className='ai-timeline-markers';markers.setAttribute('aria-hidden','true');body.querySelector('.player-scrubber')?.append(markers);
 const usable=()=>current()&&pack&&Date.now()<pack.localExpiresAt&&performance.now()<pack.monotonicExpires;
 const time=ms=>Math.floor(ms/60000)+':'+String(Math.floor(ms/1000)%60).padStart(2,'0');
 function clearLoop(){loop=null;panel.querySelector('.ai-loop-state')?.replaceChildren('区間リピートなし');}
 function expire(){
  clearLoop();pack=null;segments=[];markers.replaceChildren();
  panel.replaceChildren();const note=document.createElement('p');note.textContent='区間情報を更新するには、もう一度この画面を開いてください。';panel.append(note);
 }
 function paintMarkers(){
  markers.replaceChildren();if(!usable()||!Number.isFinite(video.duration)||video.duration<=0)return;
  const step=Math.max(1,Math.ceil(segments.length/250));
  for(let i=0;i<segments.length;i+=step){const row=segments[i];if(row.startMs<=0||row.startMs>=video.duration*1000)continue;const mark=document.createElement('i');mark.style.left=(row.startMs/(video.duration*10))+'%';markers.append(mark);}
 }
 const tick=()=>{if(!loop||!current())return;if(Date.now()>=loop.expires||performance.now()>=loop.monotonic){clearLoop();return;}if(!video.paused&&video.currentTime>=loop.end/1000-.03)video.currentTime=loop.start/1000;};
 const seeking=()=>{if(loop&&(video.currentTime<loop.start/1000-.3||video.currentTime>loop.end/1000+.3))clearLoop();};
 const end=event=>{if(!loop)return;if(!current()||Date.now()>=loop.expires||performance.now()>=loop.monotonic){clearLoop();return;}event.stopImmediatePropagation();video.currentTime=loop.start/1000;video.play().catch(()=>{});};
 video.addEventListener('timeupdate',tick);video.addEventListener('seeking',seeking);video.addEventListener('ended',end,true);video.addEventListener('durationchange',paintMarkers);
 function playSection(row){
  if(!usable()){expire();return;}clearLoop();video.currentTime=row.startMs/1000;video.play().catch(()=>{});
 }
 async function load(){
  panel.innerHTML='<p role="status">区間を読み込んでいます…</p>';
  try{
   const authorization=await aiAuthorization(actor,item.id).catch(()=>null);
   pack=await api('/items/'+item.id+'/ai/timeline',{signal:controller.signal,diagnostics:false});if(!current())return;
   await saveAiTimeline(actor,pack,authorization).catch(error=>{if(error.name==='AbortError')throw error;});
   pack={...pack,localExpiresAt:Date.now()+pack.expiresAt-pack.serverTime};
  }catch(error){
   if(!current())throw error;if([401,403,404,423].includes(error.status)){await revokeAiPack(actor,item.id);throw error;}
   pack=await readAiTimeline(actor,item.id);
  }
  if(!current())return;
  if(pack)pack.monotonicExpires=performance.now()+Math.max(0,pack.localExpiresAt-Date.now());
  panel.replaceChildren();const heading=document.createElement('h3');heading.textContent=title;panel.append(heading);
  const actions=document.createElement('div');actions.className='ai-actions';panel.append(actions);
  function action(label,run){const b=document.createElement('button');b.type='button';b.className='button secondary';b.textContent=label;b.onclick=run;return b;}
  const pin=action('固定',()=>{const pinned=panel.classList.toggle('ai-panel-pinned');pin.setAttribute('aria-pressed',String(pinned));pin.textContent=pinned?'固定を解除':'固定';});pin.setAttribute('aria-pressed','false');actions.append(pin);
  actions.append(action('閉じる',()=>{panel.hidden=true;button.setAttribute('aria-expanded','false');}));
  const state=document.createElement('p');state.className='ai-loop-state';state.textContent='区間リピートなし';state.setAttribute('role','status');panel.append(state);
  panel.append(action('区間リピートを解除',clearLoop));
  segments=Object.values(pack?.features??{}).flatMap(f=>f.result?.segments??[]).sort((a,b)=>a.startMs-b.startMs);paintMarkers();
  clearTimeout(expiryTimer);if(pack)expiryTimer=setTimeout(expire,Math.max(0,pack.localExpiresAt-Date.now()));
  if(!segments.length){const note=document.createElement('p');note.textContent='解析後に曲の構成や動画の章を選べます。';panel.append(note);}
  const chorus=segments.filter(row=>row.kind==='chorus'||row.label==='サビ');
  if(chorus.length)actions.append(action('次のサビへ',()=>playSection(chorus.find(row=>row.startMs>video.currentTime*1000+250)??chorus[0])));
  const range=document.createElement('details');range.className='ai-loop-range';
  range.innerHTML='<summary>区間の開始・終了を調整</summary><form><label>開始（秒）<input name="start" type="number" min="0" step="0.001" required></label><label>終了（秒）<input name="end" type="number" min="0.001" step="0.001" required></label><div class="ai-actions"><button type="button" data-at="start" class="button secondary">現在位置を開始に</button><button type="button" data-at="end" class="button secondary">現在位置を終了に</button><button class="button primary">この範囲をリピート</button></div><p role="status"></p></form>';
  const form=range.querySelector('form');form.elements.start.value='0';form.elements.end.value=String(segments[0]?.endMs/1000||video.duration||1);
  for(const input of [form.elements.start,form.elements.end])input.max=Number.isFinite(video.duration)?String(video.duration):'';
  range.querySelectorAll('[data-at]').forEach(b=>{b.onclick=()=>{form.elements[b.dataset.at].value=String(Math.round(video.currentTime*1000)/1000);};});
  function beginLoop(start,end,label){
   if(!usable()){expire();return false;}
   const duration=video.duration*1000;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||!Number.isFinite(duration)||end>Math.round(duration)){form.querySelector('[role=status]').textContent='開始と終了を、作品の再生時間内で指定してください。';return false;}
   loop={start,end,expires:pack.localExpiresAt,monotonic:pack.monotonicExpires};form.elements.start.value=String(start/1000);form.elements.end.value=String(end/1000);form.querySelector('[role=status]').textContent='';
   video.currentTime=start/1000;state.textContent=label+'をリピート中';video.play().catch(()=>{});return true;
  }
  form.onsubmit=e=>{e.preventDefault();beginLoop(Math.round(Number(form.elements.start.value)*1000),Math.round(Number(form.elements.end.value)*1000),'指定した範囲');};
  if(segments.length)panel.append(range);
  let count=0;const more=action('次の区間を表示',append);
  function append(){
   for(const row of segments.slice(count,count+100)){
    const container=document.createElement('div');container.className='ai-segment-row';
    const play=action(time(row.startMs)+' '+row.label,()=>playSection(row)),repeat=document.createElement('button');
    repeat.type='button';repeat.className='icon-button';repeat.innerHTML='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 7h12l-3-3m3 3v6M18 17H6l3 3m-3-3v-6"/></svg>';repeat.setAttribute('aria-label',row.label+'を区間リピート');
    repeat.onclick=()=>beginLoop(row.startMs,row.endMs,row.label);container.append(play,repeat);panel.append(container);
   }
   count+=100;more.hidden=count>=segments.length;panel.append(more);
  }
  append();panel.append(action('タグ・内容を確認・訂正',openDetails));
 }
 button.onclick=async()=>{
  panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));
  if(!panel.hidden&&!usable()&&!loading){loading=load().catch(error=>{if(current()){panel.replaceChildren();const status=document.createElement('p');status.textContent=error.message;panel.append(status);}}).finally(()=>{loading=null;});await loading;}
 };
 return()=>{disposed=true;controller.abort();clearTimeout(expiryTimer);loop=null;video.removeEventListener('timeupdate',tick);video.removeEventListener('seeking',seeking);video.removeEventListener('ended',end,true);video.removeEventListener('durationchange',paintMarkers);button.remove();panel.remove();markers.remove();};
}
