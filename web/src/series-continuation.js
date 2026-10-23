// No media or keys are cached here. Each transition fetches current series membership.
export function createSeriesContinuation({assetId,loadContext,move,isActive=()=>true,enabled=true,changed=()=>{},delayMs=5000,now=Date.now,schedule=setTimeout,unschedule=clearTimeout,order}){
  let context=null,anchor=null,disposed=false,busy=false,timer,deadline=0,epoch=0,message='';
  const activeOrder=()=>order&&(order.modes.shuffle||order.modes.repeat==='series');
  const next=()=>context?.items?.[context.currentIndex+1]??null;
  const state=()=>({context,enabled,busy,message,countdown:deadline?Math.max(0,Math.ceil((deadline-now())/1000)):null,
    canContinue:!disposed && !busy && enabled && isActive() && Boolean(activeOrder()?order.canMove(context,assetId):next())});
  const emit=()=>changed(state());
  function cancel(text=''){
    epoch++;unschedule(timer);timer=undefined;deadline=0;message=text;if(!disposed)emit();
  }
  function accept(value){
    context=value;
    if(anchor===null && value?.series)anchor=value.series.id;
    emit();
  }
  async function navigate({direction=1,targetId,continuous=false,autoplay=false}={}){
    if(disposed || busy || !isActive() || (continuous && !enabled))return false;
    cancel();const revision=epoch;busy=true;emit();
    try{
      const fresh=await loadContext();
      if(disposed || revision!==epoch || !isActive() || (continuous && !enabled))return false;
      if(!fresh?.series || fresh.series.id!==anchor || fresh.currentIndex<0 || fresh.items[fresh.currentIndex]?.id!==assetId){
        message='シリーズの構成が変わりました。閉じて開き直してください。';return false;
      }
      accept(fresh);
      const planned=activeOrder()&&!targetId?order.plan(fresh,assetId,direction):null;
      const index=targetId?fresh.items.findIndex(item=>item.id===targetId):fresh.currentIndex+direction;
      const target=activeOrder()&&!targetId?planned?.target:fresh.items[index];
      if(!target || target.id===assetId&&!(order&&continuous&&order.modes.repeat==='series')){message=targetId?'選択したアセットはシリーズから外されました。':'シリーズの端に到達しました。';return false;}
      if(target.offlineUnavailable){message='次の作品は未保存・期限切れのため、オフラインでは開けません。';return false;}
      // The viewer disposes old progress/analytics/media keys before opening the new asset.
      let committed=false;const allowed=()=>{if(disposed||revision!==epoch||!isActive()||continuous&&!enabled)return false;if(planned&&!committed){if(!planned.commit())return false;committed=true;}return true;};
      return (await move(target,{startAtBeginning:continuous,autoplay},allowed))!==false;
    }catch(error){if(!disposed && revision===epoch)message=error.message || '次のアセットを開けません。接続を確認してもう一度お試しください。';return false;}
    finally{busy=false;if(!disposed)emit();}
  }
  function tick(){
    if(disposed || !deadline)return;
    if(!enabled || !isActive()){cancel('自動移動を停止しました。次へ進むには操作してください。');return;}
    if(now()>=deadline){deadline=0;navigate({continuous:true,autoplay:true});return;}
    emit();timer=schedule(tick,Math.min(1000,deadline-now()));
  }
  return {
    get state(){return state();},
    setContext:accept,
    setEnabled(value){enabled=Boolean(value);cancel(enabled?'連続再生・閲覧を有効にしました。':'連続再生・閲覧を停止しました。');},
    cancel,
    notify(text){message=text;emit();},
    navigate,
    nextBook(){return navigate({continuous:true,autoplay:true});},
    videoEnded(){
      if(disposed || busy || deadline)return;
      if(!enabled || !isActive())return;
      if(!(activeOrder()?order.canMove(context,assetId):next())){message='シリーズの最後のアセットです。';emit();return;}
      message='';deadline=now()+(order&&(order.modes.shuffle||order.modes.repeat==='series')?250:delayMs);tick();
    },
    dispose(){if(disposed)return;disposed=true;cancel();}
  };
}

// A book is not complete merely because its final page is visible. Continue only
// on an explicit page-next action; resizing/restoring/scrolling never turns a book.
export function advanceBook({ready,page,total,go,continuation}){
  if(!ready)return;
  if(page<total)go(page+1);
  else if(continuation?.canContinue)continuation.nextBook();
}

export function bindContinuationVideo(video,{autoplay=false,canAutoplay=()=>true,onEnded=()=>{},onReset=()=>{},onError=()=>{},onBlocked=()=>{}}={}){
  let disposed=false,attempted=false;
  const play=()=>{
    if(disposed || !autoplay || attempted)return;attempted=true;
    if(!canAutoplay()){onBlocked('inactive');return;}
    Promise.resolve().then(()=>{if(!disposed && canAutoplay())return video.play();})
      .catch(()=>{if(!disposed && canAutoplay())onBlocked('policy');});
  };
  const handlers={ended:onEnded,play:onReset,seeking:onReset,error:onError,canplay:play};
  for(const [event,handler] of Object.entries(handlers))video.addEventListener(event,handler);
  if(video.readyState>=3)play();
  return()=>{disposed=true;for(const [event,handler] of Object.entries(handlers))video.removeEventListener(event,handler);};
}
