export function validShellManifest(manifest){
  return /^[0-9a-f]{64}$/.test(manifest?.version??'')&&Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=2000&&manifest.files.every(path=>typeof path==='string'&&/^\/(?:index\.html|favicon\.svg|brand\/orbit-(?:mark|mark-inverse|icon)\.svg|download-sw\.js|assets\/[A-Za-z0-9_.-]+|pdf-assets\/[A-Za-z0-9_./-]+)$/.test(path)&&!path.includes('..'));
}


// Hashed/static build files are immutable and cache-first. Only the navigation
// document checks the network, with a bounded deadline when a shell is saved.
export async function shellResponse(request,{navigate,findCached,network=fetch,online=globalThis.navigator?.onLine!==false,ms=900}){
  const cached=await findCached();
  if(cached&&(!navigate||!online))return cached;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ms);
  try{
    const response=await network(request,{signal:controller.signal});
    const bytes=await response.arrayBuffer();controller.signal.throwIfAborted();
    return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
  }catch{return cached??new Response('オフライン用画面がありません。オンラインで一度ダウンロードしてください。',{status:503});}
  finally{clearTimeout(timer);controller.abort();}
}
