/** Keyboard intent, shared by pointer-free / focused-timeline playback tests. */
export function playerKey(event,{paused=false,seekFocused=false}={}){
  if(event.altKey||event.metaKey)return null;
  if(event.ctrlKey)return event.key==='ArrowRight'?['chapter',1]:event.key==='ArrowLeft'?['chapter',-1]:null;
  const key=event.key,lower=key.toLowerCase();
  if(event.shiftKey&&['n','p'].includes(lower))return ['navigate',lower==='n'?1:-1];
  if(key==='>'||key==='<')return ['speed',key==='>'?.25:-.25];
  if(paused&&(key===','||key==='.'))return ['frame',key==='.'?1:-1];
  if(key===' '||lower==='k')return ['play'];
  if(lower==='j'||lower==='l')return ['seek',lower==='l'?10:-10];
  if(key==='ArrowLeft'||key==='ArrowRight')return ['seek',key==='ArrowRight'?5:-5];
  if(key==='ArrowUp'||key==='ArrowDown')return seekFocused?['seek',key==='ArrowUp'?5:-5]:['volume',key==='ArrowUp'?.05:-.05];
  if(key==='Home'||key==='End')return ['fraction',key==='Home'?0:1];
  if(/^[0-9]$/.test(key))return ['fraction',Number(key)/10];
  return ({m:['mute'],f:['fullscreen'],i:['minimize'],c:['captions']})[lower]??null;
}
export const chapterAt=(chapters,time)=>chapters.filter(c=>c.startMs<=time*1000).at(-1);
export function chapterJump(chapters,time,direction){return direction>0?(chapters.find(c=>c.startMs>time*1000+500)?.startMs??time*1000)/1000:(chapters.filter(c=>c.startMs<time*1000-1500).at(-1)?.startMs??0)/1000;}
export function spriteFrame(sheet,time){const i=Math.max(0,Math.min(sheet.count-1,Math.floor(time*1000/sheet.intervalMs)));return {index:i,x:i%sheet.columns*sheet.width,y:Math.floor(i/sheet.columns)*sheet.height};}
