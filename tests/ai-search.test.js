import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../server/database.js';
import {createAiStore} from '../server/ai-store.js';
import {searchAiLibrary} from '../server/ai-search.js';
test('semantic paging protects exact titles, retains content locations and never mixes inaccessible assets',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mirea-ai-search-')),db=openDatabase(join(dir,'mirea.sqlite'));t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 const user=randomUUID(),foreign=randomUUID(),shelf=randomUUID(),hidden=randomUUID();
 db.prepare("INSERT INTO users VALUES(?,?,'Synthetic reader','no-login',1)").run(user,'reader@example.test');
 for(const id of [shelf,hidden]){db.prepare("INSERT INTO shelves(id,name,private,created_at) VALUES(?,'Synthetic shelf',?,1)").run(id,Number(id===hidden));db.prepare("INSERT INTO memberships VALUES(?,?,'owner')").run(id,user);}
 const store=createAiStore(db),ids=[];
 for(let i=0;i<8;i++){const id=randomUUID();ids.push(id);db.prepare("INSERT INTO items VALUES(?,?,?,'synthetic.pdf','application/pdf',1,?,1,1,1)").run(id,i===7?hidden:shelf,i===5?'topic exact title':'Synthetic '+i,user);
  const item=db.prepare('SELECT * FROM items WHERE id=?').get(id);store.publish(item,'ocr','source','model',{blocks:[{id:'p1',page:1,text:i<2?'Text mentioning topic':'Other synthetic content',box:[0,0,.5,.1]}]},{pageCount:1});
  const vector=Float32Array.from([1,i/10,...Array(30).fill(0)]);db.prepare('UPDATE ai_documents SET vector=?,vector_space=? WHERE asset_id=?').run(Buffer.from(vector.buffer),'embedding-model',id);
 }
 const query={dataDir:dir,userId:user,query:'topic',mode:'semantic',vector:[1,...Array(31).fill(0)],vectorSpace:'embedding-model',limit:2};
 const pages=[];for(let offset=0;offset<8;offset+=2){const page=await searchAiLibrary({...query,offset});pages.push(...page.items);if(!page.hasMore)break;}
 assert.equal(pages.length,7);assert.equal(new Set(pages.map(row=>row.assetId)).size,7);assert.equal(pages[0].assetId,ids[5]);assert(!pages.some(row=>row.assetId===ids[7]));
 const similar=pages.find(row=>row.reason==='similarity');assert(similar);assert.equal(similar.hits[0].locator.page,1);
 assert.equal((await searchAiLibrary({...query,userId:foreign})).items.length,0);
 store.publish(db.prepare('SELECT * FROM items WHERE id=?').get(ids[0]),'ocr','source','model',{blocks:[{id:'kana',page:2,text:'ＡＢＣ 青いトリ カタカナ',box:[0,0,.5,.1]}]},{pageCount:2});
 const kana=await searchAiLibrary({...query,mode:'text',query:'かたかな'});
 assert.equal(kana.items[0].assetId,ids[0]);assert.equal(kana.items[0].hits[0].locator.page,2);
 assert.equal((await searchAiLibrary({...query,mode:'text',query:'abc'})).items[0].assetId,ids[0]);
});
