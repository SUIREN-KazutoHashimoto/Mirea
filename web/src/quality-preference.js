export function resolveQualityPreference(qualities,value){
  if(value==='auto')return 'auto';
  if(!/^\d{2,4}p$/.test(value??''))return 'auto';
  const sorted=qualities.filter(q=>/^\d{2,4}p$/.test(q.quality)).map(q=>q.quality).sort((a,b)=>parseInt(b)-parseInt(a));
  return sorted.find(q=>parseInt(q)<=parseInt(value))??sorted.at(-1)??'auto';
}
const key=(endpoint,userId)=>'mirea-playback-quality:'+encodeURIComponent(endpoint)+':'+userId;
export function loadQualityPreference(endpoint,userId,storage){try{const value=(storage??globalThis.localStorage)?.getItem(key(endpoint,userId));return value==='auto'||/^\d{2,4}p$/.test(value??'')?value:'auto';}catch{return 'auto';}}
export function saveQualityPreference(endpoint,userId,value,storage){if(value!=='auto'&&!/^\d{2,4}p$/.test(value??''))return;try{(storage??globalThis.localStorage)?.setItem(key(endpoint,userId),value);}catch{/* Playback remains usable with private/full storage. */}}
