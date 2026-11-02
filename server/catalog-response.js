import {createHash} from 'node:crypto';

const collections=['shelves','items','series','playlists'];
const digest=value=>createHash('sha256').update(value).digest('hex');
const conditionalTags=value=>typeof value==='string'&&value.length<=2048?value.split(',').map(tag=>tag.trim().replace(/^W\//,'')):[];
const scopeOf=snapshot=>digest(JSON.stringify(snapshot.shelves.map(shelf=>[shelf.id,shelf.role,!!shelf.private]).sort((a,b)=>a[0].localeCompare(b[0]))));

// Only authorized snapshots enter this cache. It is not an authentication cache:
// the route always rebuilds the current view under current membership first.
// Buffers are bounded globally, with only the latest snapshot per account.
export function createCatalogResponses({maxBytes=32*1024*1024,maxUsers=256,maxAgeMs=10*60*1000,now=Date.now}={}){
 const cache=new Map();let bytes=0;
 const discard=key=>{const previous=cache.get(key);if(previous){bytes-=previous.buffer.length;cache.delete(key);}};
 function save(userId,entry){
  discard(userId);if(entry.buffer.length>maxBytes)return;
  while(cache.size&&(bytes+entry.buffer.length>maxBytes||cache.size>=maxUsers))discard(cache.keys().next().value);
  cache.set(userId,entry);bytes+=entry.buffer.length;
 }
 return {
  respond(snapshot,{ifNoneMatch,delta=false}={}){
   const time=now();for(const [id,entry]of cache)if(time-entry.at>maxAgeMs)discard(id);
   const {serverTime,...content}=snapshot,buffer=Buffer.from(JSON.stringify(content)),etag='"'+digest(buffer)+'"',scope=scopeOf(snapshot),previous=cache.get(snapshot.userId),tags=conditionalTags(ifNoneMatch);
   save(snapshot.userId,{buffer,etag,scope,at:time});
   const headers={etag,'x-mirea-server-time':String(serverTime)};
   if(tags.includes(etag)||tags.includes('*'))return {status:304,headers};
   const full={...snapshot,etag};
   if(!delta||tags.length!==1||!previous||tags[0]!==previous.etag||previous.scope!==scope)return {status:200,headers,body:full};
   const base=JSON.parse(previous.buffer.toString('utf8')),changes={};
   for(const name of collections){
    const before=base[name],after=snapshot[name],prior=new Map(before.map(row=>[row.id,JSON.stringify(row)])),ids=new Set(after.map(row=>row.id));
    const upsert=after.filter(row=>prior.get(row.id)!==JSON.stringify(row)),remove=before.filter(row=>!ids.has(row.id)).map(row=>row.id),changedOrder=before.length!==after.length||before.some((row,index)=>row.id!==after[index]?.id);
    changes[name]={upsert,remove,...(changedOrder?{order:after.map(row=>row.id)}:{})};
   }
   const patch={version:snapshot.version,userId:snapshot.userId,serverTime,etag,baseEtag:previous.etag,delta:changes};
   return {status:200,headers,body:Buffer.byteLength(JSON.stringify(patch))<buffer.length?patch:full};
  },
  clear(){cache.clear();bytes=0;},
  stats(){return {users:cache.size,bytes};},
 };
}
