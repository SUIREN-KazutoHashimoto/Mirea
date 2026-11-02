import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createExportWriter} from '../web/src/file-export-core.js';
import {partitionJobs,jobStateClass} from '../web/src/job-presentation.js';
import {createLoginStore,validSession} from '../web/src/session-store.js';

function loginFixture(){
  const map=new Map(),saved=new Map(),temporary=()=>({getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)});
  const secure={async load({origin}){return {session:saved.get(origin)??null};},async save({origin,session}){saved.set(origin,session);},async clear({origin}){saved.delete(origin);}};
  const value={token:randomBytes(32).toString('base64url'),expiresAt:Date.now()+604800000,user:{id:'synthetic-user',email:'test@example.test',name:'Test'},password:'never-persist-this'};
  return {map,saved,temporary,secure,value,store:()=>createLoginStore({native:true,temporary,secure})};
}
test('native login storage restores through the secure bridge, isolates servers and never persists passwords',async()=>{
  const c=loginFixture(),origin='https://mirea.example.test';assert.equal(await c.store().save(origin,c.value),true);assert.equal(c.map.size,0);
  assert.ok(!c.saved.get(origin).includes('never-persist-this'));assert.deepEqual((await c.store().load(origin)).value,validSession(c.value));assert.equal(await c.store().load('https://other.example.test'),null);
  await c.store().clear(origin,c.value.token);assert.equal(await c.store().load(origin),null);
  c.saved.set(origin,JSON.stringify({...c.value,expiresAt:1}));assert.equal(await c.store().load(origin),null);assert.equal(c.saved.size,0);
  c.saved.set(origin,'corrupt');assert.equal(await c.store().load(origin),null);assert.equal(c.saved.size,0);
});
test('unchecked login stays temporary, legacy sessions can migrate and serialized logout wins over pending save',async()=>{
  const c=loginFixture(),origin='https://mirea.example.test',store=c.store();
  await store.save(origin,c.value);await store.save(origin,c.value,false);assert.equal(c.saved.size,0);assert.equal((await store.load(origin)).remember,false);
  c.map.clear();assert.equal(await c.store().load(origin),null);
  c.map.set('mirea.session',JSON.stringify(c.value));assert.equal((await store.load(origin)).legacy,true);await store.save(origin,c.value);assert.equal(c.map.size,0);
  const saving=store.save(origin,c.value),clearing=store.clear(origin,c.value.token);await Promise.all([saving,clearing]);assert.equal(await store.load(origin),null);
  const failed=createLoginStore({native:true,temporary:c.temporary,secure:{...c.secure,save:async()=>{throw Error('save failed');}}});await Promise.all([failed.save(origin,c.value),failed.clear(origin,c.value.token)]);assert.equal(await failed.load(origin),null,'logout removes a pending fallback temporary save');
});
test('browser credentials use only the HttpOnly-cookie exchange, verify storage and survive network failures',async()=>{
  const c=loginFixture();let cookie=null,offline=false;
  const request=async(path,options={})=>{assert.equal(path,'/auth/remember');if(offline)throw Error('offline');if(options.method==='POST'){assert.equal(options.headers.Authorization,'Bearer '+c.value.token);cookie=validSession(c.value);return {remembered:true};}if(options.method==='DELETE'){if(options.body.token===cookie?.token)cookie=null;return null;}if(!cookie)throw Object.assign(Error('absent'),{status:401});return cookie;};
  const store=()=>createLoginStore({native:false,temporary:c.temporary,request});
  assert.equal(await store().load(''),null);assert.equal(await store().save('',c.value),true);assert.equal(c.map.size,0);assert.deepEqual((await store().load('')).value,validSession(c.value));
  offline=true;await assert.rejects(store().load(''),/offline/);assert.ok(cookie);offline=false;assert.ok(await store().load(''));
  await store().clear('',c.value.token);assert.equal(await store().load(''),null);
  const blocked=createLoginStore({native:false,temporary:c.temporary,request:async()=>{throw Error('cookies blocked');}});assert.equal(await blocked.save('',c.value),false);assert.equal((await blocked.load('')).remember,false);
  for(const bad of [{...c.value,token:'bad'},{...c.value,expiresAt:1},{...c.value,user:null}])assert.equal(validSession(bad),null);
});

test('current jobs and immutable history are separated, with semantic success/failure styling',()=>{
  const states=['queued','running','processing','uploading','complete','failed','cancelled'];
  const split=partitionJobs(states.map(state=>({state})));assert.deepEqual(split.current.map(r=>r.state),states.slice(0,4));assert.deepEqual(split.history.map(r=>r.state),states.slice(4));assert.equal(jobStateClass('complete'),'job-complete');assert.equal(jobStateClass('failed'),'job-failed');assert.notEqual(jobStateClass('complete'),jobStateClass('failed'));
});

test('native exports preserve exact bytes in bounded 256KiB bridge chunks, close once and refuse writes after completion',async()=>{
  const source=randomBytes(1024*1024+79),chunks=[];let finished=0;
  const plugin={async begin(value){assert.equal(value.size,source.length);return {handle:'isolated-test-handle'};},async append({handle,data}){assert.equal(handle,'isolated-test-handle');const chunk=Buffer.from(data,'base64');assert(chunk.length<=256*1024);chunks.push(chunk);},async finish(){finished++;},async abort(){throw Error('Unexpected abort');}};
  const writer=await createExportWriter(plugin,'mirea.ndjson','application/x-ndjson',source.length);await writer.write(source);await writer.close();await writer.close();assert.equal(finished,1);assert.deepEqual(Buffer.concat(chunks),source);await assert.rejects(writer.write(source));
});
test('native export cancellation is idempotent and rejects further writes; selection failures never start a transfer',async()=>{
  let aborted=0;const plugin={async begin(){return {handle:'one'};},async append(){throw Error('Unexpected transfer');},async finish(){throw Error('Unexpected finish');},async abort({handle}){assert.equal(handle,'one');aborted++;}};
  const writer=await createExportWriter(plugin,'backup','application/octet-stream',100);await writer.abort();await writer.abort();assert.equal(aborted,1);await assert.rejects(writer.write(new Uint8Array(100)));
  await assert.rejects(createExportWriter({...plugin,begin:async()=>{throw Error('Picker cancelled');}},'backup','application/octet-stream',100),/cancelled/);
});
