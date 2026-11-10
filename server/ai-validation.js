import {createHash} from 'node:crypto';
import {httpError} from './security.js';

export const AI_FEATURES = ['tags','ocr','transcript','structure','chapters','embedding'];
export const normalizeAiText = value => String(value).normalize('NFKC').toLocaleLowerCase('ja').replace(/[ァ-ヶ]/gu,c=>String.fromCharCode(c.charCodeAt(0)-0x60)).replace(/\s+/gu,' ').trim();
export const aiHash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export function aiText(value,max=16000) {
  if (typeof value !== 'string' || value.length>max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
    throw httpError(422,'解析情報の文字列を確認してください。');
  return value.trim();
}

export function validateAiTags(tags) {
  if (!Array.isArray(tags) || tags.length>64) throw httpError(422,'タグは64件以内にしてください。');
  const found=new Set();
  return tags.map(tag => {
    if (typeof tag==='string') tag={label:tag};
    const label=aiText(tag?.label,80),normalized=normalizeAiText(label);
    if (!normalized || found.has(normalized)) throw httpError(422,'タグの空欄・重複を確認してください。');
    found.add(normalized);
    return {label,normalized,category:aiText(tag.category??'',40)};
  });
}

function box(value) {
  if (!Array.isArray(value) || value.length!==4 || value.some(n=>!Number.isFinite(n)||n<0||n>1) ||
      value[2]<=0 || value[3]<=0 || value[0]+value[2]>1.001 || value[1]+value[3]>1.001)
    throw httpError(422,'認識領域の位置を確認してください。');
  return value;
}

export function validateAiResult(feature,value,{pageCount=1,durationMs=Number.MAX_SAFE_INTEGER}={}) {
  if (!AI_FEATURES.includes(feature) || !value || typeof value!=='object' || Array.isArray(value))
    throw httpError(422,'解析情報の種類を確認してください。');
  if (Buffer.byteLength(JSON.stringify(value))>2*1024*1024) throw httpError(422,'解析情報が大きすぎます。');
  const result={tags:validateAiTags(value.tags??[]),blocks:[],segments:[],summary:aiText(value.summary??'',4000)};
  const blocks=value.blocks??[],segments=value.segments??[];
  if (!Array.isArray(blocks)||blocks.length>2000||!Array.isArray(segments)||segments.length>2000)
    throw httpError(422,'解析情報の件数を確認してください。');
  const ids=new Set();
  const idFor=(row,index,prefix)=>{
    const id=String(row.id??prefix+index);
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(id)||ids.has(id)) throw httpError(422,'解析領域の識別子を確認してください。');
    ids.add(id);return id;
  };
  for (const [index,row] of blocks.entries()) {
    const text=aiText(row.text);
    if (!text) continue;
    const block={id:idFor(row,index,'b'),text,kind:aiText(row.kind??'text',40),order:index};
    if (row.page!==undefined) {
      if (!Number.isSafeInteger(row.page)||row.page<1||row.page>pageCount) throw httpError(422,'認識ページを確認してください。');
      block.page=row.page;block.box=box(row.box??[0,0,1,1]);
    }
    if (row.chapter!==undefined) {
      if (!Number.isSafeInteger(row.chapter)||row.chapter<0||row.chapter>500) throw httpError(422,'認識した章を確認してください。');
      block.chapter=row.chapter;block.element=aiText(row.element??'',200);
      if(row.textOffset!==undefined){if(!Number.isSafeInteger(row.textOffset)||row.textOffset<0||row.textOffset>12*1024*1024)throw httpError(422,'本文の位置を確認してください。');block.textOffset=row.textOffset;}
    }
    if (!('page' in block)&&!('chapter' in block)) throw httpError(422,'認識文字の位置がありません。');
    result.blocks.push(block);
  }
  let previous=-1;
  for (const [index,row] of segments.entries()) {
    if (!Number.isSafeInteger(row.startMs)||!Number.isSafeInteger(row.endMs)||row.startMs<0||
        row.startMs<previous||row.endMs<=row.startMs||row.endMs>durationMs)
      throw httpError(422,'解析した時間範囲を確認してください。');
    previous=row.startMs;
    result.segments.push({id:idFor(row,index,'s'),startMs:row.startMs,endMs:row.endMs,
      label:aiText(row.label??'区間',160),text:aiText(row.text??''),kind:aiText(row.kind??'section',40)});
  }
  return result;
}

export function applyAiEdits(result,patch={}) {
  const copy=structuredClone(result);
  for (const key of ['blocks','segments']) {
    copy[key]=copy[key].filter(row=>!patch[key]?.[row.id]?.hidden).map(row=>{
      const edit=patch[key]?.[row.id];
      if (!edit) return row;
      const merged={...row};
      for (const field of ['text','label','kind','startMs','endMs','box','order'])
        if (edit[field]!==undefined) merged[field]=edit[field];
      return merged;
    });
    if(key==='segments')copy[key]=copy[key].flatMap(row=>patch.splits?.[row.id]?patch.splits[row.id].map((part,index)=>({...row,...part,id:index?row.id.slice(0,80)+':part'+index:row.id,manualParentId:row.id,manualPartIndex:index})):row);
    copy[key].sort(key==='blocks'?(a,b)=>a.order-b.order:(a,b)=>a.startMs-b.startMs);
  }
  return copy;
}

export function validateAiPatch(patch,result,limits) {
  if (!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['blocks','segments','splits'].includes(k))||
      Buffer.byteLength(JSON.stringify(patch))>256*1024) throw httpError(422,'訂正内容を確認してください。');
  for (const key of ['blocks','segments']) {
    const changes=patch[key]??{};
    if (!changes||typeof changes!=='object'||Array.isArray(changes)||Object.keys(changes).length>2000)
      throw httpError(422,'訂正する領域を確認してください。');
    for (const [id,edit] of Object.entries(changes)) {
      if (!result[key].some(row=>row.id===id)||!edit||typeof edit!=='object'||Array.isArray(edit)||
          Object.keys(edit).some(k=>!['text','label','kind','startMs','endMs','box','order','hidden'].includes(k))||
          edit.hidden!==undefined&&typeof edit.hidden!=='boolean'||
          edit.order!==undefined&&(!Number.isSafeInteger(edit.order)||edit.order<0))
        throw httpError(422,'訂正する領域を確認してください。');
      for(const field of ['text','label','kind'])if(edit[field]!==undefined)aiText(edit[field],field==='text'?16000:field==='label'?160:40);
      if(edit.box!==undefined)box(edit.box);
      for(const field of ['startMs','endMs'])if(edit[field]!==undefined&&(!Number.isSafeInteger(edit[field])||edit[field]<0||edit[field]>(limits?.durationMs??Number.MAX_SAFE_INTEGER)))throw httpError(422,'訂正する時間範囲を確認してください。');
    }
  }
  if(patch.splits!==undefined){if(!patch.splits||typeof patch.splits!=='object'||Array.isArray(patch.splits)||Object.keys(patch.splits).length>2000)throw httpError(422,'分割する区間を確認してください。');for(const [id,parts]of Object.entries(patch.splits)){if(!result.segments.some(row=>row.id===id)||!Array.isArray(parts)||!parts.length||parts.length>32)throw httpError(422,'分割する区間を確認してください。');let end=-1;for(const part of parts){if(!part||typeof part!=='object'||Array.isArray(part)||Object.keys(part).some(k=>!['startMs','endMs','label','text','kind'].includes(k))||!Number.isSafeInteger(part.startMs)||!Number.isSafeInteger(part.endMs)||part.startMs<end||part.startMs<0||part.endMs<=part.startMs||part.endMs>(limits?.durationMs??Number.MAX_SAFE_INTEGER))throw httpError(422,'分割後の時間範囲を確認してください。');aiText(part.label,160);aiText(part.text??'');aiText(part.kind??'section',40);end=part.endMs;}}}
  validateAiResult('ocr',applyAiEdits(result,patch),limits);
  return patch;
}
