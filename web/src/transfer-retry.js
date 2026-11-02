// Transient network/server failures keep a transfer resumable. Authentication,
// integrity and storage errors are never retried as connection failures.
export function transferRetryDelay(error,attempt,{now=Date.now}={}){
  if(error?.code==='DOWNLOAD_INTEGRITY_FAILED'||error?.name==='QuotaExceededError')return null;
  if(!(error instanceof TypeError)&&!['TimeoutError','AbortError'].includes(error?.name)&&![0,408,429,500,502,503,504].includes(error?.status))return null;
  const value=error.retryAfter;
  const requested=value==null?0:/^\d+(?:\.\d+)?$/.test(String(value))?Number(value)*1000:Date.parse(value)-now();
  return Math.min(300000,Math.max(1000,Number.isFinite(requested)?requested:0,Math.min(30000,1000*2**Math.min(attempt,5))));
}
export function abortableDelay(ms,signal){
  return new Promise((resolve,reject)=>{
    let timer;const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason??new DOMException('中断しました。','AbortError'));};
    if(signal.aborted){abort();return;}
    timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});
  });
}
