// Only deliberate horizontal gestures open navigation. Vertical scrolling,
// multi-touch, form controls and book/player gestures keep their own behavior.
export function swipeDirection({x,y,at},{x:endX,y:endY,at:endAt},direction=1){
  const dx=(endX-x)*direction,dy=Math.abs(endY-y);
  return endAt-at<=900&&endAt>=at&&dx>=72&&dx>dy*1.8;
}
export function mountLibraryDrawer({layout,panel,main,opener,closer,backdrop,actions,actionHome,native=false,doc=document,media=matchMedia('(max-width:760px)')}){
  const listeners=[],listen=(node,event,fn,options)=>{node.addEventListener(event,fn,options);listeners.push(()=>node.removeEventListener(event,fn,options));};
  let open=false,compact=false,start,overflow,previousFocus,suppressUntil=0,suppressTarget;
  const focusables=()=>[...panel.querySelectorAll('button,a[href],input,select,[tabindex="0"]')].filter(n=>!n.disabled&&!n.hidden&&n.getClientRects().length);
  function close({restoreFocus=true}={}){
    if(!open)return;open=false;layout.classList.remove('drawer-open');main.inert=false;
    panel.inert=compact;panel.setAttribute('aria-hidden',String(compact));panel.removeAttribute('role');panel.removeAttribute('aria-modal');
    opener.setAttribute('aria-expanded','false');backdrop.hidden=true;doc.body.style.overflow=overflow;
    if(restoreFocus&&previousFocus?.isConnected)previousFocus.focus({preventScroll:true});
  }
  function show(){
    if(!compact||open||doc.querySelector('dialog[open],.viewer-screen:not([style*="display: none"])'))return;
    open=true;previousFocus=doc.activeElement;overflow=doc.body.style.overflow;doc.body.style.overflow='hidden';main.inert=true;panel.inert=false;
    panel.setAttribute('aria-hidden','false');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
    layout.classList.add('drawer-open');backdrop.hidden=false;opener.setAttribute('aria-expanded','true');(closer||focusables()[0])?.focus({preventScroll:true});
  }
  function adapt(){
    close({restoreFocus:false});compact=native||media.matches;layout.classList.toggle('compact-library',compact);panel.inert=compact;
    panel.setAttribute('aria-hidden',String(compact));opener.hidden=!compact;closer.hidden=!compact;
    for(const button of actions)(compact?panel.querySelector('.drawer-actions'):actionHome).append(button);
  }
  listen(opener,'click',show);listen(closer,'click',()=>close());listen(backdrop,'click',()=>close());
  listen(panel,'click',e=>{if(e.target.closest('button,a')&&e.target.closest('button')!==closer)close();},true);
  listen(doc,'keydown',e=>{
    if(!open)return;
    if(e.key==='Escape'){e.preventDefault();close();return;}
    if(e.key!=='Tab')return;const nodes=focusables(),first=nodes[0],last=nodes.at(-1);
    if(!first){e.preventDefault();return;}if(e.shiftKey&&doc.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&doc.activeElement===last){e.preventDefault();first.focus();}
  });
  listen(layout,'pointerdown',e=>{
    if(!compact||e.isPrimary===false||e.button!==0||e.target.closest('input,select,textarea,[role="slider"]')||doc.querySelector('dialog[open],.viewer-screen:not([style*="display: none"])')){start=null;return;}
    start={x:e.clientX,y:e.clientY,at:e.timeStamp,id:e.pointerId,opened:open,target:e.target};
  },{passive:true});
  listen(layout,'pointermove',e=>{if(start&&(Math.abs(e.clientY-start.y)>24&&Math.abs(e.clientY-start.y)>Math.abs(e.clientX-start.x)))start=null;},{passive:true});
  listen(layout,'pointercancel',()=>{start=null;});
  listen(layout,'pointerup',e=>{
    const initial=start;start=null;if(!initial||initial.id!==e.pointerId)return;
    if(swipeDirection(initial,{x:e.clientX,y:e.clientY,at:e.timeStamp},initial.opened?-1:1)){
      suppressUntil=Date.now()+650;suppressTarget=initial.target;initial.opened?close():show();
    }
  });
  listen(layout,'click',e=>{if(Date.now()<suppressUntil&&(e.target===suppressTarget||suppressTarget?.contains?.(e.target))){e.preventDefault();e.stopImmediatePropagation();}},true);
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
  listen(root,'contextmenu',e=>{const button=e.target.closest('[data-open]');if(!button)return;e.preventDefault();if(now()>=until||blocked!==button)trigger(button);});
  return {dispose(){cancel();listeners.forEach(remove=>remove());}};
}
