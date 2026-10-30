// No media identity or credentials: only user-selected playback controls.
const fallback=new Map(),defaults={volume:1,muted:false,rate:1};
export function normalizePlayerPreferences(value={}){
 return {volume:Number.isFinite(value?.volume)&&value.volume>=0&&value.volume<=1?value.volume:1,muted:value?.muted===true,rate:Number.isFinite(value?.rate)&&value.rate>=.25&&value.rate<=2?value.rate:1};
}
export function playerPreferences(scope='',storage){
 const key='mirea.player.v1:'+scope;
 let value;try{storage??=globalThis.localStorage;const saved=storage?.getItem(key);value=normalizePlayerPreferences(fallback.get(key)??(saved?JSON.parse(saved):defaults));}catch{value=normalizePlayerPreferences(fallback.get(key)??defaults);}
 return {get value(){return {...value};},save(change){value=normalizePlayerPreferences({...value,...change});fallback.set(key,value);try{storage?.setItem(key,JSON.stringify(value));}catch{/* Playback continues when persistence is unavailable. */}return {...value};}};
}
