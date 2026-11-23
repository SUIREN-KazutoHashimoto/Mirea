import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {lstat,open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

export const DEFAULT_PRIMARY_HOSTS=Object.freeze([
  'www.jma.go.jp','www.data.jma.go.jp','www.mlit.go.jp','www.kantei.go.jp',
  'www.city.sapporo.jp','www.pref.hokkaido.lg.jp','www.bunka.go.jp','www.mext.go.jp',
  'www.mhlw.go.jp','www.meti.go.jp','www.mofa.go.jp',
]);
const MAX_BYTES=16*1024, MAX_INPUT=8, MAX_OUTPUT=4, JST=9*3600_000, DAY=24*3600_000;
const decoder=new TextDecoder('utf-8',{fatal:true});
const plainRecord=(val,fields)=>val!==null&&typeof val==='object'&&!Array.isArray(val)&&
  Object.getPrototypeOf(val)===Object.prototype&&Object.keys(val).length===fields.length&&
  fields.every(k=>Object.hasOwn(val,k));
const unsafeText=/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>\[\]{}\\]/u;
function plainText(val,max) {
  if(typeof val!=='string'||!val||[...val].length>max||val.trim()!==val||
     unsafeText.test(val)||/(?:https?:|www\.|@)/iu.test(val))return null;
  return val;
}
function jstDay(ms) {
  if(!Number.isSafeInteger(ms)||ms<946652400000||ms>4102412399999)return null;
  return new Date(ms+JST).toISOString().slice(0,10);
}
function instant(value) {
  if(typeof value!=='string'||!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/.test(value))return null;
  const ms=Date.parse(value);
  if(!Number.isSafeInteger(ms)||!jstDay(ms))return null;
  return new Date(ms+JST).toISOString().slice(0,19)===value.slice(0,19)?ms:null;
}
function parseInput(raw) {
  if(typeof raw==='string'){
    if(raw.length>MAX_BYTES||Buffer.byteLength(raw,'utf8')>MAX_BYTES)return null;
  }else if(raw instanceof Uint8Array&&raw.byteLength<=MAX_BYTES){
    try {raw=decoder.decode(raw);} catch {return null;}
  }else return null;
  try {return JSON.parse(raw);} catch {return null;}
}
function provenance(raw, hosts) {
  if(typeof raw!=='string'||raw.length>320||raw!==raw.trim()||!raw.startsWith('https://')||
     /[\p{Cc}\p{Cf}\p{Z}\s\\]/u.test(raw))return null;
  let u;
  try {u=new URL(raw);if(unsafeText.test(decodeURIComponent(u.pathname)))return null;} catch {return null;}
  // Kept only as provenance; this module never requests URLs. v1 intentionally
  // excludes queries and fragments so credentials/tracker data are not retained.
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||
     !hosts.has(u.hostname)||u.pathname==='/'||/\/\//u.test(u.pathname))return null;
  return u.href;
}
const storyKey=sourceUrl=>createHash('sha256').update(sourceUrl).digest('hex').slice(0,32);
const topicKey=text=>text.normalize('NFKC').replace(/[\p{Z}\p{P}]/gu,'').toLowerCase();

/** Operator-reviewed local data only. Call with the known air time, not the render time. */
export function eligibleRadioHeadlines(raw, scheduledAt, previousIds=[], opts={}) {
  if(!opts||typeof opts!=='object'||Array.isArray(opts))return [];
  const latest=opts.latestAirEndMs??scheduledAt, dateJst=jstDay(scheduledAt);
  if(!dateJst||jstDay(latest)!==dateJst||latest<scheduledAt||
     !Array.isArray(previousIds)||previousIds.length>256||
     previousIds.some(id=>typeof id!=='string'||!(/^[a-f0-9]{32}$/.test(id))))return [];
  const input=parseInput(raw);
  if(!plainRecord(input,['version','dateJst','items'])||input.version!==1||
     input.dateJst!==dateJst||!Array.isArray(input.items)||input.items.length>MAX_INPUT)return [];
  const configured=opts.approvedSourceHosts??DEFAULT_PRIMARY_HOSTS;
  if(!Array.isArray(configured)||configured.length<1||configured.length>32||
     configured.some(host=>typeof host!=='string'||!(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(host))))return [];
  const hosts=new Set(configured), blocked=new Set(previousIds), topics=new Set(), out=[];
  const midnight=instant(dateJst+'T00:00:00+09:00');
  for(const item of input.items){
    if(!plainRecord(item,['sourceName','sourceUrl','publishedAt','expiresAt','summaryJa','editorialStatus'])||
       item.editorialStatus!=='verified-paraphrase')continue;
    const text=plainText(item.summaryJa,55), sourceName=plainText(item.sourceName,20);
    if(!text||!sourceName||!(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)))continue;
    const sourceUrl=provenance(item.sourceUrl,hosts);
    const publishedMs=instant(item.publishedAt), expiresMs=instant(item.expiresAt);
    if(!sourceUrl||publishedMs===null||expiresMs===null||publishedMs<midnight||
       publishedMs>scheduledAt||expiresMs<=latest||expiresMs<=publishedMs||expiresMs>midnight+DAY)continue;
    const id=storyKey(sourceUrl), topic=topicKey(text);
    if(blocked.has(id)||topics.has(topic))continue;
    blocked.add(id); topics.add(topic);
    out.push({id,text,sourceName,sourceUrl,publishedMs,expiresMs,dateJst});
    if(out.length>=MAX_OUTPUT)break;
  }
  return out;
}

// Explicitly configured operator-controlled local file, never a station upload.
export function createRadioBulletin(file){
  return async ({scheduledAt,until,previousIds})=>{
    if(typeof file!=='string'||!isAbsolute(file))return null;
    let handle;
    try{
      const before=await lstat(file);
      if(!before.isFile()||before.isSymbolicLink()||before.size>MAX_BYTES)return null;
      handle=await open(file,'r');
      const opened=await handle.stat();
      if(!opened.isFile()||opened.ino!==before.ino||opened.dev!==before.dev||opened.size>MAX_BYTES)return null;
      const buffer=Buffer.alloc(MAX_BYTES+1);
      let at=0;
      while(at<buffer.length){
        const {bytesRead}=await handle.read(buffer,at,buffer.length-at,at);
        if(!bytesRead)break;
        at+=bytesRead;
      }
      if(at>MAX_BYTES)return null;
      const [story]=eligibleRadioHeadlines(buffer.subarray(0,at),scheduledAt,previousIds,{latestAirEndMs:until});
      return story?{id:story.id,speech:'短いニュースです。'+story.sourceName+'によると、'+story.text}:null;
    }catch{
      return null;
    }finally{
      await handle?.close().catch(()=>{});
    }
  };
}
