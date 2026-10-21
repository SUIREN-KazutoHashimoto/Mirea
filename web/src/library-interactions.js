// Only deliberate horizontal gestures open navigation. Vertical scrolling,
// multi-touch, form controls and book/player gestures keep their own behavior.
export const drawerProgress=(opened,delta,width)=>Math.max(0,Math.min(1,(opened?1:0)+delta/Math.max(1,width)));
export function recentDrawerVelocity(samples,at){const recent=samples.filter(p=>p.at>=at-120);if(recent.length<2)return 0;const first=recent[0],last=recent.at(-1);return (last.x-first.x)/Math.max(1,last.at-first.at);}
export function settleDrawer(opened,delta,width,elapsed,velocity){
  const speed=velocity??(elapsed<=500?delta/Math.max(1,elapsed):0);
  if(Math.abs(delta)>=24&&Math.abs(speed)>=.55)return speed>0;
  return drawerProgress(opened,delta,width)>=.5;
}
export function mountLibraryDrawer({layout,panel,main,opener,closer,backdrop,actions,actionHome,native=false,doc=document,media=matchMedia('(max-width:760px)')}){
  const listeners=[],listen=(node,event,fn,options)=>{node.addEventListener(event,fn,options);listeners.push(()=>node.removeEventListener(event,fn,options));};
  let open=false,compact=false,start,locked=false,overflow,previousFocus,suppressUntil=0,suppressTarget;
  const focusables=()=>[...panel.querySelectorAll('button,a[href],input,select,[tabindex="0"]')].filter(n=>!n.disabled&&!n.hidden&&n.getClientRects().length);
  const blocked=()=>doc.querySelector('dialog[open],.viewer-screen:not([style*="display: none"])');
  const lock=()=>{if(locked)return;locked=true;overflow=doc.body.style.overflow;previousFocus=doc.activeElement;doc.body.style.overflow='hidden';};
  const unlock=()=>{if(!locked)return;locked=false;doc.body.style.overflow=overflow;};
  function clearDrag(){const initial=start;start=null;layout.classList.remove('drawer-dragging');layout.style.removeProperty('--drawer-reveal');if(initial?.dragging)try{layout.releasePointerCapture?.(initial.id);}catch{}}
  function close({restoreFocus=true}={}){
    const wasOpen=open;clearDrag();open=false;layout.classList.remove('drawer-open');main.inert=false;
    panel.inert=compact;panel.setAttribute('aria-hidden',String(compact));panel.removeAttribute('role');panel.removeAttribute('aria-modal');
    opener.setAttribute('aria-expanded','false');backdrop.hidden=true;unlock();
    if(wasOpen&&restoreFocus&&previousFocus?.isConnected)previousFocus.focus({preventScroll:true});
  }
  function show(){
    if(!compact||blocked())return;clearDrag();if(open)return;
    open=true;lock();main.inert=true;panel.inert=false;panel.setAttribute('aria-hidden','false');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
    layout.classList.add('drawer-open');backdrop.hidden=false;opener.setAttribute('aria-expanded','true');(closer||focusables()[0])?.focus({preventScroll:true});
  }
  function cancelDrag(){const opened=open;clearDrag();if(!opened){backdrop.hidden=true;unlock();}}
  function adapt(){
    close({restoreFocus:false});compact=native||media.matches;layout.classList.toggle('compact-library',compact);panel.inert=compact;
    panel.setAttribute('aria-hidden',String(compact));opener.hidden=!compact;closer.hidden=!compact;
    layout.style.setProperty('--drawer-width',(panel.getBoundingClientRect().width||330)+'px');
    for(const button of actions)(compact?panel.querySelector('.drawer-actions'):actionHome).append(button);
  }
  listen(opener,'click',show);listen(closer,'click',()=>close());listen(backdrop,'click',()=>close());
  listen(panel,'click',e=>{if(e.target.closest('button,a')&&e.target.closest('button')!==closer)close();},true);
  listen(doc,'keydown',e=>{
    if(e.key==='Escape'&&start){e.preventDefault();cancelDrag();return;}
    if(!open)return;
    if(e.key==='Escape'){e.preventDefault();close();return;}
    if(e.key!=='Tab')return;const nodes=focusables(),first=nodes[0],last=nodes.at(-1);
    if(!first){e.preventDefault();return;}if(e.shiftKey&&doc.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&doc.activeElement===last){e.preventDefault();first.focus();}
  });
  listen(layout,'pointerdown',e=>{
    if(!compact||e.isPrimary===false||e.button!==0||e.target.closest('input,select,textarea,[role="slider"],[contenteditable=true],.tabs')||blocked()){cancelDrag();return;}
    start={x:e.clientX,y:e.clientY,at:e.timeStamp,id:e.pointerId,opened:open,target:e.target,width:panel.getBoundingClientRect().width||330,samples:[{x:e.clientX,at:e.timeStamp}]};
  },{passive:true});
  listen(layout,'pointermove',e=>{
    if(!start)return;if(e.pointerId!==start.id){cancelDrag();return;}
    start.samples.push({x:e.clientX,at:e.timeStamp});start.samples=start.samples.filter(p=>p.at>=e.timeStamp-150);
    const dx=e.clientX-start.x,dy=Math.abs(e.clientY-start.y);
    if(!start.dragging){if(dy>12&&dy>Math.abs(dx)){cancelDrag();return;}if(Math.abs(dx)<10||Math.abs(dx)<=dy*1.5||(!open&&dx<0))return;
      start.dragging=true;layout.style.setProperty('--drawer-width',start.width+'px');lock();backdrop.hidden=false;layout.classList.add('drawer-dragging');try{layout.setPointerCapture?.(start.id);}catch{}
    }
    layout.style.setProperty('--drawer-reveal',String(drawerProgress(start.opened,dx,start.width)));e.preventDefault();
  },{passive:false});
  listen(layout,'pointercancel',cancelDrag);listen(layout,'lostpointercapture',()=>{if(start?.dragging)cancelDrag();});if(doc.defaultView)listen(doc.defaultView,'blur',cancelDrag);
  listen(layout,'pointerup',e=>{
    const initial=start;if(!initial||initial.id!==e.pointerId)return;
    if(initial.dragging){const destination=settleDrawer(initial.opened,e.clientX-initial.x,initial.width,e.timeStamp-initial.at,recentDrawerVelocity([...initial.samples,{x:e.clientX,at:e.timeStamp}],e.timeStamp));suppressUntil=Date.now()+650;suppressTarget=initial.target;clearDrag();destination?show():close();}else start=null;
  });
  listen(layout,'click',e=>{if(Date.now()<suppressUntil&&(e.target===suppressTarget||suppressTarget?.contains?.(e.target))){e.preventDefault();e.stopImmediatePropagation();}},true);
  if(doc.defaultView)listen(doc.defaultView,'resize',()=>{cancelDrag();layout.style.setProperty('--drawer-width',(panel.getBoundingClientRect().width||330)+'px');});
  listen(media,'change',adapt);adapt();
  return {show,close,isOpen:()=>open,dispose(){close({restoreFocus:false});listeners.forEach(remove=>remove());panel.inert=false;main.inert=false;}};
}
export function mountAssetHold(root,show,{doc=root.ownerDocument,delay=500,slop=12,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}={}){
  let timer,press,blocked,until=0;const listeners=[],listen=(node,event,fn,options)=>{node.addEventListener(event,fn,options);listeners.push(()=>node.removeEventListener(event,fn,options));};
  const cancel=()=>{clearTimer(timer);timer=null;press=null;};
  function trigger(button){cancel();if(!button?.isConnected)return;blocked=button;until=now()+1000;show(button.dataset.open);}
  listen(root,'pointerdown',e=>{cancel();if(e.button!==0||e.isPrimary===false)return;const button=e.target.closest('[data-open]');if(!button)return;press={id:e.pointerId,x:e.clientX,y:e.clientY,button};timer=setTimer(()=>trigger(button),delay);},{passive:true});
  listen(root,'pointermove',e=>{if(press&&(e.pointerId!==press.id||Math.hypot(e.clientX-press.x,e.clientY-press.y)>slop))cancel();},{passive:true});
  for(const name of ['pointerup','pointercancel','lostpointercapture','keydown'])listen(root,name,cancel);
  listen(doc,'visibilitychange',cancel);listen(doc.defaultView,'blur',cancel);
  listen(root,'click',e=>{if(e.detail!==0&&now()<until&&blocked?.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();blocked=null;}},true);
  listen(root,'keydown',e=>{if(e.key==='ContextMenu'||e.key==='F10'&&e.shiftKey){const button=e.target.closest('[data-open]');if(button){e.preventDefault();trigger(button);}}});
  listen(root,'contextmenu',e=>{const button=e.target.closest('[data-open]');if(!button)return;e.preventDefault();if(now()>=until||blocked!==button)trigger(button);});
  return {dispose(){cancel();listeners.forEach(remove=>remove());}};
}
