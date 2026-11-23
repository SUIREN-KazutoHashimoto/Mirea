import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {transaction} from './database.js';
import {layoutRadio,onAir,radioFadeMs} from './radio-crossfade.js';
import {composeFm} from './radio-fm.js';
import {buildAutodjPlan,defaultAutodj,validateAutodj,rotationTracks,radioCycle} from './radio-autodj.js';
import {createDynamicRadio,radioPlanKey,dynamicLimit} from './radio-dynamic.js';
import {createRadioBulletin} from './radio-headlines.js';
import {createAiStore} from './ai-store.js';
import {shortOpeningHint} from './ai-music-structure.js';
import {resolveAiInput} from './ai-input.js';
import {httpError} from './security.js';
import {openStationFile} from './radio.js';
import {prepareSavedRadioPlan,radioPlaylistId,MAX_BYTES} from './radio-playlist.js';

const visibility = ['public','unlisted','private'];
const hash = text => createHash('sha256').update(text).digest('hex');
const inaccessible = () => httpError(404,'ラジオ局が見つからないか、再生できません。');
const dto = (row,user,fm,autodj,crossfadeMs) => ({id:row.id,name:row.name,visibility:row.visibility,mine:row.user_id===user,
  ...(row.user_id===user ? {playlistId:row.playlist_id,revision:row.revision,autodj,crossfadeMs,...(fm?{fm}: {})} : {})});

export async function registerRadioStations(app,{db,authenticate,enabledUser,uploadDir,now=Date.now,rateLimit,fmClips=new Map(),radioFm=false,originalDir,dynamicEnabled=false,dynamicRenderer,dynamicPoll,headlineFile}) {
  const uploads = await realpath(uploadDir);
  const get = db.prepare('SELECT * FROM radio_stations WHERE id=?');
  const readPlan = prepareSavedRadioPlan(db);
  const readFm=db.prepare('SELECT mc,jingle FROM radio_fm_profiles WHERE station_id=?');
  const readPrefs=id=>readFm.get(id)??{mc:'off',jingle:'off'};
  const autodjRow=db.prepare('SELECT mode,playlist_ids_json FROM radio_autodj WHERE station_id=?');
  function readAutodj(station){
    const row=autodjRow.get(station.id);
    if(!row)return defaultAutodj(station.playlist_id);
    return validateAutodj({mode:row.mode,playlistIds:JSON.parse(row.playlist_ids_json)},station.playlist_id);
  }
  const fadeRow=db.prepare('SELECT crossfade_ms FROM radio_mix_profiles WHERE station_id=?');
  const readFade=id=>fadeRow.get(id)?.crossfade_ms??0;
  const view=(row,user)=>dto(row,user,radioFm&&row.user_id===user?readPrefs(row.id):null,row.user_id===user?readAutodj(row):undefined,row.user_id===user?readFade(row.id):undefined);
  const stationPlan=station=>{const settings=readAutodj(station);return settings?buildAutodjPlan(station,settings,readPlan):null;};
  const member = db.prepare('SELECT 1 FROM memberships WHERE shelf_id=? AND user_id=?');
  let planner;
  if(dynamicEnabled){
    const candidates=db.prepare("SELECT s.* FROM radio_stations s JOIN radio_fm_profiles p ON s.id=p.station_id WHERE p.mc<>'off' ORDER BY s.id LIMIT ?");
    const song=db.prepare('SELECT * FROM items WHERE id=?');
    const audit=createAiStore(db);
    planner=createDynamicRadio({now,pollMs:dynamicPoll,bulletin:createRadioBulletin(headlineFile),render:dynamicRenderer??(async()=>new Map()),
      error:()=>app.log.warn('Local radio cue preparation failed; playing available music'),
      scan:()=>candidates.all(dynamicLimit.stations).flatMap(station=>{
        if(!enabledUser(station.user_id))return [];
        const plan=stationPlan(station);
        return plan?.owner===station.user_id?[{station,plan,prefs:readPrefs(station.id)}]:[];
      }),
      analyze:async track=>{
        const row=song.get(track.id);
        if(!row||!originalDir)return null;
        const analysis=audit.read(track.id,'structure',{unit:0});
        if(!analysis||analysis.provenance?.totalUnits!==1||analysis.provenance?.successfulUnits!==1||
           analysis.provenance.failedUnits?.length||analysis.unresolved?.length)return null;
        const current=await resolveAiInput({db,uploadDir,originalDir},row);
        if(current.stamp!==analysis.inputStamp||Math.abs(current.durationMs-track.durationMs)>150)return null;
        return shortOpeningHint(analysis.result.segments,track.durationMs);
      }
    });
    app.addHook('onClose',async()=>planner.close());
  }
  const auth = {onRequest:async(req,reply)=>{reply.header('Cache-Control','no-store');authenticate(req);}};
  const write = {...auth,bodyLimit:2048,config:{rateLimit:rateLimit===false?false:{max:30,timeWindow:'1 minute'}}};
  const mine = req => {const station=get.get(req.params.id);if(!station||station.user_id!==req.user.id)throw inaccessible();return station;};
  function checkRevision(req,station) {
    if(!Number.isSafeInteger(req.body?.revision))throw httpError(400,'局の更新番号が必要です。');
    if(req.body.revision!==station.revision)throw httpError(409,'局は更新済みです。読み込み直してください。');
  }
  function authorize(req,clock=now()) {
    const station=get.get(req.params.id), listener=req.user.id;
    if(!station||!enabledUser(station.user_id))throw inaccessible();
    const outsider=listener!==station.user_id;
    const share=req.headers['x-mirea-radio-share'];
    if(outsider&&station.visibility==='private')throw inaccessible();
    if(share!==undefined||(outsider&&station.visibility==='unlisted')) {
      if(typeof share!=='string'||!/^[a-zA-Z0-9_-]{43}$/.test(share)||hash(share)!==station.share_hash)throw inaccessible();
    }
    const plan=stationPlan(station);
    if(!plan||plan.owner!==station.user_id||
       ![...new Set(plan.tracks.map(track=>track.shelfId))].every(shelf=>member.get(shelf,listener)))throw inaccessible();
    const prefs=radioFm?readPrefs(station.id):null, key=radioPlanKey(station,plan);
    const dynamic=planner&&prefs?.mc!=='off'?planner.current(station,plan,clock):null;
    // Dynamic MC has its own pre-committed clock; keep it unchanged whether a
    // particular cycle is warm or dry. Only settled song-to-song blocks overlap.
    const fadeMs=planner&&prefs?.mc!=='off'?0:readFade(station.id);
    let mix=dynamic,anchor=dynamic?.anchor??station.epoch,sequence=null;
    if(!mix){
      mix=composeFm(plan.tracks,prefs,fmClips);
      if(plan.rotation==='shuffle'){
        const length=layoutRadio(mix.segments,fadeMs).durationMs;
        sequence=radioCycle(clock,station.epoch,length);
        anchor+=sequence*length;
        mix=composeFm(rotationTracks(station,plan,sequence),prefs,fmClips);
      }
    }
    const generation=hash(JSON.stringify([key,sequence,...(fadeMs?[fadeMs]:[]),...mix.signature])).slice(0,32);
    return {station,segments:mix.segments,generation,anchor,fadeMs,withFm:dynamic?.audible??mix.signature.length>0,
      wrapStable:!dynamic&&plan.rotation!=='shuffle'};
  }
  function entry(req) {
    const {segments,generation}=authorize(req);
    const track=segments.find(track=>req.params.track===generation+'-'+track.id);
    if(!track)throw inaccessible();
    return track;
  }
  function save(req,previous) {
    const {name,playlistId,visibility:mode}=req.body??{};
    if(typeof name!=='string'||!name.trim()||name.length>120||typeof playlistId!=='string'||!radioPlaylistId.test(playlistId)||
       !visibility.includes(mode))throw httpError(422,'局名、プレイリスト、公開範囲を確認してください。');
    const past=previous?readAutodj(previous):null;
    const autodj=req.body?.autodj===undefined
      ? (previous?.playlist_id===playlistId?past:null)??defaultAutodj(playlistId)
      : validateAutodj(req.body.autodj,playlistId);
    if(!autodj)throw httpError(422,'AutoDJの方式と、主リストを先頭にした1〜5件の異なるプレイリストを確認してください。');
    const plan=buildAutodjPlan({user_id:req.user.id},autodj,readPlan);
    if(!plan)
      throw httpError(422,'自分の再生可能な音声プレイリストを選んでください。複数リストの合計は重複を除き200曲までです。');
    const id=previous?.id??randomUUID(), prior=readPrefs(id);
    const fm=req.body?.fm;
    const levels=['off','standard','enhanced'];
    if(fm!==undefined&&(!radioFm||!fm||Array.isArray(fm)||Object.keys(fm).length!==2||
       !levels.includes(fm.mc)||!levels.includes(fm.jingle)))throw httpError(422,'FM演出の設定を確認してください。');
    const previousFade=readFade(id), fadeMs=req.body?.crossfadeMs===undefined?previousFade:req.body.crossfadeMs;
    if(fadeMs!==0&&fadeMs!==radioFadeMs)throw httpError(422,'クロスフェードはオフか2.4秒を選んでください。');
    const changed=fm&&(fm.mc!==prior.mc||fm.jingle!==prior.jingle);
    const rotationChanged=JSON.stringify(autodj)!==JSON.stringify(past);
    const epoch=previous?.playlist_id===playlistId&&!changed&&!rotationChanged&&previousFade===fadeMs?previous.epoch:now();
    const share=mode==='unlisted'&&previous?.visibility!=='unlisted'?randomBytes(32).toString('base64url'):null;
    const shareHash=mode!=='unlisted'?null:share?hash(share):previous.share_hash;
    if(previous)db.prepare('UPDATE radio_stations SET name=?,playlist_id=?,visibility=?,share_hash=?,epoch=?,revision=revision+1 WHERE id=?')
      .run(name.trim(),playlistId,mode,shareHash,epoch,id);
    else {
      if(db.prepare('SELECT COUNT(*) n FROM radio_stations WHERE user_id=?').get(req.user.id).n>=25)throw httpError(422,'ラジオ局は25件まで作成できます。');
      db.prepare('INSERT INTO radio_stations(id,user_id,playlist_id,name,visibility,share_hash,epoch) VALUES(?,?,?,?,?,?,?)')
        .run(id,req.user.id,playlistId,name.trim(),mode,shareHash,epoch);
    }
    if(autodj.mode==='ordered'&&autodj.playlistIds.length===1)db.prepare('DELETE FROM radio_autodj WHERE station_id=?').run(id);
    else db.prepare('INSERT INTO radio_autodj VALUES(?,?,?) ON CONFLICT(station_id) DO UPDATE SET mode=excluded.mode,playlist_ids_json=excluded.playlist_ids_json')
      .run(id,autodj.mode,JSON.stringify(autodj.playlistIds));
    if(fadeMs===0)db.prepare('DELETE FROM radio_mix_profiles WHERE station_id=?').run(id);
    else db.prepare('INSERT OR IGNORE INTO radio_mix_profiles VALUES(?,?)').run(id,fadeMs);
    if(fm){
      db.prepare('INSERT INTO radio_fm_profiles VALUES(?,?,?) ON CONFLICT(station_id) DO UPDATE SET mc=excluded.mc,jingle=excluded.jingle')
        .run(id,fm.mc,fm.jingle);
    }
    return {station:view(get.get(id),req.user.id),...(share?{share}:{})};
  }
  app.get('/api/v1/radio/fm/preview/:clip',auth,async(req,reply)=>{
    const clip=fmClips.get(req.params.clip);
    if(!clip)throw inaccessible();
    reply.type('audio/mp4').header('Content-Length',clip.bytes.length);
    return reply.send(req.method==='HEAD'?undefined:clip.bytes);
  });
  app.get('/api/v1/radio/stations',auth,async req=>{
    const after=typeof req.query.after==='string'&&radioPlaylistId.test(req.query.after)?req.query.after:'';
    const rows=db.prepare("SELECT * FROM radio_stations WHERE visibility='public' AND id>? AND user_id<>? ORDER BY id LIMIT 101").all(after,req.user.id);
    const own=db.prepare('SELECT * FROM radio_stations WHERE user_id=? ORDER BY name,id').all(req.user.id);
    // Publication applies to the owner's authored station name, never playlist or track metadata.
    return {stations:[...(after?[]:own),...rows.slice(0,100).filter(row=>enabledUser(row.user_id))].map(row=>view(row,req.user.id)),
      next:rows.length>100?rows[99].id:null};
  });
  app.post('/api/v1/radio/stations',write,async(req,reply)=>reply.code(201).send(transaction(db,()=>save(req))));
  app.put('/api/v1/radio/stations/:id',write,async req=>transaction(db,()=>{
    const station=mine(req);checkRevision(req,station);return save(req,station);
  }));
  app.delete('/api/v1/radio/stations/:id',write,async(req,reply)=>{
    transaction(db,()=>{const station=mine(req);checkRevision(req,station);db.prepare('DELETE FROM radio_stations WHERE id=?').run(station.id);});
    return reply.code(204).send();
  });
  app.post('/api/v1/radio/stations/:id/rotate-link',write,async req=>transaction(db,()=>{
    const station=mine(req);checkRevision(req,station);
    if(station.visibility!=='unlisted')throw inaccessible();
    const share=randomBytes(32).toString('base64url');
    db.prepare('UPDATE radio_stations SET share_hash=?,revision=revision+1 WHERE id=?').run(hash(share),station.id);
    return {station:view(get.get(station.id),req.user.id),share};
  }));
  app.get('/api/v1/radio/stations/:id/now',auth,async req=>{
    const serverTime=now(),{station,segments,generation,anchor,fadeMs,withFm,wrapStable}=authorize(req,serverTime);
    const layout=layoutRadio(segments,fadeMs);
    const {span,index,cycleStart}=onAir(layout,serverTime,anchor);
    const {track}=span, next=segments[index+1]??(wrapStable?segments[0]:null);
    const mediaUrl=id=>'/api/v1/radio/stations/'+station.id+'/tracks/'+generation+'-'+id+'/content';
    return {station:station.name,title:track.title,serverTime,startTime:cycleStart+span.start,
      durationMs:track.durationMs,mediaUrl:mediaUrl(track.id),...(withFm?{kind:track.kind??'music',
        ...(track.credit?{credit:track.credit}:{})}:{}),...(next?{nextTitle:next.title,nextKind:next.kind??'music',
          ...(withFm?{nextMediaUrl:mediaUrl(next.id)}:{})}:{}),...(span.overlap?{crossfade:{
            startTime:cycleStart+span.end-span.overlap,durationMs:span.overlap,mediaUrl:mediaUrl(next.id),title:next.title
          }}:{})};
  });
  app.get('/api/v1/radio/stations/:id/tracks/:track/content',auth,async(req,reply)=>{
    const track=entry(req);
    if(track.bytes){
      reply.type('audio/mp4').header('Content-Length',track.bytes.length);
      return reply.send(req.method==='HEAD'?undefined:track.bytes);
    }
    let opened;
    try { opened=await openStationFile(uploads,track.id,MAX_BYTES,true); }
    catch { throw inaccessible(); }
    const {file,size}=opened;
    try { authenticate(req);entry(req);if(size!==track.size)throw inaccessible(); }
    catch(error) { await file.close();throw error; }
    reply.type('audio/mp4').header('Content-Length',size);
    if(req.method==='HEAD'){await file.close();return reply.send();}
    return reply.send(file.createReadStream({start:0,end:size-1}));
  });
}
