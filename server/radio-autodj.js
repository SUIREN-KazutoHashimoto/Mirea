import {createHash} from 'node:crypto';
import {radioPlaylistId} from './radio-playlist.js';

// Bounded hint cache: only ordered asset IDs, no titles, media, or access decisions.
const rotations=new Map(), cacheLimit=64;

export const maxSources=5;
export const maxRotationTracks=200;
export const defaultAutodj=id=>({mode:'ordered',playlistIds:[id]});
export function validateAutodj(value,primary) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||
    !['ordered','shuffle'].includes(value.mode)||!Array.isArray(value.playlistIds)||
    value.playlistIds.length<1||value.playlistIds.length>maxSources||value.playlistIds[0]!==primary||
    new Set(value.playlistIds).size!==value.playlistIds.length||
    value.playlistIds.some(id=>typeof id!=='string'||!radioPlaylistId.test(id)))return null;
  return {mode:value.mode,playlistIds:[...value.playlistIds]};
}

export function buildAutodjPlan(station,settings,read) {
  const sources=[], tracks=[], seen=new Set();
  for(const id of settings.playlistIds){
    const plan=read(id);
    // Do not silently switch to a different program when a source became
    // inaccessible. Owner must repair or remove the source; playlists never grant access.
    if(!plan||plan.owner!==station.user_id)return null;
    sources.push([id,plan.revision]);
    for(const track of plan.tracks){
      if(seen.has(track.id))continue;
      if(tracks.length>=maxRotationTracks)return null;
      seen.add(track.id);tracks.push(track);
    }
  }
  if(!tracks.length)return null;
  return {owner:station.user_id,rotation:settings.mode,sources,tracks};
}

export function rotationTracks(station,plan,sequence) {
  if(plan.rotation!=='shuffle'||plan.tracks.length<2)return plan.tracks;
  // Seeded rank ordering is stable across listeners and restarts. With only
  // two tracks, changing the order would repeat a song over the round seam.
  const salt=JSON.stringify([station.id,station.epoch,plan.sources?.map(([id])=>id),plan.tracks.map(track=>track.id)]);
  const key=salt+':'+(plan.tracks.length===2?0:sequence), cached=rotations.get(key);
  if(cached){
    rotations.delete(key);rotations.set(key,cached);
    const tracks=new Map(plan.tracks.map(track=>[track.id,track]));
    return cached.map(id=>tracks.get(id));
  }
  const rank=(track,suffix)=>createHash('sha256').update(salt).update('\x00').update(suffix)
    .update('\x00').update(track.id).digest('hex');
  const byRank=(a,b)=>a.rank<b.rank?-1:a.rank>b.rank?1:a.track.id<b.track.id?-1:1;
  const stable=plan.tracks.map(track=>({track,rank:rank(track,'first')})).sort(byRank);
  const firstAt=n=>stable[((n%stable.length)+stable.length)%stable.length].track;
  let ordered;
  if(stable.length===2)ordered=stable.map(entry=>entry.track);
  else {
    const first=firstAt(sequence), next=firstAt(sequence+1);
    const rest=plan.tracks.filter(track=>track.id!==first.id)
      .map(track=>({track,rank:rank(track,String(sequence))})).sort(byRank).map(entry=>entry.track);
    // At least two tracks remain. The next round's first is calculable without
    // visiting earlier/later rounds or depending on cache/render order.
    const last=rest.length-1;
    if(rest[last].id===next.id)[rest[last-1],rest[last]]=[rest[last],rest[last-1]];
    ordered=[first,...rest];
  }
  rotations.set(key,ordered.map(track=>track.id));
  if(rotations.size>cacheLimit)rotations.delete(rotations.keys().next().value);
  return ordered;
}

export const radioCycle= (clock,anchor,duration)=>Math.floor(Math.max(0,clock-anchor)/duration);
