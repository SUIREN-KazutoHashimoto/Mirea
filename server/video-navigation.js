import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {ffmpegPath} from './media.js';
import {ffprobePath} from './video-transcode.js';
import {httpError} from './security.js';
import {transaction} from './database.js';
import {selectVideoSource} from './media-source.js';
const run=promisify(execFile),MAX=2*1024*1024,DAY=86400000;
const plain=(s,max=1000)=>String(s??'').replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|nbsp);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&nbsp;':' '})[x]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,max);
export function subtitleTime(s){const m=String(s).trim().match(/^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/);if(!m||+m[2]>59||+m[3]>59)return NaN;return ((+(m[1]??0)*60+ +m[2])*60+ +m[3])*1000+ +m[4];}
export function parseSubtitles(text,durationMs){
  if(typeof text!=='string'||Buffer.byteLength(text)>MAX)throw httpError(400,'字幕はUTF-8のSRT／WebVTT、2MiB以下にしてください。');
  const cues=[];
  for(const block of text.replace(/^\uFEFF/,'').replaceAll('\r','').split(/\n\s*\n/)){
    const lines=block.split('\n'),at=lines.findIndex(line=>line.includes('-->'));if(at<0)continue;
    const m=lines[at].match(/^\s*(\S+)\s+-->\s+(\S+)/);if(!m)throw httpError(400,'字幕の時刻が不正です。');
    const startMs=subtitleTime(m[1]),endMs=subtitleTime(m[2]),value=plain(lines.slice(at+1).join('\n'));
    if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<0||startMs>=durationMs||endMs<=startMs||endMs>durationMs+1000)throw httpError(400,'字幕の時刻が動画の範囲外です。');
    if(value)cues.push({startMs,endMs:Math.min(endMs,durationMs),text:value});
    if(cues.length>20000)throw httpError(400,'字幕の区間数が多すぎます。');
  }
  if(!cues.length)throw httpError(400,'読み取れる字幕がありません。');
  return cues.sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs);
}
export function validateChapters(chapters,durationMs){
  if(!Array.isArray(chapters)||chapters.length>500)throw httpError(400,'チャプターは500件以内にしてください。');
  let previous=-1;return chapters.map(c=>{if(!c||!Number.isSafeInteger(c.startMs)||c.startMs<=previous||c.startMs>=durationMs||typeof c.title!=='string'||!plain(c.title,160)||c.title.length>160)throw httpError(400,'チャプターの時刻・タイトルが不正です。時刻は昇順で指定してください。');previous=c.startMs;return {startMs:c.startMs,title:plain(c.title,160)};});
}
export async function generateNavigation(source,{signal,authorize=()=>{}}={}){
  authorize();const deadline=Date.now()+45000,limits=['-threads','1','-max_alloc','268435456','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,asf,mpeg,mpegts,flv'];
  const execOptions=()=>{authorize();const timeout=deadline-Date.now();if(timeout<=0)throw Error('Navigation preparation timed out');return {timeout,maxBuffer:MAX,windowsHide:true,killSignal:'SIGKILL',signal};};
  const {stdout}=await run(ffprobePath(),['-v','error',...limits,'-show_entries','format=duration:chapter=start_time,end_time:chapter_tags=title:stream=index,codec_type,codec_name:stream_tags=language,title','-of','json',source],execOptions());
  const probe=JSON.parse(stdout),durationMs=Math.round(Number(probe.format?.duration)*1000);
  if(!Number.isSafeInteger(durationMs)||durationMs<=0||durationMs>31*DAY)throw Error('Invalid navigation duration');
  const chapters=validateChapters((probe.chapters??[]).map((c,i)=>({startMs:Math.max(0,Math.round(Number(c.start_time)*1000)),title:plain(c.tags?.title||`チャプター ${i+1}`,160)})).filter((c,i,a)=>c.startMs<durationMs&&(!i||c.startMs>a[i-1].startMs)),durationMs),captions=[];
  for(const stream of (probe.streams??[]).filter(s=>s.codec_type==='subtitle'&&['subrip','webvtt','mov_text','ass','ssa','text'].includes(s.codec_name)).slice(0,12)){
    authorize();try{const {stdout:text}=await run(ffmpegPath(),['-v','error','-nostdin',...limits,'-i',source,'-map',`0:${stream.index}`,'-f','webvtt','pipe:1'],execOptions());captions.push({id:`embedded-${stream.index}`,label:plain(stream.tags?.title||stream.tags?.language||`字幕 ${captions.length+1}`,80),language:/^[a-zA-Z-]{2,20}$/.test(stream.tags?.language??'')?stream.tags.language:'und',cues:parseSubtitles(text,durationMs)});}catch(error){if(signal?.aborted||Date.now()>=deadline)throw error;/* One unsupported subtitle must not stop playback. */}
    if(Buffer.byteLength(JSON.stringify(captions))>MAX){captions.pop();break;}
  }
  const count=Math.max(1,Math.min(120,Math.ceil(durationMs/5000))),columns=Math.min(10,count),rows=Math.ceil(count/columns),intervalMs=durationMs/count;
  // Pad before sampling: even a sub-GOP clip with a single keyframe must
  // produce a complete sheet. Scene images are representative, not exact frames.
  authorize();const {stdout:image}=await run(ffmpegPath(),['-v','error','-nostdin','-skip_frame','nokey',...limits,'-i',source,'-an','-sn','-vf',`scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tpad=stop_mode=clone:stop_duration=${durationMs/1000},fps=${count*1000/durationMs}:start_time=0,tile=${columns}x${rows}:nb_frames=${count}`,'-frames:v','1','-c:v','mjpeg','-pix_fmt','yuvj420p','-threads','1','-q:v','5','-f','image2pipe','pipe:1'],{...execOptions(),encoding:'buffer',maxBuffer:4*MAX});
  if(!image.length||image.length>4*MAX)throw Error('Invalid storyboard');authorize();
  return {durationMs,chapters,captions,image,storyboard:{count,columns,rows,width:160,height:90,intervalMs}};
}
export async function registerVideoNavigation(app,context){
  const {db,authenticate,findItem,membership,maintenance}=context;let closing=false;const pending=new Map(),controllers=new Set();
  const get=id=>db.prepare('SELECT * FROM video_navigation WHERE item_id=?').get(id);
  const asset=req=>{const item=findItem(req.params.id,req.user.id);if(!item.mime_type.startsWith('video/'))throw httpError(400,'動画ではありません。');return item;};
  const publicData=(item,userId)=>{const row=get(item.id);return {revision:row?.revision??0,state:row?.state??'missing',durationMs:row?.duration_ms??0,chapters:JSON.parse(row?.chapters_json??'[]'),captions:JSON.parse(row?.captions_json??'[]'),storyboard:row?.storyboard_json?{...JSON.parse(row.storyboard_json),url:`/api/v1/items/${item.id}/navigation/storyboard?revision=${row.revision}`} :null,canEdit:['owner','editor'].includes(membership(item.shelf_id,userId))};};
  const auth={onRequest:async req=>authenticate(req)};
  function schedule(row){
    if(closing||pending.has(row.item_id))return;
    const work=context.jobPool.run(async()=>{
      const live=get(row.item_id);if(live?.state!=='queued')return;const controller=new AbortController();controllers.add(controller);
      const authorize=()=>{if(closing)throw Object.assign(Error('Closing'),{code:'SERVER_CLOSING'});const item=db.prepare('SELECT * FROM items WHERE id=?').get(row.item_id);if(!item||!row.requester_id||!db.prepare('SELECT 1 FROM users WHERE id=?').get(row.requester_id)||db.prepare('SELECT disabled FROM user_access WHERE user_id=?').get(row.requester_id)?.disabled||!db.prepare('SELECT 1 FROM memberships WHERE shelf_id=? AND user_id=?').get(item.shelf_id,row.requester_id))throw httpError(403,'準備の権限が失効しました。');return item;};
      const guard=setInterval(()=>{try{authorize();}catch(error){controller.abort(error);}},1000);
      try{
        const item=authorize();db.prepare("UPDATE video_navigation SET state='running' WHERE item_id=?").run(item.id);db.prepare("UPDATE admin_jobs SET state='running',updated_at=? WHERE id=?").run(Date.now(),live.job_id);
        const selected=await selectVideoSource({...context,item});const result=await (context.generateNavigation??generateNavigation)(selected.path,{signal:controller.signal,authorize});authorize();
        transaction(db,()=>{const current=get(item.id),manual=JSON.parse(current.captions_json).filter(c=>!c.id.startsWith('embedded-'));const tracks=[...manual,...result.captions].slice(0,12);if(Buffer.byteLength(JSON.stringify(tracks))>MAX)throw Error('Caption limit');db.prepare("UPDATE video_navigation SET revision=revision+1,state='ready',duration_ms=?,chapters_json=?,captions_json=?,storyboard_json=?,storyboard=?,error=NULL,updated_at=? WHERE item_id=?").run(result.durationMs,current.chapters_manual?current.chapters_json:JSON.stringify(result.chapters),JSON.stringify(tracks),JSON.stringify(result.storyboard),result.image,Date.now(),item.id);db.prepare("UPDATE admin_jobs SET state='complete',progress_json='{}',updated_at=? WHERE id=?").run(Date.now(),live.job_id);});
      }catch(error){const state=closing?'queued':'failed';db.prepare('UPDATE video_navigation SET state=?,error=?,updated_at=? WHERE item_id=?').run(state,closing?null:'場面画像の準備に失敗しました。動画の再生は引き続き利用できます。',Date.now(),row.item_id);db.prepare('UPDATE admin_jobs SET state=?,error=?,updated_at=? WHERE id=?').run(state,closing?null:'動画ナビゲーションの準備に失敗しました。',Date.now(),live.job_id);if(!closing)app.log.warn({err:error},'Video navigation preparation failed');}
      finally{clearInterval(guard);controllers.delete(controller);}
    },row.job_id,'other').finally(()=>pending.delete(row.item_id));const watched=work.catch(error=>app.log.error({err:error},'Video navigation queue failure'));pending.set(row.item_id,watched);
  }
  db.prepare("UPDATE video_navigation SET state='queued' WHERE state='running'").run();db.prepare("UPDATE admin_jobs SET state='queued' WHERE kind='navigation' AND state='running'").run();
  for(const row of db.prepare("SELECT * FROM video_navigation WHERE state='queued'").all())schedule(row);
  app.get('/api/v1/items/:id/navigation',auth,async req=>publicData(asset(req),req.user.id));
  app.post('/api/v1/items/:id/navigation/prepare',{...auth,config:{rateLimit:context.rateLimit===false?false:{max:3,timeWindow:'1 minute'}}},async(req,reply)=>{
    const item=asset(req);if(maintenance.locked)throw httpError(409,'保守処理中です。');let row=get(item.id);
    if(row?.state==='failed'||req.body?.regenerate===true) {findItem(item.id,req.user.id,['owner','editor']);if(req.body?.acknowledgeCost!==true)throw httpError(409,'再準備には処理負荷の確認が必要です。');}
    if(!row||row.state==='failed'||(row.state==='ready'&&req.body?.regenerate===true)){
      if(pending.size>=4||db.prepare("SELECT 1 FROM admin_jobs WHERE asset_id=? AND state IN ('queued','running')").get(item.id))return reply.code(202).send({state:'busy'});
      const id=randomUUID(),now=Date.now();transaction(db,()=>{db.prepare("INSERT INTO admin_jobs(id,kind,asset_id,state,requested_by,created_at,updated_at) VALUES(?,'navigation',?,'queued',NULL,?,?)").run(id,item.id,now,now);db.prepare("INSERT INTO video_navigation(item_id,revision,state,job_id,requester_id,updated_at) VALUES(?,0,'queued',?,?,?) ON CONFLICT(item_id) DO UPDATE SET state='queued',job_id=excluded.job_id,requester_id=excluded.requester_id,error=NULL").run(item.id,id,req.user.id,now);});row=get(item.id);schedule(row);
    }
    return reply.code(['queued','running'].includes(row.state)?202:200).send(publicData(item,req.user.id));
  });
  app.get('/api/v1/items/:id/navigation/storyboard',auth,async(req,reply)=>{const item=asset(req),row=get(item.id);if(!row?.storyboard)throw httpError(404,'場面画像はまだありません。');return reply.type('image/jpeg').send(Buffer.from(row.storyboard));});
  app.put('/api/v1/items/:id/navigation',{...auth,bodyLimit:MAX+4096},async req=>{
    const item=asset(req);findItem(item.id,req.user.id,['owner','editor']);const row=get(item.id),body=req.body;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['revision','chapters','subtitle','removeSubtitle'].includes(k))||!Number.isSafeInteger(body.revision)||body.revision<0||body.subtitle!==undefined&&(!body.subtitle||typeof body.subtitle!=='object'||Array.isArray(body.subtitle)||Object.keys(body.subtitle).some(k=>!['label','language','text'].includes(k)))||body.removeSubtitle!==undefined&&typeof body.removeSubtitle!=='string')throw httpError(400,'動画ナビゲーションの更新内容が不正です。');
    if(maintenance.locked||['queued','running'].includes(row?.state))throw httpError(409,'準備・保守処理中です。完了後に更新してください。');
    if(!row?.duration_ms)throw httpError(409,'先に動画ナビゲーションを準備してください。');if(!body||body.revision!==row.revision)throw httpError(409,'別の操作で更新されました。再読み込みしてください。');
    let chapters=JSON.parse(row.chapters_json),captions=JSON.parse(row.captions_json);if(body.chapters!==undefined)chapters=validateChapters(body.chapters,row.duration_ms);
    if(body.subtitle){if(captions.length>=12)throw httpError(400,'字幕は12件以内です。');if(typeof body.subtitle.label!=='string'||body.subtitle.label.length>80||!/^[a-zA-Z-]{2,20}$/.test(body.subtitle.language??''))throw httpError(400,'字幕の言語・名前が不正です。');captions.push({id:randomUUID(),label:plain(body.subtitle.label,80),language:body.subtitle.language,cues:parseSubtitles(body.subtitle.text,row.duration_ms)});}
    if(body.removeSubtitle!==undefined)captions=captions.filter(c=>c.id!==body.removeSubtitle);
    if(Buffer.byteLength(JSON.stringify(captions))>MAX)throw httpError(400,'字幕データが大きすぎます。');
    db.prepare('UPDATE video_navigation SET revision=revision+1,chapters_json=?,chapters_manual=?,captions_json=?,updated_at=? WHERE item_id=?').run(JSON.stringify(chapters),body.chapters!==undefined?1:row.chapters_manual,JSON.stringify(captions),Date.now(),item.id);return publicData(item,req.user.id);
  });
  app.addHook('onClose',async()=>{closing=true;for(const c of controllers)c.abort();await Promise.allSettled([...pending.values()]);});
  return {forceStart(id,userId){const row=db.prepare("SELECT * FROM video_navigation WHERE job_id=? AND state='queued'").get(id);if(!row)throw httpError(409,'準備待ちのジョブを選んでください。');schedule(row);return context.jobPool.forceStart(id,userId);},get busy(){return pending.size>0;}};
}
