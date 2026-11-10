import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../server/database.js';
import {createAiStore} from '../server/ai-store.js';
import {validateAiResult,validateAiTags,applyAiEdits} from '../server/ai-validation.js';
import {validateAiSettings,createAiSettings} from '../server/ai-settings.js';
import {validateModelManifest,safeModelFetch} from '../server/ai-models.js';

function fixture(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());
  db.exec("INSERT INTO users VALUES('u','reader@example.test','Reader','hash',1); INSERT INTO shelves(id,name,created_at) VALUES('s','Synthetic shelf',1); INSERT INTO memberships VALUES('s','u','owner'); INSERT INTO items VALUES('a','s','Synthetic book','fixture.pdf','application/pdf',1,'u',1,2,1)");
  return {db,store:createAiStore(db),item:db.prepare("SELECT * FROM items WHERE id='a'").get()};
}
test('AI schema preserves existing library and validates FTS and foreign keys',t=>{
  const {db}=fixture(t);
  assert.equal(db.prepare('SELECT version FROM schema_version').get().version,26);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n,1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('manual OCR correction remains effective after reanalysis and stale edits are rejected',t=>{
  const {db,store,item}=fixture(t),limits={pageCount:2};
  const result={blocks:[{id:'p1',page:1,text:'Synthetic original',box:[0,0,.5,.5]}]};
  store.publish(item,'ocr','source','model',result,limits);
  const edit={requestId:randomUUID(),revision:0,resultRevision:1,patch:{blocks:{p1:{text:'Corrected text'}}}};
  assert.equal(store.edit(item,'ocr','u',edit,limits).result.blocks[0].text,'Corrected text');
  assert.equal(store.edit(item,'ocr','u',edit,limits).editRevision,1);
  assert.throws(()=>store.edit(item,'ocr','u',{...edit,requestId:randomUUID()},limits),{statusCode:409});
  store.publish(item,'ocr','source','new-model',result,limits);
  assert.equal(store.read('a','ocr').result.blocks[0].text,'Corrected text');
  assert.equal(db.prepare('SELECT text FROM ai_documents').get().text,'Corrected text');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_documents_fts WHERE ai_documents_fts MATCH 'Corrected'").get().n,1);
  db.prepare("DELETE FROM items WHERE id='a'").run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_documents').get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_documents_fts WHERE ai_documents_fts MATCH 'Corrected'").get().n,0);
});
test('manual and rejected tags survive AI regeneration and personal tags remain separate',t=>{
  const {store,item}=fixture(t);
  store.setTags(item,'u',{scope:'shared',revision:0,tags:['Manual'],rejected:['Wrong']},true);
  store.publish(item,'tags','source','model',{tags:['Wrong','Fresh']});
  assert.deepEqual(store.tags('a','other').filter(row=>!row.rejected).map(row=>row.label),['Fresh','Manual']);
  store.setTags(item,'u',{scope:'personal',revision:0,tags:['Private']},false);
  assert(!store.tags('a','other').some(row=>row.label==='Private'));
  assert(store.tags('a','u').some(row=>row.label==='Private'));
  assert.throws(()=>store.setTags(item,'u',{scope:'shared',revision:0,tags:[]},false),{statusCode:403});
});
test('AI result validation rejects invalid locations, intervals and unbounded output',()=>{
  assert.throws(()=>validateAiTags(['Ａ','a']));
  assert.throws(()=>validateAiResult('ocr',{blocks:[{page:2,text:'x'}]},{pageCount:1}));
  assert.throws(()=>validateAiResult('structure',{segments:[{startMs:10,endMs:5}]}));
  assert.throws(()=>validateAiResult('ocr',{blocks:[{page:1,text:'x',box:[.9,.9,.5,.5]}]}));
  const raw=validateAiResult('ocr',{blocks:[{id:'x',page:1,text:'hello'}]});
  assert.equal(applyAiEdits(raw,{blocks:{x:{hidden:true}}}).blocks.length,0);
});
test('AI starts disabled, CPU is default and environment override is explicit',t=>{
  const {db}=fixture(t),settings=createAiSettings(db,{AI_THREADS:'2'});
  assert.equal(settings.value.enabled,false);assert.equal(settings.value.backend,'cpu');
  assert.equal(settings.inspect().overrides.threads.variable,'AI_THREADS');
  assert.throws(()=>settings.save({threads:3}),{statusCode:409});
  assert.throws(()=>validateAiSettings({backend:'remote'}),{statusCode:422});
  assert.throws(()=>validateAiSettings({outputTokens:12000,contextTokens:4096}),{statusCode:422});
});
test('model manifests pin file names, revision and checksums; download redirects cannot access local services',async()=>{
  const catalog=[{key:'test',repo:'example/model',engine:'llama',license:'mit',files:['model.gguf']}];
  const manifest={key:'test',repo:'example/model',license:'mit',revision:'a'.repeat(40),files:[{name:'model.gguf',size:4,sha256:'b'.repeat(64)}]};
  assert.equal(validateModelManifest(manifest,catalog).id.length,64);
  assert.throws(()=>validateModelManifest({...manifest,files:[{...manifest.files[0],name:'../secret'}]},catalog));
  await assert.rejects(safeModelFetch('https://127.0.0.1/model'),{statusCode:422});
  let calls=0;
  await assert.rejects(safeModelFetch('https://huggingface.co/example',{},async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://localhost/private'}});}),{statusCode:422});
  assert.equal(calls,1);
});

test('manual adoption survives regeneration and repeated document edits keep the FTS index consistent',t=>{
 const {db,store,item}=fixture(t);
 store.publish(item,'tags','source','model',{tags:['Adopted','Transient']});
 store.setTags(item,'u',{scope:'shared',revision:0,tags:['Adopted','Transient'],adopted:['Adopted']},true);
 store.publish(item,'tags','source','new-model',{tags:['New']});
 assert(store.tags('a','u').some(tag=>tag.label==='Adopted'&&tag.source==='manual'));
 assert(!store.tags('a','u').some(tag=>tag.label==='Transient'));
 store.publish(item,'ocr','source','model',{summary:'Initial summary',blocks:[{id:'p1',page:1,text:'Initial'}]},{pageCount:2});
 for(let revision=0;revision<3;revision++)store.edit(item,'ocr','u',{requestId:randomUUID(),revision,resultRevision:1,patch:{blocks:{p1:{text:'Edited '+revision}}}},{pageCount:2});
 db.prepare("INSERT INTO ai_documents_fts(ai_documents_fts,rank) VALUES('integrity-check',1)").run();
 store.publish(item,'ocr','other-source','model',{blocks:[{id:'different',page:1,text:'Different location'}]},{pageCount:2});
 assert.equal(store.read('a','ocr').unresolved.length,1);
 store.edit(item,'ocr','u',{requestId:randomUUID(),revision:3,resultRevision:2,dropUnresolved:['p1']},{pageCount:2});
 assert.equal(store.read('a','ocr').unresolved.length,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_edit_history').get().n,4);
});

test('manual music splits remain separate from generated intervals and survive reanalysis',t=>{
 const {store,item}=fixture(t),raw={segments:[{id:'section',startMs:0,endMs:10000,label:'Verse'}]},limits={durationMs:10000};
 store.publish(item,'structure','source','model',raw,limits);
 const patch={splits:{section:[{startMs:0,endMs:4000,label:'A'},{startMs:4000,endMs:10000,label:'Chorus'}]}};
 const value=store.edit(item,'structure','u',{requestId:randomUUID(),revision:0,resultRevision:1,patch},limits);assert.equal(value.result.segments.length,2);assert.equal(value.result.segments[1].manualParentId,'section');
 store.publish(item,'structure','source','new-model',raw,limits);assert.equal(store.read('a','structure').result.segments[1].label,'Chorus');
 assert.throws(()=>store.edit(item,'structure','u',{requestId:randomUUID(),revision:1,resultRevision:2,patch:{splits:{section:[{startMs:0,endMs:12000,label:'invalid'}]}}},limits),{statusCode:422});
});

test('restoring hidden rows preserves prior text edits and merging manual parts removes stale search entries',t=>{
 const {db,store,item}=fixture(t),limits={durationMs:10000,pageCount:2};
 store.publish(item,'ocr','source','model',{blocks:[{id:'b',page:1,text:'Original'}]},limits);
 const edit=(feature,revision,patch)=>store.edit(item,feature,'u',{requestId:randomUUID(),revision,resultRevision:1,patch},limits);
 edit('ocr',0,{blocks:{b:{text:'Corrected'}}});edit('ocr',1,{blocks:{b:{hidden:true}}});edit('ocr',2,{blocks:{b:{hidden:false}}});assert.equal(store.read('a','ocr').result.blocks[0].text,'Corrected');
 store.publish(item,'structure','source','model',{segments:[{id:'s',startMs:0,endMs:10000,label:'Source'}]},limits);
 edit('structure',0,{splits:{s:[{startMs:0,endMs:5000,label:'First'},{startMs:5000,endMs:10000,label:'Remove this part'}]}});
 edit('structure',1,{splits:{s:[{startMs:0,endMs:10000,label:'Merged'}]}});
 assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_documents WHERE feature='structure'").get().n,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_documents_fts WHERE ai_documents_fts MATCH 'Remove'").get().n,0);
 db.prepare("INSERT INTO ai_documents_fts(ai_documents_fts,rank) VALUES('integrity-check',1)").run();
});

test('OCR native coordinates map into the original tile without changing reading order or accepting malformed boxes',async()=>{
 const {ocrBox,AI_OCR_OUTPUT,AI_TAG_OUTPUT,aiChapterOutput}=await import('../server/ai-output.js');
 assert.deepEqual(ocrBox([100,200,700,800],[.25,.5,.5,.5]),[.3,.6,.3,.3]);
 for(const box of [[0,0,0,4],[0,0,2000,4],[0,0,10.5,20],[100,0,99,50],null])assert.throws(()=>ocrBox(box),{code:'AI_OUTPUT_INVALID'});
 assert.equal(AI_OCR_OUTPUT.properties.blocks.maxItems,128);assert.equal(AI_TAG_OUTPUT.properties.tags.maxItems,12);assert.equal(aiChapterOutput(1000,5000).properties.segments.items.properties.startMs.minimum,1000);
});

test('long recognized passages keep complete lexical text and searchable vector chunks, and edits remove obsolete chunks',()=>{
 const db=openDatabase(':memory:');try{
 db.exec("INSERT INTO users VALUES('u','reader@example.test','Synthetic','hash',1);INSERT INTO shelves(id,name,created_at) VALUES('s','Synthetic',1);INSERT INTO memberships VALUES('s','u','owner');INSERT INTO items VALUES('a','s','Synthetic','file','application/pdf',1,'u',1,1,1)");
 const store=createAiStore(db),item=db.prepare("SELECT * FROM items WHERE id='a'").get(),text='Start '+('synthetic '.repeat(600))+' final unique words';
 store.publish(item,'ocr','source','model',{blocks:[{id:'long',page:1,text}]},{pageCount:1});
 const documents=db.prepare("SELECT * FROM ai_documents WHERE asset_id='a'").all();assert(documents.some(d=>d.text===text));assert(documents.some(d=>d.id.includes(':chunk')&&d.text.includes('final unique words')));
 store.edit(item,'ocr','u',{requestId:randomUUID(),revision:0,resultRevision:1,patch:{blocks:{long:{text:'Short correction'}}}},{pageCount:1});
 const updated=db.prepare("SELECT * FROM ai_documents WHERE asset_id='a'").all();assert.equal(updated.length,1);assert.equal(updated[0].text,'Short correction');
 }finally{db.close();}
});

test('restoring an earlier correction is revisioned, idempotent and keeps manual segment search entries consistent',()=>{
 const db=openDatabase(':memory:');try{
 db.exec("INSERT INTO users VALUES('u','reader@example.test','Synthetic','hash',1);INSERT INTO shelves(id,name,created_at) VALUES('s','Synthetic',1);INSERT INTO memberships VALUES('s','u','owner');INSERT INTO items VALUES('a','s','Synthetic','file','audio/mp4',1,'u',1,1,1)");
 const store=createAiStore(db),item=db.prepare("SELECT * FROM items WHERE id='a'").get(),limits={durationMs:10000};
 store.publish(item,'structure','source','model',{segments:[{id:'part',startMs:0,endMs:10000,label:'Original'}]},limits);
 store.edit(item,'structure','u',{requestId:randomUUID(),revision:0,resultRevision:1,patch:{splits:{part:[{startMs:0,endMs:5000,label:'First'},{startMs:5000,endMs:10000,label:'Second'}]}}},limits);
 store.edit(item,'structure','u',{requestId:randomUUID(),revision:1,resultRevision:1,patch:{splits:{part:[{startMs:0,endMs:10000,label:'Merged'}]}}},limits);
 const body={requestId:randomUUID(),revision:2,resultRevision:1,restoreRevision:1};
 assert.equal(store.restore(item,'structure','u',body,limits).editRevision,3);assert.equal(store.read('a','structure').result.segments.length,2);
 assert.equal(store.restore(item,'structure','u',body,limits).editRevision,3);
 store.restore(item,'structure','u',{requestId:randomUUID(),revision:3,resultRevision:1,restoreRevision:2},limits);
 assert.equal(db.prepare("SELECT count(*) n FROM ai_documents WHERE asset_id='a'").get().n,1);
 const reset=store.restore(item,'structure','u',{requestId:randomUUID(),revision:4,resultRevision:1,restoreRevision:0},limits);assert.equal(reset.result.segments[0].label,'Original');assert.equal(db.prepare("SELECT count(*) n FROM ai_edit_history").get().n,5);
 assert.throws(()=>store.restore(item,'structure','u',{requestId:randomUUID(),revision:4,resultRevision:1,restoreRevision:1},limits),{statusCode:409});
 }finally{db.close();}
});
