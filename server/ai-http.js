import {request} from 'node:http';
// Inference may legitimately take more than fetch's default response-header
// deadline on a CPU. Use one explicit total deadline, bounded output and abort.
export function requestAiJson(origin,path,{token,body,signal,timeout=3600000,maxOutput=4*1024*1024}={}){
 const url=new URL(origin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||!['/v1/chat/completions','/v1/embeddings'].includes(path)||url.username||url.password)throw Error('Invalid local inference endpoint');
 return new Promise((resolve,reject)=>{
  let done=false,response,requestBody;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const failed=code=>Object.assign(Error('Local inference request failed'),{code});
  const req=request(new URL(path,url),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}},res=>{
   response=res;const chunks=[];let size=0;
   res.once('aborted',()=>finish(failed('AI_INFERENCE_FAILED')));res.once('close',()=>{if(!res.complete)finish(failed('AI_INFERENCE_FAILED'));});
   res.on('data',chunk=>{size+=chunk.length;if(size>maxOutput){const error=failed('AI_OUTPUT_LIMIT');finish(error);res.destroy();req.destroy();}else chunks.push(chunk);});
   res.once('error',()=>finish(failed('AI_INFERENCE_FAILED')));
   res.once('end',()=>{if(done)return;if(res.statusCode!==200){finish(failed('AI_INFERENCE_FAILED'));return;}try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(failed('AI_OUTPUT_INVALID'));}});
  });
  const abort=()=>{const error=signal.reason??new DOMException('Analysis cancelled','AbortError');finish(error);response?.destroy();req.destroy();};
  const timer=setTimeout(()=>{finish(failed('AI_TIMEOUT'));response?.destroy();req.destroy();},timeout);
  req.once('error',()=>finish(failed('AI_INFERENCE_FAILED')));
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){abort();return;}
  try{requestBody=JSON.stringify(body);req.end(requestBody);}catch(error){finish(error);req.destroy();}
 });
}
