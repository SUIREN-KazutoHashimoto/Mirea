import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

const password='account-test-password';
const cookieOf=response=>response.headers['set-cookie'].split(';')[0];

test('remembered browser sessions persist without renewing, remain HttpOnly and never authorize other APIs',async t=>{
  const c=await setup(t),response=await c.req('POST','/auth/login',null,{email:c.owner.user.email,password}),value=response.json(),cookie=cookieOf(response),header=response.headers['set-cookie'];
  for(const attribute of ['Path=/api/v1','Secure','HttpOnly','SameSite=Strict','Expires='])assert.ok(header.includes(attribute),header);
  assert.ok(!/Domain=/i.test(header));assert.ok(Number(header.match(/Max-Age=(\d+)/)[1])<=2592000);
  const count=c.db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
  for(let i=0;i<2;i++){
    const restored=await c.app.inject({url:'/api/v1/auth/remember',headers:{cookie}});assert.equal(restored.statusCode,200,restored.body);assert.deepEqual(restored.json(),value);assert.match(restored.headers['cache-control'],/no-store/);
  }
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,count);
  assert.equal((await c.app.inject({url:'/api/v1/shelves',headers:{cookie}})).statusCode,401);
  assert.equal((await c.app.inject({method:'POST',url:'/api/v1/auth/remember',headers:{cookie}})).statusCode,401);
  assert.equal((await c.app.inject({url:'/api/v1/auth/remember',headers:{cookie,'sec-fetch-site':'cross-site'}})).statusCode,403);
  assert.equal((await c.app.inject({url:'/api/v1/auth/remember',headers:{cookie:cookie+'; '+cookie}})).statusCode,401);
  const optedOut=await c.req('POST','/auth/login',null,{email:c.owner.user.email,password,remember:false});assert.match(optedOut.headers['set-cookie'],/Max-Age=0/);
  const enabled=await c.req('POST','/auth/remember',value);assert.equal(cookieOf(enabled),cookie);
  const unmatched=await c.app.inject({method:'DELETE',url:'/api/v1/auth/remember',headers:{cookie},payload:{token:c.member.token}});assert.equal(unmatched.statusCode,204);assert.equal(unmatched.headers['set-cookie'],undefined);
  const forgotten=await c.app.inject({method:'DELETE',url:'/api/v1/auth/remember',headers:{cookie},payload:{token:value.token}});assert.equal(forgotten.statusCode,204);assert.match(forgotten.headers['set-cookie'],/Max-Age=0/);
  await c.app.close();c.app=await createApp(c.options);
  assert.equal((await c.app.inject({url:'/api/v1/auth/remember',headers:{cookie}})).statusCode,200,'survives server restart');
  const logout=await c.req('POST','/auth/logout',value);assert.equal(logout.statusCode,204);assert.match(logout.headers['set-cookie'],/Max-Age=0/);
  assert.equal((await c.app.inject({url:'/api/v1/auth/remember',headers:{cookie}})).statusCode,401);
});

test('remembered sessions reject expiry, disabled accounts and revoked credentials; account edits rotate remembered cookies',async t=>{
  const c=await setup(t),login=await c.req('POST','/auth/login',null,{email:c.owner.user.email,password}),cookie=cookieOf(login);
  const changed=await c.app.inject({method:'PATCH',url:'/api/v1/account',headers:{authorization:'Bearer '+login.json().token,cookie},payload:{name:'Updated',currentPassword:password}});
  assert.equal(changed.statusCode,200,changed.body);const next=cookieOf(changed);assert.notEqual(next,cookie);
  assert.equal((await c.app.inject({url:'/api/v1/auth/remember',headers:{cookie}})).statusCode,401);
  assert.equal((await c.app.inject({url:'/api/v1/auth/remember',headers:{cookie:next}})).json().user.name,'Updated');
  c.db.prepare('UPDATE sessions SET expires_at=1 WHERE user_id=?').run(c.owner.user.id);
  assert.equal((await c.app.inject({url:'/api/v1/auth/remember',headers:{cookie:next}})).statusCode,401);
  const other=await c.req('POST','/auth/login',null,{email:c.member.user.email,password});
  c.db.prepare("INSERT INTO user_access(user_id,server_role,disabled) VALUES(?,'user',1)").run(c.member.user.id);
  assert.equal((await c.app.inject({url:'/api/v1/auth/remember',headers:{cookie:cookieOf(other)}})).statusCode,401);
});
async function setup(t){
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-accounts-')),options={dataDir,rateLimit:false};
  const c={dataDir,options,app:await createApp(options)};
  c.db=new DatabaseSync(join(dataDir,'mirea.sqlite'));c.db.exec('PRAGMA foreign_keys=ON');
  t.after(async()=>{c.db.close();await c.app.close();await rm(dataDir,{recursive:true,force:true});});
  c.req=(method,path,user,body)=>c.app.inject({method,url:`/api/v1${path}`,headers:user?{authorization:`Bearer ${user.token}`}:{},...(body?{payload:body}:{})});
  c.register=async name=>{const r=await c.req('POST','/auth/register',null,{name,email:`${name}@example.test`,password});assert.equal(r.statusCode,201,r.body);return r.json();};
  c.owner=await c.register('owner');c.member=await c.register('member');c.other=await c.register('other');
  c.shelf=async(user=c.owner)=>{const r=await c.req('POST','/shelves',user,{name:'Shared shelf'});assert.equal(r.statusCode,201,r.body);return r.json().id;};
  c.add=(shelf,user,role='viewer')=>c.req('POST',`/shelves/${shelf}/members`,c.owner,{email:user.user.email,role});
  c.asset=(shelf,user=c.owner)=>{const id=randomUUID();c.db.prepare(`INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES(?,?,?,'fixture.pdf','application/pdf',100,?,1)`).run(id,shelf,'Preserved book',user.user.id);return id;};
  c.remove=(user,extra={})=>c.req('DELETE','/account',user,{currentPassword:password,confirmEmail:user.user.email,...extra});
  return c;
}

test('account changes require password confirmation, normalize fields, rotate every session/ticket and persist',async t=>{
  const c=await setup(t),shelf=await c.shelf(),asset=c.asset(shelf);
  const second=(await c.req('POST','/auth/login',null,{email:c.owner.user.email,password})).json();
  const ticket=(await c.req('POST',`/items/${asset}/playback-ticket`,c.owner)).json();
  assert.equal((await c.req('GET','/account',null)).statusCode,401);
  const info=(await c.req('GET','/account',c.owner)).json();
  assert.equal(info.ownedShelves[0].assetCount,1);assert.equal(info.user.id,c.owner.user.id);
  assert.ok(!JSON.stringify(info).includes('password_hash'));
  for(const body of [{name:'New'}, {currentPassword:'wrong',name:'New'}, {currentPassword:password,newPassword:'short'}, {currentPassword:password,name:'   '}]){
    assert.ok([400,403].includes((await c.req('PATCH','/account',c.owner,body)).statusCode));
  }
  assert.equal((await c.req('PATCH','/account',c.owner,{currentPassword:password,email:c.member.user.email})).statusCode,409);
  const updated=await c.req('PATCH','/account',c.owner,{currentPassword:password,name:'  Changed  ',email:'CHANGED@EXAMPLE.TEST',newPassword:'new-account-password',serverAdmin:true});
  assert.equal(updated.statusCode,200,updated.body);const result=updated.json();
  assert.equal(result.user.name,'Changed');assert.equal(result.user.email,'changed@example.test');
  assert.equal(result.user.serverAdmin,undefined);assert.notEqual(result.token,c.owner.token);
  for(const user of [c.owner,second])assert.equal((await c.req('GET','/auth/me',user)).statusCode,401);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM playback_tickets').get().n,0,ticket.url);
  assert.equal((await c.req('GET','/auth/me',result)).statusCode,200);
  assert.equal((await c.req('POST','/auth/login',null,{email:'changed@example.test',password})).statusCode,401);
  assert.equal((await c.req('POST','/auth/login',null,{email:'changed@example.test',password:'new-account-password'})).statusCode,200);
  await c.app.close();c.app=await createApp(c.options);
  assert.equal((await c.req('GET','/account',result)).json().user.name,'Changed');
});

test('ownership transfer rechecks password and permissions, keeps exactly one owner and enables safe account deletion',async t=>{
  const c=await setup(t),shelf=await c.shelf(),asset=c.asset(shelf);await c.add(shelf,c.member);
  const path=`/shelves/${shelf}/owner`,body={currentPassword:password,userId:c.member.user.id};
  assert.equal((await c.remove(c.owner)).statusCode,409);
  assert.equal((await c.req('PUT',path,c.member,body)).statusCode,403);
  assert.equal((await c.req('PUT',path,c.other,body)).statusCode,404);
  assert.equal((await c.req('PUT',path,c.owner,{...body,currentPassword:'wrong'})).statusCode,403);
  assert.equal((await c.req('PUT',path,c.owner,{...body,userId:c.other.user.id})).statusCode,404);
  assert.equal((await c.req('PUT',path,c.owner,{...body,userId:c.owner.user.id})).statusCode,400);
  assert.equal((await c.req('PUT',path,c.owner,body)).statusCode,204);
  assert.deepEqual(c.db.prepare("SELECT user_id FROM memberships WHERE shelf_id=? AND role='owner'").all(shelf).map(r=>r.user_id),[c.member.user.id]);
  assert.equal(c.db.prepare('SELECT role FROM memberships WHERE shelf_id=? AND user_id=?').get(shelf,c.owner.user.id).role,'editor');
  assert.equal((await c.req('PUT',path,c.owner,{...body,userId:c.other.user.id})).statusCode,403);
  assert.equal((await c.remove(c.owner)).statusCode,204);
  assert.equal(c.db.prepare('SELECT uploaded_by FROM items WHERE id=?').get(asset).uploaded_by,null);
  assert.equal((await c.req('GET',`/shelves/${shelf}/items`,c.member)).json().items[0].id,asset);
});

test('account deletion removes only personal data, preserves other users/shared assets and cleans cancelled upload files',async t=>{
  const c=await setup(t),shelf=await c.shelf(),empty=await c.shelf(c.member);await c.add(shelf,c.member,'editor');
  const asset=c.asset(shelf,c.member),otherAsset=c.asset(shelf);
  for(const user of [c.owner,c.member]){
    const id=user.user.id;
    c.db.prepare(`INSERT INTO asset_progress(user_id,asset_id,revision,update_id,payload_hash,page_number,updated_at) VALUES(?,?,1,'update','hash',1,1)`).run(id,asset);
    c.db.prepare('INSERT INTO encrypted_downloads VALUES(?,?,?,?,1)').run(randomUUID(),id,asset,'{}');
    c.db.prepare(`INSERT INTO analytics_views(id,user_id,asset_id,shelf_id,asset_kind,asset_title,page_count,context,platform,client_version,auth_session_id,opened_at,first_received_at,last_received_at)
      VALUES(?,?,?,?,'pdf','Book',1,'viewer','web','test','session',1,1,1)`).run(id,id,asset,shelf);
    c.db.prepare(`INSERT INTO analytics_events(event_id,view_id,seq,event_type,client_at,received_at,elapsed_ms,interval_ms,visible_ms,active_ms,watch_ms,payload_json,payload_hash) VALUES(?,?,1,'open',1,1,0,0,0,0,0,'{}','hash')`).run(id,id);
    c.db.prepare('INSERT INTO analytics_pages VALUES(?,1,1,100,100)').run(id);
    c.db.prepare('INSERT INTO analytics_video_bins VALUES(?,0,100,100)').run(id);
  }
  const upload=randomUUID();
  c.db.prepare(`INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at) VALUES(?,?,?,'session','cancelled','[]',100,'cancelled',1,1)`).run(upload,shelf,c.member.user.id);
  const staging=join(c.dataDir,'uploads','transfers',upload);await mkdir(staging,{recursive:true});
  assert.equal((await c.remove(c.member,{confirmEmail:c.owner.user.email})).statusCode,400);
  assert.equal((await c.remove(c.member,{currentPassword:'wrong'})).statusCode,403);
  assert.equal((await c.remove(c.member)).statusCode,204);
  assert.equal((await c.req('GET','/account',c.member)).statusCode,401);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM users WHERE id=?').get(c.member.user.id).n,0);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM shelves WHERE id=?').get(empty).n,0);
  assert.equal(c.db.prepare('SELECT uploaded_by FROM items WHERE id=?').get(asset).uploaded_by,null);
  assert.equal(c.db.prepare('SELECT uploaded_by FROM items WHERE id=?').get(otherAsset).uploaded_by,c.owner.user.id);
  for(const table of ['asset_progress','encrypted_downloads','analytics_views'])assert.equal(c.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(c.member.user.id).n,0,table);
  for(const table of ['analytics_events','analytics_pages','analytics_video_bins'])assert.equal(c.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,1,table);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM upload_sessions WHERE user_id=?').get(c.member.user.id).n,0);
  await assert.rejects(()=>access(staging));assert.deepEqual(c.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal((await c.register('member')).user.email,c.member.user.email,'deleted email can be registered without inheriting history');
});

test('deletion blocks active uploads, last allowlisted server administrator, nonempty owned shelves and shared empty shelves',async t=>{
  const c=await setup(t),shelf=await c.shelf();await c.add(shelf,c.member);
  assert.equal((await c.remove(c.owner)).statusCode,409,'empty shared shelf still needs an owner');
  const upload=randomUUID();c.db.prepare(`INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at) VALUES(?,?,?,'session','active','[]',100,'uploading',1,?)`).run(upload,shelf,c.member.user.id,Date.now()+60000);
  assert.equal((await c.remove(c.member)).statusCode,409);
  c.db.prepare("UPDATE upload_sessions SET state='processing',expires_at=1 WHERE id=?").run(upload);
  assert.equal((await c.remove(c.member)).statusCode,409,'processing remains protected even after expiration');
  c.db.prepare("UPDATE upload_sessions SET state='cancelled' WHERE id=?").run(upload);
  const old=process.env.SERVER_ADMIN_USER_IDS;t.after(()=>{if(old===undefined)delete process.env.SERVER_ADMIN_USER_IDS;else process.env.SERVER_ADMIN_USER_IDS=old;});
  process.env.SERVER_ADMIN_USER_IDS=c.member.user.id;
  assert.equal((await c.req('GET','/account',c.member)).json().lastServerAdmin,true);
  assert.equal((await c.remove(c.member)).statusCode,409);
  process.env.SERVER_ADMIN_USER_IDS=`${c.member.user.id},${c.other.user.id}`;
  assert.equal((await c.remove(c.member)).statusCode,204);
  c.asset(shelf);assert.equal((await c.remove(c.owner)).statusCode,409);
});
