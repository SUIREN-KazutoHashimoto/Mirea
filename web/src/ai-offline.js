import {offlineVault,offlinePartition} from './offline-vault.js';
import {requirePrivateShelf,shelfUnlockValue} from './private-shelves.js';
import {aiSearchScope,sameAiRevision,aiTagMatches,aiCacheMarker as marker,aiCachedPack as cached,saveAiCachedPack as save,aiCacheDenied} from './ai-cache-core.js';
import {NativePlayer,nativePlayerAvailable} from './native-player-bridge.js';
import {getSession,getEndpoint} from './api.js';
const slot=id=>'ai:'+id;
export async function aiAuthorization(actor,id){return marker(await offlineVault(),offlinePartition(actor.origin,actor.userId),id);}
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),x=>x.toString(16).padStart(2,'0')).join('');
async function verify(actor,pack){
  if(!actor.userId||pack?.userId!==actor.userId||pack.version!==1||typeof pack.assetId!=='string'||JSON.stringify(pack).length>8*1024*1024)throw Error('解析情報の保存形式が不正です。');
  const {checksum,...value}=pack;if(await hash(value)!==checksum)throw Error('解析情報の検証に失敗しました。');
}
export async function saveAiPack(actor,pack,authorization=null){
  await verify(actor,pack);const vault=await offlineVault(),partition=offlinePartition(actor.origin,actor.userId);
  await save(vault,partition,slot(pack.assetId)+(pack.feature?':'+pack.feature+':'+pack.offset:''),pack,authorization);
  for(const [feature,data]of Object.entries(pack.features??{})){const unit=data.nextOffset-1;if(Number.isSafeInteger(unit)&&unit>=0)await save(vault,partition,slot(pack.assetId)+':'+feature+':'+unit,pack,authorization);}
}
export async function revokeAiPack(actor,assetId){
  const vault=await offlineVault(),partition=offlinePartition(actor.origin,actor.userId);
  await vault.seal(partition,'ai-revoked:'+assetId,{id:crypto.randomUUID()});
  await vault.revoke(partition,slot(assetId));await vault.revoke(partition,'ai-timeline:'+assetId);
  if(nativePlayerAvailable())await NativePlayer.analysisRevoke({origin:actor.origin,userId:actor.userId,token:actor.token,id:assetId}).catch(()=>{});
}
async function permitted(actor,assetId,{unlock=true}={}){
  const vault=await offlineVault(),partition=offlinePartition(actor.origin,actor.userId);
  if(await vault.loggedOut(actor.origin))return null;
  const catalog=await vault.catalog(partition),item=catalog?.items.find(i=>i.id===assetId),shelf=catalog?.shelves.find(s=>s.id===item?.shelfId);
  if(!item||!shelf)return null;if(shelf.private){if(!unlock)return null;await requirePrivateShelf(shelf);}
  return {vault,partition,item};
}
export async function readAiPack(actor,assetId,{feature,offset=0,unlock=true}={}){
  const access=await permitted(actor,assetId,{unlock});if(!access)return null;
  const {vault,partition,item}=access,pack=await cached(vault,partition,slot(assetId)+(feature?':'+feature+':'+offset:''),assetId);
  if(pack?.shelfId!==item.shelfId)return null;
  if(feature){const root=await cached(vault,partition,slot(assetId),assetId);if(!sameAiRevision(pack?.features?.[feature],root?.features?.[feature]))return null;}
  return pack;
}
export async function saveAiTimeline(actor,pack,authorization=null){
  await verify(actor,pack);const vault=await offlineVault(),partition=offlinePartition(actor.origin,actor.userId);
  await save(vault,partition,'ai-timeline:'+pack.assetId,pack,authorization);
  if(nativePlayerAvailable()&&getSession()?.user.id===actor.userId&&getSession()?.token===actor.token&&getEndpoint()===actor.origin)await NativePlayer.analysisSave({origin:actor.origin,userId:actor.userId,token:actor.token,shelfUnlock:shelfUnlockValue(),pack}).catch(()=>{throw Error('再生用の解析情報を保存できませんでした。接続とアプリの更新を確認して再試行してください。');});
}
export async function readAiTimeline(actor,assetId){const access=await permitted(actor,assetId);if(!access)return null;const saved=await access.vault.metadataWithLease(access.partition,'ai-timeline:'+assetId).catch(()=>null);return saved&&(saved.value.pack?saved.value.authorization??null:null)===await marker(access.vault,access.partition,assetId)?{...(saved.value.pack??saved.value),localExpiresAt:saved.localExpiresAt}:null;}
const pending=new Map();
export function syncAiContent(actor,assetId,api,current=()=>true){
  const key=offlinePartition(actor.origin,actor.userId)+'|'+assetId;if(pending.has(key))return pending.get(key);
  const task=(async()=>{
    const vault=await offlineVault(),partition=offlinePartition(actor.origin,actor.userId);
    const authorization=await aiAuthorization(actor,assetId);
    for(let attempt=0;attempt<2;attempt++){
      const pack=await api('/items/'+assetId+'/ai/pack',{diagnostics:false});if(!current())return;await saveAiPack(actor,pack,authorization);let changed=false;
      for(const [feature,data]of Object.entries(pack.features)){
        let offset=data.hasMore?data.nextOffset:null;
        while(offset!==null&&current()){
          const saved=await cached(vault,partition,slot(assetId)+':'+feature+':'+offset,assetId);
          const pages=sameAiRevision(saved?.features?.[feature],data)&&saved.expiresAt>Date.now()+86400000?[saved]:(await api('/items/'+assetId+'/ai/packs?feature='+feature+'&offset='+offset,{diagnostics:false})).packs;
          if(!Array.isArray(pages)||!pages.length||pages.length>8)throw Error('解析情報の取得形式が不正です。');
          for(const page of pages){
            if(!current())return;await verify(actor,page);const next=page.features?.[feature];
            if(page.assetId!==assetId||page.feature!==feature||page.offset!==offset||!sameAiRevision(next,data)){changed=true;break;}
            await saveAiPack(actor,page,authorization);
            if(!next.hasMore){offset=null;break;}
            if(!Number.isSafeInteger(next.nextOffset)||next.nextOffset<=offset)throw Error('解析情報の取得位置が不正です。');offset=next.nextOffset;
          }
          if(changed)break;await new Promise(resolve=>setTimeout(resolve,0));
        }
        if(changed)break;
      }
      if(changed){if(!attempt)continue;throw Error('解析内容が更新されました。保存をもう一度お試しください。');}
      if(!current())return;
      const timeline=await api('/items/'+assetId+'/ai/timeline',{diagnostics:false});if(current())await saveAiTimeline(actor,timeline,authorization);return;
    }
  })().catch(async error=>{if(current()&&[401,403,404,423].includes(error.status))await revokeAiPack(actor,assetId);throw error;}).finally(()=>pending.delete(key));
  pending.set(key,task);return task;
}
export async function offlineAiSearch(actor,{query='',tags=[],tagMode='all',scope={},limit=40,offset=0}={}){
  const vault=await offlineVault(),partition=offlinePartition(actor.origin,actor.userId),catalog=await vault.catalog(partition);
  if(!catalog||await vault.loggedOut(actor.origin))return {items:[],hasMore:false,offset:0,semantic:false};
  const normalize=s=>s.normalize('NFKC').toLocaleLowerCase('ja').replace(/[ァ-ヶ]/gu,c=>String.fromCharCode(c.charCodeAt(0)-0x60)).replace(/\s+/gu,' ').trim(),term=normalize(query),matches=[],inScope=aiSearchScope(catalog,scope);
  if(scope.shelfId){const shelf=catalog.shelves.find(s=>s.id===scope.shelfId);if(shelf?.private)await requirePrivateShelf(shelf);}
  for(const item of catalog.items){
    if(!inScope(item))continue;
    const pack=await cached(vault,partition,slot(item.id),item.id);if(!pack&&await aiCacheDenied(vault,partition,item.id))continue;if(pack&&pack.shelfId!==item.shelfId)continue;
    if(!aiTagMatches(new Set((pack?.tags??[]).filter(t=>!t.rejected).map(t=>normalize(t.label))),tags.map(normalize),tagMode))continue;
    const hits=[];let matched=!term||normalize(item.title).includes(term)||(pack?.tags??[]).some(t=>!t.rejected&&normalize(t.label).includes(term));
    for(const [feature,data]of Object.entries(pack?.features??{})){
      let page=data,index=0;
      while(page){
        for(const row of [...page.result.blocks,...page.result.segments]){const text=[row.text,row.label].filter(Boolean).join(' ');if(term&&normalize(text).includes(term)){matched=true;if(hits.length<8)hits.push({feature,text:text.slice(0,240),locator:row});}}
        if(!page.hasMore||!Number.isSafeInteger(page.nextOffset)||page.nextOffset<=index)break;index=page.nextOffset;
        const saved=await cached(vault,partition,slot(item.id)+':'+feature+':'+index,item.id);page=sameAiRevision(saved?.features?.[feature],data)?saved.features[feature]:null;
      }
    }
    if(matched)matches.push({assetId:item.id,title:item.title,shelfId:item.shelfId,reason:hits.length?'content':'tag',hits,item});
    if(matches.length>offset+limit)break;await new Promise(resolve=>setTimeout(resolve,0));
  }
  return {items:matches.slice(offset,offset+limit),hasMore:matches.length>offset+limit,offset:offset+Math.max(0,Math.min(limit,matches.length-offset)),semantic:false};
}
