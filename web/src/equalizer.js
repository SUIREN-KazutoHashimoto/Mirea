export const EQ_FREQUENCIES=[60,230,910,3600,14000];
export const EQ_PRESETS={flat:{label:'フラット',gains:[0,0,0,0,0]},bass:{label:'低音を強調',gains:[6,3,0,-1,-2]},voice:{label:'声を聴きやすく',gains:[-3,-2,4,3,-2]},bright:{label:'高音を明瞭に',gains:[-2,-1,0,3,5]}};
const key='mirea.equalizer.v1';
export function equalizerSettings(value={}){return {enabled:value?.enabled===true,gains:EQ_FREQUENCIES.map((_,i)=>{const v=Number(value?.gains?.[i]);return Number.isFinite(v)?Math.round(Math.min(12,Math.max(-12,v))*2)/2:0;})};}
export function equalizerHeadroom(settings){return settings.enabled?10**(-settings.gains.reduce((n,v)=>n+Math.max(0,v),0)/20):1;}
export function createEqualizer(media,{Context=globalThis.AudioContext??globalThis.webkitAudioContext,storage}={}){
  let state;try{storage??=globalThis.localStorage;state=equalizerSettings(JSON.parse(storage?.getItem(key)??'{}'));}catch{state=equalizerSettings();}
  let context,source,input,filters=[],disposed=false,initializing;
  function update(){if(!context)return;const time=context.currentTime;input.gain.setTargetAtTime(equalizerHeadroom(state),time,.025);filters.forEach((filter,i)=>filter.gain.setTargetAtTime(state.enabled?state.gains[i]:0,time,.025));}
  async function prepare(){if(disposed)throw Error('プレイヤーは終了しています。');if(!Context)throw Error('このブラウザーではイコライザーを利用できません。');
    context??=new Context();await context.resume();if(context.state!=='running')throw Error('再生ボタンを押してから、もう一度有効にしてください。');if(disposed)return;
    if(!source){input=context.createGain();filters=EQ_FREQUENCIES.map(f=>{const node=context.createBiquadFilter();node.type='peaking';node.frequency.value=f;node.Q.value=.8;return node;});source=context.createMediaElementSource(media);source.connect(input);let tail=input;for(const node of filters){tail.connect(node);tail=node;}tail.connect(context.destination);}
    update();
  }
  const resume=()=>{if(state.enabled||source){initializing??=prepare().finally(()=>initializing=null);initializing.catch(()=>{});}};
  media.addEventListener('play',resume);media.addEventListener('playing',resume);
  return {get settings(){return {enabled:state.enabled,gains:[...state.gains]};},async set(value){state=equalizerSettings(value);try{storage?.setItem(key,JSON.stringify(state));}catch{/* The current player still keeps its settings. */}if(state.enabled||source)await prepare();return state;},dispose(){disposed=true;media.removeEventListener('play',resume);media.removeEventListener('playing',resume);source?.disconnect();input?.disconnect();filters.forEach(n=>n.disconnect());context?.close().catch(()=>{});}};
}
export function mountEqualizer(root,media,{doc=document}={}){
  const engine=createEqualizer(media),button=doc.createElement('button');button.type='button';button.className='player-equalizer';button.textContent='イコライザー';button.setAttribute('aria-haspopup','dialog');root.querySelector('.player-mode-controls').append(button);let modal;
  button.onclick=()=>{
    if(modal?.open){modal.focus();return;}
    modal=doc.createElement('dialog');modal.className='equalizer-dialog';modal.innerHTML=`<form method="dialog"><header><h2>イコライザー</h2><button class="eq-close" aria-label="閉じる">×</button></header><div class="eq-body"><label class="eq-toggle"><input class="eq-enabled" type="checkbox">有効にする</label><label>プリセット<select class="eq-preset"><option value="custom">カスタム</option>${Object.entries(EQ_PRESETS).map(([id,p])=>`<option value="${id}">${p.label}</option>`).join('')}</select></label><div class="eq-bands">${EQ_FREQUENCIES.map((f,i)=>`<label><span>${f>=1000?f/1000+' kHz':f+' Hz'}</span><input type="range" min="-12" max="12" step="0.5" data-eq-band="${i}" aria-label="${f} Hz"><output>0 dB</output></label>`).join('')}</div><p class="eq-status" role="status"></p><p class="eq-help">動画・音楽に共通で、この端末に保存します。音割れを抑えるため出力に余裕を持たせます。</p><button class="button secondary eq-reset" type="button">フラットに戻す</button></div></form>`;(doc.fullscreenElement??doc.body).append(modal);
    const panel=modal,enabled=panel.querySelector('.eq-enabled'),preset=modal.querySelector('.eq-preset'),ranges=[...modal.querySelectorAll('[data-eq-band]')],status=modal.querySelector('.eq-status');let serial=0;
    const render=()=>{const value=engine.settings;enabled.checked=value.enabled;ranges.forEach((r,i)=>{r.value=String(value.gains[i]);r.nextElementSibling.textContent=(value.gains[i]>0?'+':'')+value.gains[i]+' dB';});preset.value=Object.keys(EQ_PRESETS).find(id=>EQ_PRESETS[id].gains.every((v,i)=>v===value.gains[i]))??'custom';};
    async function apply(value){const generation=++serial;try{await engine.set(value);if(generation===serial&&panel.open)status.textContent=value.enabled?'イコライザーを適用中':'オフ';}catch(error){if(generation===serial&&panel.open)status.textContent=error.message;}render();}
    enabled.onchange=()=>apply({...engine.settings,enabled:enabled.checked});ranges.forEach((r,i)=>r.oninput=()=>{const value=engine.settings;value.gains[i]=Number(r.value);apply(value);});preset.onchange=()=>{if(EQ_PRESETS[preset.value])apply({...engine.settings,gains:EQ_PRESETS[preset.value].gains});};modal.querySelector('.eq-reset').onclick=()=>apply({...engine.settings,gains:EQ_PRESETS.flat.gains});modal.addEventListener('close',()=>{panel.remove();button.focus();},{once:true});render();modal.showModal();
  };
  return ()=>{modal?.close();modal?.remove();engine.dispose();button.remove();};
}
