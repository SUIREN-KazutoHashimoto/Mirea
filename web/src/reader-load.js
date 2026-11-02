// Keep the reader shell open while an initial network request is retried.
export function createReaderLoad({load,onError,onStart=()=>{}}){
  let disposed=false,running;
  const run=()=>{
    if(disposed)return Promise.resolve();
    if(running)return running;
    running=Promise.resolve().then(()=>{if(!disposed){onStart();return load();}}).catch(error=>{
      if(!disposed&&error?.name!=='AbortError')onError(Object.assign(error,{retry:run}));
    }).finally(()=>{running=null;});
    return running;
  };
  return {run,dispose(){disposed=true;}};
}
