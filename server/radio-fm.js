import {open,realpath} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

const levels=['standard','enhanced'];
const kinds=['mc','jingle'];
const assetLimit=1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

async function readDirect(root,name,limit) {
  const path=join(root,name);
  if(await realpath(path)!==path||dirname(path)!==root)throw Error('Not a direct FM pack file');
  const file=await open(path,'r');
  try{
    const info=await file.stat();
    if(!info.isFile()||info.size<1||info.size>limit)throw Error('FM pack file exceeds bounds');
    const buffer=Buffer.alloc(info.size), {bytesRead}=await file.read(buffer,0,info.size,0);
    if(bytesRead!==info.size)throw Error('Incomplete FM pack file');
    return buffer;
  }finally{await file.close();}
}

// A pack is loaded before accepting requests and is immutable for this start.
// Treat missing/invalid clips independently so no timeline reserves silent slots.
export async function loadRadioFm(directory) {
  const clips=new Map();
  if(!directory)return clips;
  let root,index;
  try{
    root=await realpath(resolve(directory));
    index=JSON.parse((await readDirect(root,'fm-pack.json',8192)).toString('utf8'));
    if(index.version!==1)return clips;
  }catch{return clips;}
  for(const kind of kinds)for(const level of levels){
    const id=kind+'-'+level,row=index.clips?.[id];
    if(!row||!Number.isSafeInteger(row.durationMs)||row.durationMs<700||row.durationMs>20000||
       typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))continue;
    const credit=kind==='mc'?row.credit:undefined;
    if(kind==='mc'&&(typeof credit!=='string'||!credit.trim()||credit.length>120||/[\r\n]/.test(credit)))continue;
    try{
      const bytes=await readDirect(root,id+'.m4a',assetLimit);
      if(bytes.length<16||bytes.toString('ascii',4,8)!=='ftyp'||digest(bytes)!==row.sha256)continue;
      clips.set(id,{id,kind,durationMs:row.durationMs,sha256:row.sha256,credit,bytes,title:kind==='mc'?'MC':'ステーションジングル'});
    }catch{/* An unavailable asset is not part of the committed program. */}
  }
  return clips;
}

export function composeFm(tracks,prefs,clips) {
  if(!prefs||!clips.size)return {segments:tracks,signature:[]};
  const choose=kind=>clips.get(kind+'-'+prefs[kind]);
  const jingle=choose('jingle'), mc=choose('mc');
  if(!mc&&!jingle)return {segments:tracks,signature:[]};
  // Rotate through the source in its saved order without back-to-back IDs on
  // very short playlists; interludes occur once before the next musical block.
  const gap=tracks.length<=2?tracks.length:Math.min(4,tracks.length);
  const segments=[];
  for(let i=0;i<tracks.length;i++){
    segments.push(tracks[i]);
    if((i+1)%gap===0||i===tracks.length-1){
      if(jingle)segments.push(jingle);
      if(mc)segments.push(mc);
    }
  }
  return {segments,signature:[jingle,mc].filter(Boolean).map(({id,durationMs,sha256})=>[id,durationMs,sha256])};
}

export const fmCapabilities=clips=>Object.fromEntries(kinds.map(kind=>[kind,levels.filter(level=>clips.has(kind+'-'+level))]));
