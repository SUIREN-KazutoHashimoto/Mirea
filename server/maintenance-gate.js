import {setTimeout as delay} from 'node:timers/promises';
import {httpError} from './security.js';

// Full backup freezes publication/deletion while the database and its files are
// read. Existing media streams may finish; new writes get an explicit 503.
export function createMaintenanceGate(app) {
  let locked=false,active=0,busy=()=>false;
  app.addHook('onRoute',route=>{
    const original=route.handler;if(typeof original!=='function')return;
    route.handler=function(request,reply){
      if(!request.maintenanceTracked)return original.call(this,request,reply);
      request.maintenanceHandlerStarted=true;
      const done=()=>{request.maintenanceHandlerFinished=true;request.maintenanceRelease?.();};
      try{
        const result=original.call(this,request,reply);
        if(result&&result!==reply&&typeof result.then==='function')return result.then(value=>{done();return value;},error=>{done();throw error;});
        if(result===undefined||result===reply)request.maintenanceCallbackHandler=true;
        else done();
        return result;
      }catch(error){done();throw error;}
    };
  });
  const excluded=req=>/^\/api\/v1\/admin\/backups(?:\/|$)/.test(req.url.split('?')[0]) || req.method==='GET' && /^\/api\/v1\/admin\/(?:jobs|updates\/status)$/.test(req.url.split('?')[0]);
  app.addHook('onRequest',async(req,reply)=>{
    const path=req.url.split('?')[0];
    if(!path.startsWith('/api/') || path==='/api/health' || excluded(req))return;
    if(locked)return reply.code(503).header('Retry-After','10').send({error:'整合性を保つためバックアップ／更新の準備中です。しばらくして再試行してください。'});
    if(!['GET','HEAD','OPTIONS'].includes(req.method) || path.endsWith('/thumbnail')){
      req.maintenanceTracked=true;active++;
      const finish=()=>{
        // Disconnecting the client does not cancel asynchronous filesystem
        // work. Keep the reservation until its handler actually finishes.
        if(req.maintenanceHandlerStarted&&!req.maintenanceHandlerFinished)return;
        if(req.maintenanceTracked){req.maintenanceTracked=false;active--;}
        req.raw.off('aborted',finish);reply.raw.off('close',finish);
      };
      req.maintenanceRelease=finish;req.raw.once('aborted',finish);reply.raw.once('close',finish);
    }
  });
  app.addHook('onResponse',async req=>{if(req.maintenanceCallbackHandler)req.maintenanceHandlerFinished=true;req.maintenanceRelease?.();});
  return {get locked(){return locked;},setBusy(check){busy=check;},
    async acquire(request){
      if(locked)throw httpError(409,'別のバックアップ／更新を実行しています。');
      locked=true;
      // The caller is handing off its own request, not waiting for itself to
      // finish. onResponse must not decrement this reservation a second time.
      if(request?.maintenanceTracked){request.maintenanceTracked=false;active--;}
      try{
        const deadline=Date.now()+30000;
        while(active){if(Date.now()>deadline)throw httpError(409,'処理中の通信があります。終了後に再試行してください。');await delay(50);}
        if(busy())throw httpError(409,'メディア処理の完了を待ってから再試行してください。');
        return ()=>{locked=false;};
      }catch(error){locked=false;throw error;}
    }
  };
}
