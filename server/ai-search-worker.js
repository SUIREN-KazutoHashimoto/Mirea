import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';

const {filename,userId,query='',scope={},tags=[],tagMode='all',mode='text',vector,vectorSpace,limit=40,offset=0}=workerData;
const db=new DatabaseSync(filename,{readOnly:true});
const normalize=value=>String(value).normalize('NFKC').toLocaleLowerCase('ja').replace(/[ァ-ヶ]/gu,c=>String.fromCharCode(c.charCodeAt(0)-0x60)).replace(/\s+/gu,' ').trim();
const escapeLike=value=>value.replace(/[\\%_]/g,match=>'\\'+match);
db.function('mirea_normalize',{deterministic:true},normalize);
const parameters=[userId],conditions=['m.user_id=?'];
if(scope.shelfId){conditions.push('i.shelf_id=?');parameters.push(scope.shelfId);}
else conditions.push('s.private=0');
if(scope.seriesId){
  conditions.push(`i.id IN (SELECT asset_id FROM series_items WHERE series_id IN (
    WITH RECURSIVE tree(id) AS (SELECT id FROM series WHERE id=? UNION ALL
    SELECT c.id FROM series c JOIN tree p ON c.parent_id=p.id) SELECT id FROM tree))`);
  parameters.push(scope.seriesId);
}
if(scope.playlistId){
  conditions.push('i.id IN (SELECT pi.asset_id FROM playlist_items pi JOIN playlists p ON p.id=pi.playlist_id WHERE p.id=? AND p.user_id=?)');
  parameters.push(scope.playlistId,userId);
}
if(scope.kind){
  const types={audio:"i.mime_type LIKE 'audio/%'",video:"i.mime_type LIKE 'video/%'",
    pdf:"i.mime_type='application/pdf'",epub:"i.mime_type='application/epub+zip'",'image-book':"i.mime_type='application/vnd.mirea.image-book'",book:"i.mime_type IN ('application/pdf','application/epub+zip','application/vnd.mirea.image-book')"};
  if(types[scope.kind])conditions.push(types[scope.kind]);
}
const tagConditions=[];
for(const tag of tags){
  tagConditions.push(`EXISTS(SELECT 1 FROM asset_tags t WHERE t.asset_id=i.id AND t.normalized=?
    AND t.rejected=0 AND (t.user_id IS NULL OR t.user_id=?))`);
  parameters.push(normalize(tag),userId);
}
if(tagConditions.length)conditions.push('('+tagConditions.join(tagMode==='any'?' OR ':' AND ')+')');
const base='FROM items i JOIN shelves s ON s.id=i.shelf_id JOIN memberships m ON m.shelf_id=i.shelf_id';
const authorized=conditions.join(' AND ');
try{
  const term=normalize(query),pattern='%'+escapeLike(term)+'%',values=[...parameters];
  let matches='';
  if(term){
    const documentMatch=Array.from(term).length>=3?"d.rowid IN (SELECT rowid FROM ai_documents_fts WHERE ai_documents_fts MATCH ?)":"d.normalized LIKE ? ESCAPE '\\'";
    matches=` AND (mirea_normalize(i.title) LIKE ? ESCAPE '\\' OR EXISTS(
      SELECT 1 FROM asset_tags t WHERE t.asset_id=i.id AND t.rejected=0 AND
      (t.user_id IS NULL OR t.user_id=?) AND t.normalized LIKE ? ESCAPE '\\')
      OR EXISTS(SELECT 1 FROM ai_documents d WHERE d.asset_id=i.id AND ${documentMatch}))`;
    values.push(pattern,userId,pattern,Array.from(term).length>=3?'"'+term.replaceAll('"','""')+'"':pattern);
  }
  const semanticQuery=mode==='semantic'&&Array.isArray(vector)&&vector.length&&vectorSpace;
  let rows=db.prepare('SELECT i.id,i.title,i.shelf_id '+base+' WHERE '+authorized+matches+
    ` ORDER BY CASE WHEN mirea_normalize(i.title) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,mirea_normalize(i.title),i.id LIMIT ? OFFSET ?`).all(...values,pattern,semanticQuery?offset+limit+1:limit+1,semanticQuery?0:offset).map(row=>({...row,lexical:1}));
  const scores=new Map(),evidence=new Map();let semanticPartial=false;
  if(semanticQuery){
    const q=Float32Array.from(vector),qnorm=Math.sqrt(q.reduce((n,x)=>n+x*x,0));
    const nearest=[],deadline=Date.now()+1000;
    const statement=db.prepare(`SELECT d.asset_id,d.vector,d.feature,d.locator_json,d.text FROM ai_documents d JOIN items i ON i.id=d.asset_id
      JOIN shelves s ON s.id=i.shelf_id JOIN memberships m ON m.shelf_id=i.shelf_id
      WHERE ${authorized} AND d.vector_space=? AND d.vector IS NOT NULL`);
    let examined=0;
    for(const row of statement.iterate(...parameters,vectorSpace)){
      if(++examined%64===0&&Date.now()>deadline){semanticPartial=true;break;}
      if(row.vector.byteLength!==q.byteLength)continue;
      const bytes=new Uint8Array(row.vector),v=new Float32Array(bytes.slice().buffer);
      let dot=0,norm=0;for(let i=0;i<v.length;i++){dot+=q[i]*v[i];norm+=v[i]*v[i];}
      const score=qnorm&&norm?dot/(qnorm*Math.sqrt(norm)):0;
      if(score>(scores.get(row.asset_id)??-2)){scores.set(row.asset_id,score);evidence.set(row.asset_id,{feature:row.feature,locator:JSON.parse(row.locator_json),text:row.text.slice(0,240)});}
    }
    for(const [id,score]of scores)nearest.push({id,score});
    nearest.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
    const best=nearest.slice(0,offset+limit+rows.length+1);
    const select=db.prepare('SELECT i.id,i.title,i.shelf_id,'+(matches?matches.slice(5):'1')+' lexical '+base+' WHERE '+authorized+' AND i.id=?');
    const semantic=best.map(row=>select.get(...values.slice(parameters.length),...parameters,row.id)).filter(Boolean);
    const lexical=new Set(rows.map(row=>row.id)),combined=new Map([...rows,...semantic].map(row=>[row.id,row]));
    const rank=row=>term&&normalize(row.title).includes(term)?0:row.lexical?1:2;
    rows=[...combined.values()].sort((a,b)=>rank(a)-rank(b)||(rank(a)===2?(scores.get(b.id)??-2)-(scores.get(a.id)??-2):0)||Buffer.compare(Buffer.from(normalize(a.title)),Buffer.from(normalize(b.title)))||a.id.localeCompare(b.id)).slice(offset,offset+limit+1);
  }
  const result=rows.slice(0,limit).map(item=>{
    const hits=term?db.prepare(`SELECT feature,locator_json,text FROM ai_documents WHERE asset_id=?
      AND normalized LIKE ? ESCAPE '\\' ORDER BY length(text),id LIMIT 64`).all(item.id,pattern):[];
    const uniqueHits=[],seenHits=new Set();for(const hit of hits){const locator=JSON.parse(hit.locator_json),key=hit.feature+':'+(locator.blockId??locator.segmentId??JSON.stringify(locator));if(seenHits.has(key))continue;seenHits.add(key);uniqueHits.push(hit);if(uniqueHits.length===8)break;}
    return {assetId:item.id,title:item.title,shelfId:item.shelf_id,
      reason:normalize(item.title).includes(term)&&term?'title':hits.length?'content':scores.has(item.id)?'similarity':'tag',
      hits:uniqueHits.length?uniqueHits.map(hit=>({feature:hit.feature,locator:JSON.parse(hit.locator_json),text:hit.text.slice(0,240)})):evidence.has(item.id)?[evidence.get(item.id)]:[]};
  });
  parentPort.postMessage({items:result,hasMore:rows.length>limit,offset:offset+result.length,semantic:mode==='semantic'&&Boolean(vector),semanticPartial});
}catch{parentPort.postMessage({error:'AI_SEARCH_FAILED'});}
finally{db.close();parentPort.close();}
