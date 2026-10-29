import {setPlayerIcon} from './player-icons.js';
export const EQ_FREQUENCIES=[25,40,63,100,160,250,400,630,1000,1600,2500,4000,6300,10000,16000];
const oldFrequencies=[60,230,910,3600,14000];
export const EQ_PRESETS={flat:{label:'フラット',gains:Array(15).fill(0)},bass:{label:'低音を強調',gains:[5,5,5,4,3,2,1,0,0,0,0,0,0,0,0]},voice:{label:'声を聴きやすく',gains:[-3,-3,-2,-2,-1,0,1,2,3,3,2,1,0,0,0]},bright:{label:'高音を明瞭に',gains:[0,0,0,0,0,0,0,0,0,1,2,3,4,4,3]}};
const key='mirea.equalizer.v2',clamp=v=>Number.isFinite(Number(v))?Math.round(Math.min(12,Math.max(-12,Number(v)))*2)/2:0;
function legacyGain(f,values){if(f<=oldFrequencies[0])return clamp(values[0]);for(let i=1;i<5;i++)if(f<=oldFrequencies[i]){const ratio=Math.log(f/oldFrequencies[i-1])/Math.log(oldFrequencies[i]/oldFrequencies[i-1]);return clamp(clamp(values[i-1])+ratio*(clamp(values[i])-clamp(values[i-1])));}return clamp(values[4]);}
export function equalizerSettings(value={}){const values=Array.isArray(value?.gains)?value.gains:[];return {enabled:value?.enabled===true,gains:EQ_FREQUENCIES.map((f,i)=>values.length===5?legacyGain(f,values):clamp(values[i]))};}
// Kept for settings clients. Band boosts no longer reduce global input gain.
export const equalizerHeadroom=()=>1;
export async function makePeakProtection(context){
 if(context.audioWorklet&&globalThis.AudioWorkletNode){try{await context.audioWorklet.addModule(new URL('./eq-limiter.js?no-inline',import.meta.url));return new AudioWorkletNode(context,'mirea-peak-limiter',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]});}catch{/* Use the browser's native dynamics protection when worklets are unavailable. */}}
 const limiter=context.createDynamicsCompressor();limiter.threshold.value=-.1;limiter.knee.value=0;limiter.ratio.value=20;limiter.attack.value=0;limiter.release.value=.08;
 const ceiling=context.createWaveShaper();ceiling.curve=Float32Array.from({length:2049},(_,i)=>(i/1024-1)*.999);limiter.connect(ceiling);
 return {input:limiter,connect:node=>ceiling.connect(node),disconnect(){limiter.disconnect();ceiling.disconnect();}};
}
export function createEqualizer(media,{Context=globalThis.AudioContext??globalThis.webkitAudioContext,storage,protection=makePeakProtection}={}){
 let state;try{storage??=globalThis.localStorage;state=equalizerSettings(JSON.parse(storage?.getItem(key)??storage?.getItem('mirea.equalizer.v1')??'{}'));}catch{state=equalizerSettings();}
 let context,source,filters=[],limiter,output,disposed=false,initializing;
 function update(){if(!context||!source)return;const time=context.currentTime;filters.forEach((filter,i)=>filter.gain.setTargetAtTime(state.enabled?state.gains[i]:0,time,.025));}
 async function prepare(){if(disposed)throw Error('プレイヤーは終了しています。');if(!Context)throw Error('このブラウザーではイコライザーを利用できません。');context??=new Context();await context.resume();if(context.state!=='running')throw Error('再生ボタンを押してから、もう一度有効にしてください。');if(disposed)return;
  if(!source){limiter??=await protection(context);if(disposed)return;if(!source){filters=EQ_FREQUENCIES.map(f=>{const node=context.createBiquadFilter();node.type='peaking';node.frequency.value=Math.min(f,context.sampleRate?context.sampleRate*.48:f);node.Q.value=1.4;return node;});output=context.createGain();source=context.createMediaElementSource(media);let tail=source;for(const node of filters){tail.connect(node);tail=node;}tail.connect(limiter.input??limiter);limiter.connect(output);output.connect(context.destination);}}
  update();
 }
 function ready(){initializing??=prepare().finally(()=>initializing=null);return initializing;}
 const resume=()=>{if(state.enabled||source)ready().catch(()=>{});};media.addEventListener('play',resume);media.addEventListener('playing',resume);
 return {get settings(){return {enabled:state.enabled,gains:[...state.gains]};},get output(){return output;},async set(value){state=equalizerSettings(value);try{storage?.setItem(key,JSON.stringify(state));}catch{}if(state.enabled||source)await ready();update();return state;},dispose(){disposed=true;media.removeEventListener('play',resume);media.removeEventListener('playing',resume);source?.disconnect();filters.forEach(n=>n.disconnect());limiter?.disconnect();output?.disconnect();context?.close().catch(()=>{});}};
}
export function mountEqualizer(root,media,{doc=document}={}){
 const engine=createEqualizer(media),button=doc.createElement('button');button.type='button';button.className='player-equalizer';setPlayerIcon(button,'equalizer','イコライザー');button.setAttribute('aria-haspopup','dialog');root.querySelector('.player-mode-controls').append(button);let modal;
 button.onclick=()=>{
  if(modal?.open){modal.focus();return;}
  modal=doc.createElement('dialog');modal.className='equalizer-dialog';modal.innerHTML=`<form method="dialog"><header><h2>イコライザー</h2><button class="eq-close" aria-label="閉じる">×</button></header><div class="eq-body"><label class="eq-toggle"><input class="eq-enabled" type="checkbox">有効にする</label><label>プリセット<select class="eq-preset"><option value="custom">カスタム</option>${Object.entries(EQ_PRESETS).map(([id,p])=>`<option value="${id}">${p.label}</option>`).join('')}</select></label><p class="eq-axis-description">低音 ← 周波数 → 高音 · ±12 dB</p><div class="eq-frequency-bank" tabindex="0" aria-label="周波数順の15帯域。横にスクロールできます"><div class="eq-bands">${EQ_FREQUENCIES.map((f,i)=>`<label><output>0 dB</output><input type="range" min="-12" max="12" step="0.5" data-eq-band="${i}" aria-label="${f} Hz" aria-orientation="vertical"><span>${f>=1000?f/1000+'k':f}<small>Hz</small></span></label>`).join('')}</div></div><p class="eq-status" role="status"></p><p class="eq-help">動画・音楽に共通で、この端末に保存します。大きな音のピークだけを保護し、帯域の増幅量による全体の音量低下を防ぎます。</p><button class="button secondary eq-reset" type="button">フラットに戻す</button></div></form>`;(doc.fullscreenElement??doc.body).append(modal);
  const panel=modal,enabled=panel.querySelector('.eq-enabled'),preset=panel.querySelector('.eq-preset'),ranges=[...panel.querySelectorAll('[data-eq-band]')],status=panel.querySelector('.eq-status');let serial=0;
  const render=()=>{const value=engine.settings;enabled.checked=value.enabled;ranges.forEach((r,i)=>{r.value=String(value.gains[i]);r.parentElement.querySelector('output').textContent=(value.gains[i]>0?'+':'')+value.gains[i]+' dB';});preset.value=Object.keys(EQ_PRESETS).find(id=>EQ_PRESETS[id].gains.every((v,i)=>v===value.gains[i]))??'custom';};
  async function apply(value){const generation=++serial;try{await engine.set(value);if(generation===serial&&panel.open)status.textContent=value.enabled?'イコライザーを適用中':'オフ';}catch(error){if(generation===serial&&panel.open)status.textContent=error.message;}render();}
  enabled.onchange=()=>apply({...engine.settings,enabled:enabled.checked});ranges.forEach((r,i)=>r.oninput=()=>{const value=engine.settings;value.gains[i]=Number(r.value);apply(value);});preset.onchange=()=>{if(EQ_PRESETS[preset.value])apply({...engine.settings,gains:EQ_PRESETS[preset.value].gains});};panel.querySelector('.eq-reset').onclick=()=>apply({...engine.settings,gains:EQ_PRESETS.flat.gains});panel.addEventListener('close',()=>{panel.remove();button.focus();},{once:true});render();panel.showModal();
 };
 return ()=>{modal?.close();modal?.remove();engine.dispose();button.remove();};
}
