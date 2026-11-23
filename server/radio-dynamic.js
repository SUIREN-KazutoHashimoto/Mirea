import {createHash} from 'node:crypto';
import {rotationTracks,radioCycle} from './radio-autodj.js';

export const dynamicLimit={stations:6,clips:24,bytes:256*1024,seconds:20};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Metadata-only edits do not break an active air clock. Audience or media
// changes still invalidate captured URLs and are rechecked independently.
export const radioProgramKey=(station,plan)=>hash([station.id,station.epoch,plan.owner,plan.rotation,
  plan.sources?.map(([id])=>id),plan.tracks.map(({id,shelfId,size,durationMs})=>[id,shelfId,size,durationMs])]);
export const radioPlanKey=(station,plan)=>hash([radioProgramKey(station,plan),station.visibility,station.share_hash]);
const dryLength=tracks=>tracks.reduce((sum,track)=>sum+track.durationMs,0);

function speechLabel(value,fallback) {
  return Array.from(String(value??'').slice(0,600).normalize('NFKC')
    .replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+|[A-Za-z0-9_-]{20,}/gi,' ')
    .replace(/[^\p{L}\p{N}ー・ &-]/gu,' ').replace(/\s+/g,' ').trim()).slice(0,36).join('')||fallback;
}
export const isMcBoundary=(sequence,trackCount,index)=>
  ((sequence%2)*(trackCount%2)+(index+1)%2)%2===0;

function copyFor(station,target,index,sequence,count,prefs,hint,bulletin){
  const name=speechLabel(station.name,'このラジオ');
  const song=speechLabel(target.title,'次の一曲');
  const express=prefs.mc==='enhanced'&&hint!=='short';
  const short=[
    'ひと息ついて、次は、'+song+'。',
    '手を止めずに、耳だけこちらへ。次は、'+song+'。',
    'ここからも音楽を。お届けするのは、'+song+'。',
    '肩の力を抜いて。次は、'+song+'。',
    '曲が変わると、気分も少し変わりますね。次は、'+song+'。',
    name+'から、もう一曲。'+song+'。'
  ];
  const chat=[
    '同じ道でも、聴く曲が変わると景色まで違って見えること、ありますよね。次は、'+song+'。',
    '作業に集中していると、飲み物を置いたままにしがちです。そろそろ一口どうぞ。次は、'+song+'。',
    '曲の頭でふっと空気が変わる瞬間、いいですよね。次は、'+song+'をお届けします。',
    '何をするでもなく、音楽だけ聴く時間。たまにはそんな数分もいいですね。次は、'+song+'。',
    'お気に入りは、最初から好きでしたか。それとも、あとでじわじわ来ましたか。次は、'+song+'。',
    'いつもの場所で聴いている方も、途中で見つけてくれた方も、' + name + 'です。次は、'+song+'。'
  ];
  const pool=express?chat:short;
  // BigInt avoids large round*trackCount overflowing JS integer precision.
  const slot=(BigInt(sequence)*BigInt(count)+BigInt(index+1))/2n;
  const variant=Number(slot%BigInt(pool.length));
  return {id:'mc-'+index,quality:express?'enhanced':'standard',
    text:bulletin?.speech??pool[variant]};
}
function firstDry(station,plan,now) {
  const length=dryLength(plan.tracks), sequence=radioCycle(now,station.epoch,length);
  const start=station.epoch+sequence*length;
  return {sequence,start,end:start+length,segments:rotationTracks(station,plan,sequence),signature:[]};
}

export function createDynamicRadio({scan,render,analyze=async()=>null,bulletin=async()=>null,now=Date.now,pollMs=500,error=()=>{},scheduler=true}) {
  const state=new Map(), shutdown=new AbortController();
  let busy,rotation=0;
  function rememberBulletin(value,cycle,clock){
    if(cycle.bulletinId&&clock>=cycle.start+cycle.bulletinOffset&&!value.previousIds.includes(cycle.bulletinId))
      value.previousIds=[...value.previousIds,cycle.bulletinId].slice(-32);
  }
  function advance(value,clock){
    let cycle=value.current;
    rememberBulletin(value,cycle,clock);
    if(clock<cycle.end)return cycle;
    const prepared=value.pending;
    // A remote listener cannot change readiness; generation completes in the
    // planner only. After this cutoff, nobody can insert a late clip.
    if(prepared?.sequence===cycle.sequence+1&&prepared.readyAt<=cycle.end){
      cycle={...prepared,start:cycle.end,end:cycle.end+dryLength(prepared.segments)};
      rememberBulletin(value,cycle,clock);
      value.pending=null;
    }
    if(clock>=cycle.end){
      const length=dryLength(value.tracks), elapsed=Math.floor((clock-cycle.end)/length);
      const start=cycle.end+elapsed*length;
      const sequence=cycle.sequence+1+elapsed;
      cycle={sequence,start,end:start+length,segments:rotationTracks(value.station,value.plan,sequence),signature:[]};
      if(value.pending&&value.pending.sequence<=cycle.sequence)value.pending=null;
    }
    value.current=cycle;
    return cycle;
  }
  function current(station,plan,clock=now()){
    const key=radioProgramKey(station,plan), tracked=state.get(station.id);
    const active=tracked?.key===key?advance(tracked,clock):firstDry(station,plan,clock);
    const currentTracks=new Map(plan.tracks.map(track=>[track.id,track]));
    const segments=active.segments.map(segment=>segment.kind==='mc'?segment:currentTracks.get(segment.id)??segment);
    return {segments,anchor:active.start,signature:['dynamic',active.sequence,...active.signature],
      audible:active.signature.length>0};
  }
  async function prepare(){
    const candidates=scan(),seen=new Set(candidates.map(c=>c.station.id));
    for(const id of state.keys())if(!seen.has(id))state.delete(id);
    if(!candidates.length)return;
    // One native batch globally; round robin over the bounded station set.
    for(let step=0;step<candidates.length;step++){
      const {station,plan,prefs}=candidates[rotation++%candidates.length],key=radioProgramKey(station,plan);
      let tracked=state.get(station.id);
      if(tracked?.key!==key){
        tracked={key,station,plan,tracks:plan.tracks,current:firstDry(station,plan,now()),pending:null,tried:-1,previousIds:[]};
        state.set(station.id,tracked);
      }
      const cycle=advance(tracked,now()), target=cycle.sequence+1;
      if(tracked.tried===target||cycle.end-now()>180000)continue; // keep synthesis near the deadline on long playlists
      tracked.tried=target;
      const ordered=rotationTracks(station,plan,target), following=rotationTracks(station,plan,target+1);
      const start=(target-1)%ordered.length, candidatesByPosition=new Map();
      const prefix=[0];
      for(const track of ordered)prefix.push(prefix.at(-1)+track.durationMs);
      const positionCount=ordered.reduce((count,_,index)=>count+Number(isMcBoundary(target,ordered.length,index)),0);
      let newsId=null, newsIndex=-1;
      for(let cursor=0;cursor<ordered.length&&candidatesByPosition.size<dynamicLimit.clips;cursor++){
        if(shutdown.signal.aborted)return;
        const index=(start+cursor)%ordered.length;
        if(!isMcBoundary(target,ordered.length,index))continue;
        const next=ordered[index+1]??following[0];
        const hint=await analyze(next).catch(()=>null);
        let approved=null;
        // Try one slot only. Require the source to cover the latest plausible
        // start (all earlier clips at maximum duration) and the whole clip.
        if(newsIndex<0){
          newsIndex=index;
          const from=cycle.end+prefix[index+1];
          const until=from+Math.min(positionCount,dynamicLimit.clips)*dynamicLimit.seconds*1000;
          const previousIds=[...new Set([...tracked.previousIds,cycle.bulletinId].filter(Boolean))];
          const news=await bulletin({scheduledAt:from,until,previousIds}).catch(()=>null);
          if(now()>cycle.end||shutdown.signal.aborted)return;
          if(news&&typeof news.id==='string'&&!previousIds.includes(news.id)&&typeof news.speech==='string'&&
             news.speech.length>0&&news.speech.length<=120){approved=news;newsId=news.id;}
        }
        candidatesByPosition.set(index,copyFor(station,next,index,target,ordered.length,prefs,hint,approved));
      }
      if(!candidatesByPosition.size)return;
      if(shutdown.signal.aborted)return;
      let ready;
      try { ready=await render([...candidatesByPosition.values()],prefs,shutdown.signal); }
      catch { if(!shutdown.signal.aborted)error();return; } // no metadata or child stderr logged
      const readyAt=now();
      if(shutdown.signal.aborted||state.get(station.id)!==tracked||tracked.current.sequence!==cycle.sequence||readyAt>cycle.end)return;
      const segments=[],signature=[];
      for(const [index,track] of ordered.entries()){
        segments.push(track);
        const request=candidatesByPosition.get(index), clip=request&&ready.get(request.id);
        if(!clip||!Number.isSafeInteger(clip.durationMs)||clip.durationMs<700||clip.durationMs>dynamicLimit.seconds*1000||
            !Buffer.isBuffer(clip.bytes)||clip.bytes.length>dynamicLimit.bytes||!clip.bytes.length)continue;
        const id='link-'+index, credit=clip.credit;
        segments.push({id,title:'MC',kind:'mc',durationMs:clip.durationMs,bytes:clip.bytes,credit});
        signature.push([id,clip.durationMs,createHash('sha256').update(clip.bytes).digest('hex')]);
      }
      const bulletinIndex=segments.findIndex(segment=>segment.id==='link-'+newsIndex);
      tracked.pending={segments,signature,sequence:target,readyAt,
        bulletinId:bulletinIndex>=0?newsId:null,bulletinOffset:dryLength(segments.slice(0,bulletinIndex))};
      return;
    }
  }
  function pump(){
    if(!busy&&!shutdown.signal.aborted)busy=prepare().catch(()=>{if(!shutdown.signal.aborted)error();}).finally(()=>{busy=null;});
    return busy;
  }
  const interval=scheduler?setInterval(()=>void pump(),pollMs):null;
  interval?.unref();
  return {current,pump,async close(){shutdown.abort();if(interval)clearInterval(interval);await busy;state.clear();}};
}
