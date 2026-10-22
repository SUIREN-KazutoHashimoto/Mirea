import {transaction} from './database.js';

export const MIN_REPLAY_WATCH_MS=3000;
const BIN=10000,MAX_BATCH=1000;
const interrupted=new Set(['ready','seeking','seeked','pause','buffering','loop','ended','close','error']);
const fresh=()=>({seq:0,row:0,elapsed:0,end:null,to:null,watch:0,pending:{}});
function reset(state){state.end=null;state.to=null;state.watch=0;state.pending={};}
function coverage(from,to,add){for(let start=Math.floor(from/BIN)*BIN;start<to;start+=BIN)add(start,Math.min(start+BIN,to)-Math.max(start,from));}

/** Derived graph only. Raw events, watch totals and ordinary analytics bins
 * remain untouched. A qualifying run includes its provisional first 3 seconds. */
export function replayEvent(state,event,add){
  if(event.seq!==state.seq+1||event.elapsedMs<state.elapsed)reset(state);
  state.seq=event.seq;state.elapsed=event.elapsedMs;
  const watch=event.watchMs??0,from=event.fromMs,to=event.toMs,interval=event.intervalMs??0;
  if(event.type!=='interval'){
    if(interrupted.has(event.type)||event.playing===false||event.seeking||event.buffering||event.gapMs>0)reset(state);
    return;
  }
  if(!event.playing||event.seeking||event.buffering||event.gapMs>0||!Number.isFinite(watch)||watch<=0||watch>interval||!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from||to-from>watch*(event.rate??1)*1.5+300){reset(state);return;}
  // Compare both clocks: equal media positions alone must not join separate
  // visits. Small tolerance only absorbs recorder rounding/frame jitter.
  if(state.end!==null&&(Math.abs(event.elapsedMs-interval-state.end)>100||Math.abs(from-state.to)>100))reset(state);
  state.end=event.elapsedMs;state.to=to;
  if(state.watch>=MIN_REPLAY_WATCH_MS){coverage(from,to,add);return;}
  coverage(from,to,(bin,ms)=>{state.pending[bin]=(state.pending[bin]??0)+ms;});
  state.watch=Math.min(MIN_REPLAY_WATCH_MS,state.watch+watch);
  if(state.watch>=MIN_REPLAY_WATCH_MS){for(const [bin,ms]of Object.entries(state.pending))add(Number(bin),ms);state.pending={};}
}

/** Must be called inside a transaction. Bounded, durable projection. Late
 * sequence arrivals rebuild only this view, not the whole asset/history. */
export function projectReplayView(db,id,{limit=MAX_BATCH}={}){
  const view=db.prepare("SELECT 1 FROM analytics_views WHERE id=? AND asset_kind='video' AND context='viewer'").get(id);if(!view)return false;
  let stored=db.prepare('SELECT state_json FROM analytics_replay_state WHERE view_id=?').get(id),state=stored?JSON.parse(stored.state_json):fresh();
  if(db.prepare('SELECT 1 FROM analytics_events WHERE view_id=? AND row_id>? AND seq<=? LIMIT 1').get(id,state.row,state.seq)){
    db.prepare('DELETE FROM analytics_replay_bins WHERE view_id=?').run(id);state=fresh();
  }
  const rows=db.prepare('SELECT row_id,seq,payload_json FROM analytics_events WHERE view_id=? AND seq>? ORDER BY seq LIMIT ?').all(id,state.seq,limit);
  const insert=db.prepare('INSERT INTO analytics_replay_bins VALUES(?,?,?) ON CONFLICT(view_id,start_ms) DO UPDATE SET media_ms=media_ms+excluded.media_ms');
  for(const row of rows){let event;try{event=JSON.parse(row.payload_json);}catch{event={};}if(!Number.isSafeInteger(event.elapsedMs)||event.seq!==row.seq){reset(state);state.seq=row.seq;}else replayEvent(state,event,(start,ms)=>insert.run(id,start,ms));state.row=Math.max(state.row,row.row_id);}
  db.prepare('INSERT INTO analytics_replay_state VALUES(?,?) ON CONFLICT(view_id) DO UPDATE SET state_json=excluded.state_json').run(id,JSON.stringify(state));
  return Boolean(db.prepare('SELECT 1 FROM analytics_events WHERE view_id=? AND seq>? LIMIT 1').get(id,state.seq));
}

export function registerReplayProjection(app,db){
  let timer,closing=false,cursor=0,scanned=false;const pending=new Set();
  function wake(){if(!closing&&!timer){timer=setTimeout(pump,25);timer.unref();}}
  function pump(){timer=undefined;if(closing)return;
    try{
      if(pending.size<20&&!scanned){const rows=db.prepare("SELECT rowid AS cursor,id FROM analytics_views WHERE rowid>? AND asset_kind='video' AND context='viewer' ORDER BY rowid LIMIT 20").all(cursor);for(const row of rows){cursor=row.cursor;pending.add(row.id);}if(rows.length<20)scanned=true;}
      for(let n=0;n<8&&pending.size;n++){const id=pending.values().next().value;const more=transaction(db,()=>projectReplayView(db,id,{limit:128}));pending.delete(id);if(more){pending.add(id);break;}}
    }catch(error){app.log.error({err:error},'Replay projection paused; raw analytics are preserved');timer=setTimeout(pump,1000);timer.unref();return;}
    if(pending.size||!scanned)wake();
  }
  app.addHook('onClose',async()=>{closing=true;clearTimeout(timer);pending.clear();});wake();
  return {ingest(id){try{if(transaction(db,()=>projectReplayView(db,id)))pending.add(id);}catch(error){pending.add(id);app.log.error({err:error},'Replay projection delayed; raw analytics were saved');}wake();}};
}
