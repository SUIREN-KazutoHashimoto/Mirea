import test from 'node:test';
import assert from 'node:assert/strict';
import {aiSearchScope,sameAiRevision,aiTagMatches,aiCacheMarker,aiCachedPack,saveAiCachedPack} from '../web/src/ai-cache-core.js';
import {createOfflineVault} from '../web/src/offline-vault.js';
test('cached AI searches keep shelf, nested series, playlist and media scopes',()=>{
 const catalog={shelves:[{id:'public'},{id:'private',private:true}],series:[{id:'root'},{id:'child',parentId:'root'},{id:'other'}],playlists:[{id:'list',assetIds:['inside']}]};
 const inside={id:'inside',shelfId:'public',series:{id:'child'},kind:'pdf'},outside={id:'outside',shelfId:'public',series:{id:'other'},kind:'audio'};
 assert(aiSearchScope(catalog,{seriesId:'root',kind:'book'})(inside));assert(!aiSearchScope(catalog,{seriesId:'root'})(outside));
 assert(aiSearchScope(catalog,{playlistId:'list'})(inside));assert(!aiSearchScope(catalog,{playlistId:'missing'})(inside));
 assert(!aiSearchScope(catalog)({...inside,shelfId:'private'}));assert(aiSearchScope(catalog,{shelfId:'private'})({...inside,shelfId:'private'}));
 assert(!aiSearchScope(catalog)({...inside,shelfId:'removed'}));
});
test('cached page generations cannot mix, and tag all/any modes match online behavior',()=>{
 const page={revision:2,editRevision:3,inputStamp:'source'};assert(sameAiRevision(page,{...page}));
 for(const patch of [{revision:3},{editRevision:4},{inputStamp:'other'}])assert(!sameAiRevision(page,{...page,...patch}));
 const labels=new Set(['a']);assert(aiTagMatches(labels,['a','b'],'any'));assert(!aiTagMatches(labels,['a','b'],'all'));
});
test('AI metadata is encrypted, expires monotonically, and account logout destroys access',async()=>{
 const rows=new Map(),store={vaultGet:async k=>rows.get(k),vaultPut:async(k,v)=>rows.set(k,v),vaultInit:async(k,v)=>{if(!rows.has(k))rows.set(k,v);return rows.get(k);},vaultDelete:async k=>rows.delete(k),list:async()=>[]};
 let time=1800000000000,mono=0;const vault=await createOfflineVault(store,{wall:()=>time,mono:()=>mono,anchorMap:new Map()}),partition='https://example.test|reader';
 await vault.saveMetadata(partition,'ai:asset',{serverTime:time,expiresAt:time+7000},{secret:'SYNTHETIC OCR TEXT'});
 assert(!JSON.stringify([...rows]).includes('SYNTHETIC OCR TEXT'));assert.equal((await vault.metadata(partition,'ai:asset')).secret,'SYNTHETIC OCR TEXT');
 mono=7001;assert.equal(await vault.metadata(partition,'ai:asset'),null);
 await vault.saveMetadata(partition,'ai:asset',{serverTime:time,expiresAt:time+7000},{secret:'other'});await vault.forget('https://example.test','reader');await assert.rejects(()=>vault.metadata(partition,'ai:asset'));
});

test('a late response cannot restore denied AI metadata, including a revocation during ciphertext publication',async()=>{
 const values=new Map(),partition='synthetic',asset='asset',pack={assetId:asset,serverTime:100,expiresAt:200};
 let publish=async(id,value)=>values.set(id,value);
 const vault={unseal:async(p,id)=>values.get(id),metadata:async(p,id)=>values.get(id),saveMetadata:async(p,id,lease,value)=>publish(id,value)};
 const before=await aiCacheMarker(vault,partition,asset);
 await saveAiCachedPack(vault,partition,'ai:asset',pack,before);assert.deepEqual(await aiCachedPack(vault,partition,'ai:asset',asset),pack);
 values.set('ai-revoked:asset',{id:'denial1'});await assert.rejects(()=>saveAiCachedPack(vault,partition,'ai:asset',pack,before),{name:'AbortError'});
 assert.equal(await aiCachedPack(vault,partition,'ai:asset',asset),null);
 const fresh=await aiCacheMarker(vault,partition,asset);await saveAiCachedPack(vault,partition,'ai:asset',pack,fresh);assert.deepEqual(await aiCachedPack(vault,partition,'ai:asset',asset),pack);
 publish=async(id,value)=>{values.set('ai-revoked:asset',{id:'denial2'});values.set(id,value);};
 await saveAiCachedPack(vault,partition,'ai:asset',pack,fresh);assert.equal(await aiCachedPack(vault,partition,'ai:asset',asset),null);
});

test('logout rotates metadata authorization so a late encrypted write cannot reappear after relogin',async()=>{
 const rows=new Map(),store={vaultGet:async k=>rows.get(k),vaultPut:async(k,v)=>rows.set(k,v),vaultInit:async(k,v)=>{if(!rows.has(k))rows.set(k,v);return rows.get(k);},vaultDelete:async k=>rows.delete(k),list:async()=>[]};
 const vault=await createOfflineVault(store,{anchorMap:new Map()}),actor='https://example.test',partition=actor+'|reader',pack={assetId:'asset',serverTime:Date.now(),expiresAt:Date.now()+10000};
 const before=await aiCacheMarker(vault,partition,'asset');await saveAiCachedPack(vault,partition,'ai:asset',pack,before);
 await vault.forget(actor,'reader');await assert.rejects(()=>saveAiCachedPack(vault,partition,'ai:asset',pack,before),{name:'AbortError'});
 const fresh=await aiCacheMarker(vault,partition,'asset');assert.notEqual(fresh,before);await saveAiCachedPack(vault,partition,'ai:asset',pack,fresh);assert.deepEqual(await aiCachedPack(vault,partition,'ai:asset','asset'),pack);
});

test('legacy non-extractable vault keys remain unchanged when adding metadata generation identity',async()=>{
 const rows=new Map(),partition='https://example.test|reader',key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);rows.set('device|'+partition,key);
 const store={vaultGet:async k=>rows.get(k),vaultPut:async(k,v)=>rows.set(k,v),vaultInit:async(k,v)=>{if(!rows.has(k))rows.set(k,v);return rows.get(k);},vaultDelete:async k=>rows.delete(k),list:async()=>[]},vault=await createOfflineVault(store);
 assert.equal(await vault.metadataEpoch(partition),'legacy');await vault.seal(partition,'existing',{value:'SYNTHETIC'});assert.equal((await vault.unseal(partition,'existing')).value,'SYNTHETIC');assert.equal(rows.get('device|'+partition),key);assert.equal(key.extractable,false);
});
