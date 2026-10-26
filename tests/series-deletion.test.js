import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.js';

test('recursive deletion of 35 series and 101 published assets with retained upload records',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-delete-regression-'));
  const app=await createApp({dataDir,rateLimit:false}),db=new DatabaseSync(join(dataDir,'mirea.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{await app.close();db.close();await rm(dataDir,{recursive:true,force:true});});
  const errors=[];app.addHook('onError',async(_req,_reply,error)=>{errors.push(error.stack);});
  let token;
  const req=(method,path,payload)=>app.inject({method,url:'/api/v1'+path,headers:token?{authorization:'Bearer '+token}:{},...(payload?{payload}:{})});
  const owner=(await req('POST','/auth/register',{name:'Synthetic owner',email:'delete-test@example.test',password:'synthetic-test-password'})).json();token=owner.token;
  const shelf=(await req('POST','/shelves',{name:'Synthetic shelf'})).json().id;
  const series=[];
  for(let n=0;n<35;n++){
    const response=await req('POST','/shelves/'+shelf+'/series',{title:'Series '+n,parentId:n?series[Math.floor((n-1)/3)].id:null,requestId:randomUUID()});
    assert.equal(response.statusCode,201,response.body);series.push(response.json().series);
  }
  for(let n=0;n<101;n++){
    const id=randomUUID(),parent=series[n%35].id,now=Date.now();
    db.prepare("INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,'fixture.pdf','application/pdf',1,?,?)").run(id,shelf,'Asset '+n,owner.user.id,now);
    db.prepare('INSERT INTO series_items VALUES(?,?,?,?)').run(parent,id,Math.floor(n/35)+1,'');
    db.prepare("INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at,target_series_id,series_requested) VALUES(?,?,?,'synthetic',?,'[]',8388608,'complete',?,?,?,1)").run(id,shelf,owner.user.id,'Asset '+n,now,now+86400000,parent);
  }
  const root=(await req('GET','/series/'+series[0].id)).json().series,previewResponse=await req('GET','/series/'+root.id+'/delete-preview');
  assert.equal(previewResponse.statusCode,200,previewResponse.body);
  const preview=previewResponse.json();assert.deepEqual([preview.seriesCount,preview.assetCount,preview.pendingCount],[35,101,0]);
  const response=await req('DELETE','/series/'+root.id,{revision:root.revision,deleteContents:true,previewHash:preview.previewHash});
  assert.equal(response.statusCode,204,response.body+'\n'+errors.join('\n'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM series').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM upload_sessions').get().n,0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
