import {mountDrawerSwipe} from './drawer-swipe.js';
export function mountLibraryDrawer({layout,panel,main,opener,closer,backdrop,actions,actionHome,native=false,onGestureAvailability=()=>{},doc=document,media=matchMedia('(max-width:760px)')}){
  const listeners=[],win=doc.defaultView,listen=(node,event,fn,options)=>{node?.addEventListener(event,fn,options);listeners.push(()=>node?.removeEventListener(event,fn,options));};
  let open=false,compact=false,locked=false,overflow,previousFocus,swipe,observer,lastAvailable,disposed=false;
  const focusables=()=>[...panel.querySelectorAll('button,a[href],input,select,[tabindex="0"]')].filter(n=>!n.disabled&&!n.hidden&&n.getClientRects().length);
  const blocked=()=>doc.querySelector('dialog[open],.viewer-screen:not([style*="display: none"]),.library-popover:not([hidden])');
  const editable=()=>doc.activeElement?.matches?.('input,textarea,select,[contenteditable]');
  const gestureReady=()=>native&&compact&&!doc.hidden&&!blocked()&&!editable()&&layout.isConnected;
  function availability(force=false){if(!native)return;const available=!disposed&&gestureReady()&&!open;if(force||available!==lastAvailable){lastAvailable=available;onGestureAvailability(available);}}
  const lock=()=>{if(locked)return;locked=true;overflow=doc.body.style.overflow;previousFocus=doc.activeElement;doc.body.style.overflow='hidden';};
  const unlock=()=>{if(!locked)return;locked=false;doc.body.style.overflow=overflow;};
  function resetDrag(){layout.classList.remove('drawer-dragging');layout.style.removeProperty('--drawer-reveal');layout.style.removeProperty('--drawer-opacity');}
  function close({restoreFocus=true}={}){
    swipe?.cancel({notify:false});const wasOpen=open||layout.classList.contains?.('drawer-dragging');open=false;layout.classList.remove('drawer-open');resetDrag();main.inert=false;
    panel.inert=compact;panel.setAttribute('aria-hidden',String(compact));panel.removeAttribute('role');panel.removeAttribute('aria-modal');
    opener.setAttribute('aria-expanded','false');backdrop.hidden=true;unlock();availability();
    if(wasOpen&&restoreFocus&&previousFocus?.isConnected)previousFocus.focus({preventScroll:true});
  }
  function show({focus=true}={}){
    if(!compact||blocked())return;swipe?.cancel({notify:false});
    open=true;lock();main.inert=true;panel.inert=false;panel.setAttribute('aria-hidden','false');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
    layout.classList.add('drawer-open');resetDrag();backdrop.hidden=false;opener.setAttribute('aria-expanded','true');availability();if(focus)(closer||focusables()[0])?.focus({preventScroll:true});
  }
  function adapt(){
    close({restoreFocus:false});compact=native||media.matches;layout.classList.toggle('compact-library',compact);panel.inert=compact;
    panel.setAttribute('aria-hidden',String(compact));opener.hidden=!compact;closer.hidden=!compact;
    for(const button of actions)(compact?panel.querySelector('.drawer-actions'):actionHome).append(button);availability();
  }
  listen(opener,'click',()=>show());listen(closer,'click',()=>close());listen(backdrop,'click',()=>close());
  listen(panel,'click',e=>{if(e.target.closest('button,a')&&e.target.closest('button')!==closer)close();},true);
  listen(doc,'keydown',e=>{
    if(!open&&!swipe?.isDragging())return;
    if(e.key==='Escape'){e.preventDefault();close();return;}
    if(!open||e.key!=='Tab')return;const nodes=focusables(),first=nodes[0],last=nodes.at(-1);
    if(!first){e.preventDefault();return;}if(e.shiftKey&&doc.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&doc.activeElement===last){e.preventDefault();first.focus();}
  });
  if(native){
    swipe=mountDrawerSwipe({layout,panel,doc,win,enabled:gestureReady,isOpen:()=>open,onStart(){lock();main.inert=true;layout.classList.add('drawer-dragging');backdrop.hidden=false;},onProgress(reveal,width){layout.style.setProperty('--drawer-reveal',reveal+'px');layout.style.setProperty('--drawer-opacity',String(reveal/width));},onFinish(target,{cancelled}){panel.getBoundingClientRect();if(target&&!blocked())show({focus:!cancelled});else close({restoreFocus:!cancelled});}});
    const selectors='dialog,.viewer-screen,.library-popover';
    if(win?.MutationObserver){observer=new win.MutationObserver(records=>{if(records.some(r=>r.type==='attributes'?r.target.matches(selectors):[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1&&(n.matches(selectors)||n.querySelector(selectors))))){if(blocked()&&(open||swipe.isDragging()))close({restoreFocus:false});availability();}});observer.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open','hidden','style']});}
    listen(doc,'focusin',()=>availability());listen(doc,'focusout',()=>queueMicrotask(()=>availability()));listen(doc,'visibilitychange',()=>availability(true));listen(win,'focus',()=>availability(true));
  }
  listen(media,'change',adapt);adapt();
  return {show,close,cancelGesture:()=>swipe?.cancel(),isOpen:()=>open||Boolean(swipe?.isDragging()),refreshGestures:()=>availability(true),dispose(){disposed=true;close({restoreFocus:false});swipe?.dispose();observer?.disconnect();listeners.forEach(remove=>remove());panel.inert=false;main.inert=false;}};
}
export function mountAssetHold(root,show,{doc=root.ownerDocument,delay=500,slop=12,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}={}){
  let timer,press,blocked,until=0;const listeners=[],listen=(node,event,fn,options)=>{node.addEventListener(event,fn,options);listeners.push(()=>node.removeEventListener(event,fn,options));};
  const cancel=()=>{clearTimer(timer);timer=null;press=null;};
  function trigger(button,position){cancel();if(!button?.isConnected)return;blocked=button;until=now()+1000;show(button.dataset.open,position);}
  listen(root,'pointerdown',e=>{cancel();if(e.button!==0||e.isPrimary===false)return;const button=e.target.closest('[data-open]');if(!button)return;press={id:e.pointerId,x:e.clientX,y:e.clientY,button};timer=setTimer(()=>trigger(button),delay);},{passive:true});
  listen(root,'pointermove',e=>{if(press&&(e.pointerId!==press.id||Math.hypot(e.clientX-press.x,e.clientY-press.y)>slop))cancel();},{passive:true});
  for(const name of ['pointerup','pointercancel','lostpointercapture','keydown'])listen(root,name,cancel);
  listen(doc,'visibilitychange',cancel);listen(doc,'mirea:drawerdrag',cancel);listen(doc.defaultView,'blur',cancel);
  listen(root,'click',e=>{if(e.detail!==0&&now()<until&&blocked?.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();blocked=null;}},true);
  listen(root,'keydown',e=>{if(e.key==='ContextMenu'||e.key==='F10'&&e.shiftKey){const button=e.target.closest('[data-open]');if(button){e.preventDefault();trigger(button);}}});
  listen(root,'contextmenu',e=>{const button=e.target.closest('[data-open]');if(!button)return;e.preventDefault();if(now()>=until||blocked!==button)trigger(button,e.clientX||e.clientY?{x:e.clientX,y:e.clientY}:undefined);});
  return {dispose(){cancel();listeners.forEach(remove=>remove());}};
}
