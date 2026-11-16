const controls='input,textarea,select,[contenteditable],[role="slider"],.library-popover,.collection-tools,.tabs,.playback-dock,[data-no-drawer-swipe]';
export function mountDrawerSwipe({layout,panel,enabled,isOpen,onStart,onProgress,onFinish,doc=layout.ownerDocument,win=doc.defaultView,now=()=>performance.now()}){
  const listeners=[];let gesture,frame,observer,blockedContact=false,ghostUntil=0,disposed=false;
  const listen=(node,type,handler,options)=>{node.addEventListener(type,handler,options);listeners.push(()=>node.removeEventListener(type,handler,options));};
  const stopFrame=()=>{if(frame!=null)win.cancelAnimationFrame(frame);frame=null;};
  function cancel({notify=true}={}){const old=gesture;gesture=null;stopFrame();if(old?.claimed){ghostUntil=now()+600;if(notify)onFinish(old.wasOpen,{cancelled:true});}}
  function blockedTarget(target){
    if(target.closest?.(controls)||doc.getSelection?.()?.isCollapsed===false)return true;
    for(let node=target;node&&node!==layout;node=node.parentElement)if(node.scrollWidth>node.clientWidth+1&&/auto|scroll/.test(win.getComputedStyle(node).overflowX))return true;
    return false;
  }
  function start(event){
    if(disposed||blockedContact||event.touches.length!==1||!enabled()||blockedTarget(event.target))return;
    const touch=event.touches[0],width=panel.getBoundingClientRect().width,left=layout.getBoundingClientRect().left||0,wasOpen=isOpen();
    if(!(width>0)||(!wasOpen&&(touch.clientX<left||touch.clientX-left>72)))return;
    gesture={target:event.target,id:touch.identifier,x:touch.clientX,y:touch.clientY,width,wasOpen,reveal:wasOpen?width:0,claimed:false,samples:[{x:touch.clientX,t:now()}]};
  }
  function sample(touch){const time=now();gesture.samples.push({x:touch.clientX,t:time});gesture.samples=gesture.samples.filter(p=>p.t>=time-100).slice(-12);}
  function move(event){
    if(!gesture)return;if(!enabled()||event.touches.length!==1){cancel();return;}
    const touch=[...event.touches].find(t=>t.identifier===gesture.id);if(!touch){cancel();return;}
    const dx=touch.clientX-gesture.x,dy=touch.clientY-gesture.y;
    if(!gesture.claimed){
      if(Math.abs(dy)>8&&Math.abs(dy)>Math.abs(dx)*1.2){gesture=null;return;}
      if(Math.abs(dx)<10||Math.abs(dx)<Math.abs(dy)*1.3)return;
      if(!event.cancelable||(!gesture.wasOpen&&dx<0)||(gesture.wasOpen&&dx>0)){gesture=null;return;}
      gesture.claimed=true;onStart();doc.dispatchEvent(new Event('mirea:drawerdrag'));
    }
    if(!event.cancelable){cancel();return;}event.preventDefault();sample(touch);
    gesture.reveal=Math.max(0,Math.min(gesture.width,(gesture.wasOpen?gesture.width:0)+dx));
    if(frame==null)frame=win.requestAnimationFrame(()=>{frame=null;if(gesture?.claimed)onProgress(gesture.reveal,gesture.width);});
  }
  function end(event){
    if(!gesture)return;const touch=[...event.changedTouches].find(t=>t.identifier===gesture.id);if(!touch)return;
    if(!gesture.claimed){gesture=null;return;}if(!enabled()){cancel();return;}
    const old=gesture,dx=touch.clientX-old.x;sample(touch);
    old.reveal=Math.max(0,Math.min(old.width,(old.wasOpen?old.width:0)+dx));
    const first=old.samples[0],last=old.samples.at(-1),velocity=first&&last.t>first.t?(last.x-first.x)/(last.t-first.t):0;
    const target=Math.abs(dx)>=24&&Math.abs(velocity)>=.5?velocity>0:old.reveal>=old.width*.5;
    stopFrame();onProgress(old.reveal,old.width);gesture=null;ghostUntil=now()+600;onFinish(target,{cancelled:false});
  }
  listen(doc,'pointerdown',event=>{if(event.pointerType==='touch')blockedContact=!enabled();},{passive:true,capture:true});
  listen(doc,'touchstart',event=>{ghostUntil=0;if(event.touches.length>1)cancel();},{passive:true,capture:true});
  listen(layout,'touchstart',start,{passive:true,capture:true});listen(doc,'touchmove',move,{passive:false,capture:true});
  listen(doc,'touchend',end,{passive:true,capture:true});listen(doc,'touchcancel',()=>cancel(),{passive:true,capture:true});
  listen(layout,'click',event=>{if(event.detail!==0&&now()<ghostUntil){ghostUntil=0;event.preventDefault();event.stopImmediatePropagation();}},true);
  listen(doc,'visibilitychange',()=>cancel());listen(win,'blur',()=>cancel());listen(win,'resize',()=>cancel());
  if(win.MutationObserver){observer=new win.MutationObserver(()=>{if(gesture?.target.isConnected===false)cancel();});observer.observe(layout,{childList:true,subtree:true});}
  return {cancel,isDragging:()=>Boolean(gesture?.claimed),dispose(){disposed=true;cancel({notify:false});observer?.disconnect();listeners.forEach(remove=>remove());}};
}
