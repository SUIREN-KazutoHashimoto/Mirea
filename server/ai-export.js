import {Readable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import {createAiStore} from './ai-store.js';
import {AI_FEATURES,applyAiEdits} from './ai-validation.js';
export function exportAi(req,reply,{dataDir,item,authorize,maintenance,onOpen=()=>{},onClose=()=>{}}){
  const snapshot=new DatabaseSync(join(dataDir,'mirea.sqlite'),{readOnly:true});
  snapshot.exec('BEGIN');const store=createAiStore(snapshot),deadline=Date.now()+10*60000;let released=false;
  const release=()=>{if(released)return;released=true;try{snapshot.exec('ROLLBACK');}finally{snapshot.close();onClose();}};
  onOpen();
  async function *generate(){
    try{
      yield '{"version":1,"assetId":'+JSON.stringify(item.id)+',"title":'+JSON.stringify(item.title)+',"tags":'+JSON.stringify(store.tags(item.id,req.user.id))+',"features":{';
      let first=true;
      for(const feature of AI_FEATURES){
        const value=store.read(item.id,feature,{limit:1});if(!value)continue;
        authorize();const {result,patch,hasMore,nextOffset,offset,...metadata}=value;
        yield (first?'':',')+JSON.stringify(feature)+':'+JSON.stringify({...metadata,manualEdits:patch}).slice(0,-1)+',"result":{"tags":'+JSON.stringify(result.tags)+',"summary":'+JSON.stringify(result.summary)+',"blocks":[';first=false;
        for(const key of ['blocks','segments']){
          let firstEntry=true;
          for(const {value:unit}of store.units(item.id,feature)){
            if(req.raw.aborted||reply.raw.destroyed||Date.now()>deadline||maintenance.locked)throw Error('Analysis export interrupted');
            authorize();
            for(const row of applyAiEdits(unit,patch)[key]){yield (firstEntry?'':',')+JSON.stringify(row);firstEntry=false;}
            await yieldEventLoop();
          }
          yield key==='blocks'?'],"segments":[':']}';
        }
        yield '}';
      }
      yield '}}';
    }finally{release();}
  }
  const stream=Readable.from(generate());stream.once('close',release);stream.once('error',release);
  return reply.type('application/json').header('Content-Disposition','attachment; filename="mirea-analysis.json"').send(stream);
}
