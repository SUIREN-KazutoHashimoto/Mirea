import {aiHash} from './ai-validation.js';

const labels=Object.freeze({intro:'イントロ',verse:'Aメロ',chorus:'サビ',bridge:'ブリッジ',inst:'間奏',
  break:'ブレイク',solo:'ソロ',outro:'アウトロ',start:'開始',end:'終了'});
const mergeGapMs=150, maxSegments=2000;
const validDuration=duration=>Number.isSafeInteger(duration)&&duration>0;

export function normalizeMusicStructure(raw,durationMs){
  const segments=raw?.segments, bpm=raw?.bpm;
  const summary=Number.isFinite(bpm)&&bpm>=30&&bpm<=260?'テンポの目安: '+Math.round(bpm)+' BPM':'';
  if(!validDuration(durationMs)||!Array.isArray(segments)||segments.length>maxSegments)return {summary,segments:[]};
  const clamp=ms=>Math.max(0,Math.min(durationMs,ms));
  const legacyCounts=new Map(), candidates=[];
  for(const segment of segments){
    if(!segment||typeof segment.label!=='string'||!Object.hasOwn(labels,segment.label)||!Number.isFinite(segment.start)||
       !Number.isFinite(segment.end)||segment.end<=segment.start)continue;
    const legacy='music:'+aiHash({start:Math.round(segment.start),label:segment.label}).slice(0,20);
    legacyCounts.set(legacy,(legacyCounts.get(legacy)??0)+1);
    const rawStart=Math.round(segment.start*1000), rawEnd=Math.round(segment.end*1000);
    const startMs=clamp(rawStart),endMs=clamp(rawEnd);
    if(endMs<=startMs)continue;
    candidates.push({startMs,endMs,kind:segment.label,legacy:startMs===rawStart&&endMs===rawEnd?legacy:null});
  }
  // Earlier evidence wins an overlapping region. Equal starts with contradictory
  // labels are ambiguous: discard both at that timestamp, not pick an arbitrary label.
  candidates.sort((a,b)=>a.startMs-b.startMs||b.endMs-a.endMs||(a.kind<b.kind?-1:a.kind>b.kind?1:0));
  const stable=[];
  for(let i=0;i<candidates.length;){
    let end=i+1;
    while(end<candidates.length&&candidates[end].startMs===candidates[i].startMs)end++;
    const group=candidates.slice(i,end), current={...group[0]};
    i=end;
    if(group.some(c=>c.kind!==current.kind))continue;
    if(group.length>1)current.legacy=null;
    const last=stable.at(-1);
    if(last?.kind===current.kind&&current.startMs<=last.endMs+mergeGapMs){
      const extended=Math.max(last.endMs,current.endMs);
      if(extended!==last.endMs||group.length>1)last.legacy=null;
      last.endMs=extended;continue;
    }
    if(last&&current.startMs<last.endMs){
      current.startMs=last.endMs;current.legacy=null;
    }
    if(current.endMs>current.startMs)stable.push(current);
  }
  return {summary,segments:stable.map(({startMs,endMs,kind,legacy})=>({
    id:legacy&&legacyCounts.get(legacy)===1?legacy:'music:v2:'+aiHash([startMs,endMs,kind]).slice(0,20),
    startMs,endMs,kind,label:labels[kind],text:''
  }))};
}

// Pacing hint only. A scored structure label is never clearance for speech to
// overlap the music. Both the bounded opening and its adjacent following
// evidence must be present; existing edits are validated rather than flattened.
export function shortOpeningHint(segments,durationMs){
  if(!validDuration(durationMs)||!Array.isArray(segments)||segments.length<2||
     segments.some((s,i)=>!s||!Number.isSafeInteger(s.startMs)||!Number.isSafeInteger(s.endMs)||
        s.startMs<0||s.endMs<=s.startMs||s.endMs>durationMs||(i>0&&s.startMs<segments[i-1].endMs)))return null;
  const [intro,next]=segments, length=intro.endMs-intro.startMs;
  if(intro.kind!=='intro'||intro.startMs>250||length<700||length>=9000||next.startMs-intro.endMs>250||
     typeof next.kind!=='string'||!Object.hasOwn(labels,next.kind)||['start','end','intro'].includes(next.kind)||next.endMs-next.startMs<700)return null;
  return 'short';
}
