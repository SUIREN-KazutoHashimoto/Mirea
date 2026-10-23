export const LIBRARY_REFRESH_MS = 60_000;

// Connection/lease synchronization has its own clock; it must not poll the catalog.
export const shouldRefreshCatalog = ({requested=true,wasOffline=false}={}) => requested || wasOffline;
export function pollLibrary(refresh,{allowed=()=>true,setTimer=setInterval,clearTimer=clearInterval}={}) {
  const timer=setTimer(()=>{if(allowed())Promise.resolve().then(refresh).catch(()=>{});},LIBRARY_REFRESH_MS);
  return ()=>clearTimer(timer);
}

export function mountLibraryRefresh({main,button,onRefresh,blocked=()=>false,doc=document,setTimer=setTimeout,clearTimer=clearTimeout}) {
  const indicator=doc.createElement('div');indicator.className='pull-refresh';indicator.dataset.state='idle';
  indicator.setAttribute('role','status');indicator.setAttribute('aria-live','polite');
  indicator.innerHTML='<span class="pull-refresh-symbol" aria-hidden="true">↓</span><span class="pull-refresh-label"></span>';
  main.append(indicator);
  const label=indicator.querySelector('.pull-refresh-label'),listeners=[];
  const listen=(node,type,fn,options)=>{node.addEventListener(type,fn,options);listeners.push(()=>node.removeEventListener(type,fn,options));};
  let press=null,dragging=false,pending=null,disposed=false,timer;
  const root=doc.documentElement;root.classList.add('library-refresh-enabled');
  function display(state,text='',distance=0){
    if(disposed)return;indicator.dataset.state=state;label.textContent=text;
    indicator.style.setProperty('--pull-distance',`${distance}px`);
  }
  function reset(){press=null;dragging=false;if(!pending)display('idle');}
  const unavailable=()=>disposed||doc.hidden||blocked();
  const atTop=()=> (doc.scrollingElement?.scrollTop??0)<=1;
  function eligible(target){
    if(target.closest('input,select,textarea,a,[contenteditable="true"],button:not(.card-open),[role="slider"]'))return false;
    for(let node=target;node&&node!==main;node=node.parentElement){
      if(node.scrollTop>0||node.scrollWidth>node.clientWidth+1&&node.classList.contains('tabs'))return false;
    }
    return true;
  }
  function cancelGesture(){reset();}
  async function request(){
    if(pending||unavailable())return;
    clearTimer(timer);press=null;dragging=false;button.disabled=true;button.setAttribute('aria-busy','true');
    display('refreshing','更新中…',56);
    pending=Promise.resolve().then(onRefresh);
    try{
      const result=await pending;if(disposed)return;
      if(result?.status==='cancelled'){display('idle');return;}
      const offline=result?.status==='offline',failed=result?.status==='failed';
      display(failed?'failed':'done',failed?'更新できませんでした。再度お試しください。':offline?'オフラインです。接続後に同期します。':'更新しました',56);
      timer=setTimer(()=>display('idle'),failed||offline?2600:1000);
    }catch{
      if(!disposed){display('failed','更新できませんでした。再度お試しください。',56);timer=setTimer(()=>display('idle'),2600);}
    }finally{pending=null;if(!disposed){button.disabled=false;button.removeAttribute('aria-busy');}}
  }
  listen(button,'click',()=>request());
  listen(main,'touchstart',event=>{
    if(pending||unavailable()||event.touches.length!==1||!atTop()||!eligible(event.target)){reset();return;}
    clearTimer(timer);const touch=event.touches[0];press={id:touch.identifier,x:touch.clientX,y:touch.clientY,target:event.target};
  },{passive:true});
  listen(main,'touchmove',event=>{
    if(!press)return;
    if(unavailable()||event.touches.length!==1||!atTop()){reset();return;}
    const touch=event.touches[0];if(touch.identifier!==press.id){reset();return;}
    const dx=touch.clientX-press.x,dy=touch.clientY-press.y;
    if(!dragging){if(Math.abs(dx)>10&&Math.abs(dx)>=dy){reset();return;}if(dy<=-10){reset();return;}if(dy<12)return;}
    if(!event.cancelable){reset();return;}
    dragging=true;event.preventDefault();
    const distance=Math.min(100,Math.max(0,dy)*0.5);press.armed=distance>=64;
    display(press.armed?'armed':'pulling',press.armed?'離して更新':'下に引いて更新',distance);
  },{passive:false});
  listen(main,'touchend',event=>{
    if(!press)return;
    const fire=dragging&&press.armed&&event.touches.length===0&&!unavailable();
    if(dragging){event.preventDefault();clickTarget=press.target;main.addEventListener('click',suppressClick,{capture:true,once:true});clearTimer(clickTimer);clickTimer=setTimer(()=>main.removeEventListener('click',suppressClick,true),500);}
    reset();if(fire)request();
  },{passive:false});
  let clickTimer,clickTarget;function suppressClick(event){if(event.detail!==0&&(clickTarget===event.target||clickTarget?.contains(event.target))){event.preventDefault();event.stopImmediatePropagation();}}
  listen(main,'touchcancel',cancelGesture);listen(doc,'visibilitychange',cancelGesture);listen(doc.defaultView,'blur',cancelGesture);listen(doc.defaultView,'resize',cancelGesture);
  return {request,get active(){return Boolean(press||pending);},dispose(){
    reset();disposed=true;clearTimer(timer);clearTimer(clickTimer);main.removeEventListener('click',suppressClick,true);
    listeners.forEach(remove=>remove());root.classList.remove('library-refresh-enabled');indicator.remove();
  }};
}
