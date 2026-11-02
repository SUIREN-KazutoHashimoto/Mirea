import {brandMarkup} from './brand.js';
// Finite local animation; never adds a network request or an unbounded overlay.
export function showAppLaunch({native,doc=document,reduced=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}){
  const node=doc.createElement('div'),started=now();node.className='app-launch';node.setAttribute('role','status');node.setAttribute('aria-label','Mireaを起動しています');
  node.innerHTML=`<div class="app-launch-logo">${brandMarkup()}</div><span class="app-launch-line" aria-hidden="true"></span>`;doc.body.append(node);
  let finished=false,removeTimer,finishTimer;
  const remove=()=>{node.remove();clearTimer(removeTimer);};
  const finish=()=>{if(finished)return;finished=true;clearTimer(cap);clearTimer(finishTimer);node.classList.add('launch-ready');removeTimer=setTimer(remove,reduced?0:180);};
  const cap=setTimer(finish,1500);
  return ()=>{if(finished)return;clearTimer(finishTimer);finishTimer=setTimer(finish,Math.max(0,1000-(now()-started)));};
}
