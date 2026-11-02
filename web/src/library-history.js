// Keep browser Back/Forward and reload inside the authenticated library. Stored
// state contains IDs and view preferences, never an authorization decision.
export function createLibraryHistory({host=window,scope,read,restore,onError=()=>{}}){
  let activeScope,applying=false,pending=0,serial=0,readyPromise,applyGeneration=0;
  const record=()=>({scope:scope(),view:read()});
  const replace=()=>host.history.replaceState({...host.history.state,mirea:record()},'');
  const update=()=>{if(activeScope===scope()&&!applying&&!pending)replace();};
  const apply=async view=>{const generation=++applyGeneration,identity=scope(),isCurrent=()=>generation===applyGeneration&&identity===scope();applying=true;try{await restore(view,{isCurrent});}catch(error){if(isCurrent())onError(error);}finally{if(isCurrent()){applying=false;replace();}}};
  async function ready(){const current=scope();if(!current||activeScope===current)return readyPromise;const saved=host.history.state?.mirea;activeScope=current;applyGeneration++;pending=0;serial++;applying=false;readyPromise=saved?.scope===current?apply(saved.view):Promise.resolve(replace());return readyPromise;}
  function begin(){if(activeScope!==scope()||applying)return ()=>{};if(!pending)replace();const token=++serial;pending=token;return()=>{if(pending!==token)return;pending=0;if(activeScope===scope())host.history.pushState({...host.history.state,mirea:record()},'');};}
  const pop=event=>{if(activeScope!==scope()||event.state?.mirea?.scope!==scope())return;pending=0;serial++;void apply(event.state.mirea.view);};
  host.addEventListener('popstate',pop);
  const pagehide=()=>update();host.addEventListener('pagehide',pagehide);
  return {ready,begin,update,closedViewer(){if(applying||pending||activeScope!==scope())return;if(host.history.state?.mirea?.view?.viewer&&!read().viewer)host.history.back();else update();},dispose(){applyGeneration++;host.removeEventListener('popstate',pop);host.removeEventListener('pagehide',pagehide);}};
}
