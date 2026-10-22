// One deadline across startup reads, rather than a timeout per sequential call.
export function connectionBudget({ms=1200,online=globalThis.navigator?.onLine!==false,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  const controller=new AbortController();
  const timer=online?setTimer(()=>controller.abort(),ms):null;
  if(!online)controller.abort();
  return {signal:controller.signal,dispose(){if(timer!==null)clearTimer(timer);controller.abort();}};
}
