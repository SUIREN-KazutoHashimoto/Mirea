import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createErrorDiagnostic} from '../server/error-diagnostics.js';
import {normalizeDiagnostic} from '../server/error-diagnostic-schema.js';
import {PROJECT_ROOT} from '../server/runtime.js';
import {createApp} from '../server/app.js';
import {requestError,recentDiagnostics,clearDiagnostics,diagnosticText,recordClientError,recordDiagnostic} from '../web/src/error-diagnostics.js';
const secret='秘密の作品@example.test_TOKEN_013579';
const request={method:'DELETE',routeOptions:{url:'/api/v1/series/:id'},url:'/api/v1/series/'+secret+'?password='+secret,body:{title:secret},headers:{authorization:'Bearer '+secret}};
function error(){
  const root=Object.assign(new Error('cannot remove '+secret),{code:'EACCES',syscall:'rmdir',path:'/mnt/PrivatePool/'+secret});
  root.stack=`Error: ${secret}\n    at ${secret} (${pathToFileURL(join(PROJECT_ROOT,'server/series-actions.js'))}:43:12)\n    at native (/mnt/PrivatePool/${secret}:1:1)\n    at ${secret} (${pathToFileURL(join(PROJECT_ROOT,'server/secret-title.js'))}:44:13)`;
  root.cause=Object.assign(new Error(secret),{code:'ERR_SQLITE_ERROR',errcode:787,sql:secret,cause:root});return root;
}
test('safe diagnostics are an allowlisted projection, not raw messages with masking gaps',()=>{
  const value=createErrorDiagnostic(error(),request,{status:500,serverVersion:'0.18.1-beta'}),raw=JSON.stringify(value);
  assert.equal(value.category,'permission');assert.equal(value.code,'EACCES');assert.equal(value.syscall,'rmdir');assert.equal(value.operation,'seriesDelete');
  assert.deepEqual(value.trace,[{source:'server/series-actions.js',line:43,column:12}]);assert.equal(value.causes.length,1);assert.equal(value.causes[0].sqliteCode,787);
  for(const forbidden of [secret,'PrivatePool','password','authorization','cannot remove','secret-title',PROJECT_ROOT,'Bearer','sql"'])assert(!raw.includes(forbidden),forbidden);
  assert.equal(normalizeDiagnostic({...value,message:secret,path:secret,request,trace:[...value.trace,{source:secret,line:1,column:1}]}).trace.length,1);
});
test('unknown and hostile errors fail closed, bound traces and causes, and never serialize arbitrary codes or getters',()=>{
  const value=createErrorDiagnostic(Object.assign(error(),{code:secret,name:secret,syscall:secret,permission:secret,errcode:99999}),request,{status:500,serverVersion:secret});
  assert.equal(value.code,'INTERNAL_ERROR');assert.equal(value.type,'Error');assert(!diagnosticText(value).includes(secret));
  const hostile={get code(){throw Error(secret);},get stack(){throw Error(secret);},get cause(){throw Error(secret);}};
  assert.equal(createErrorDiagnostic(hostile,request,{status:500}).trace.length,0);
  const large=error();large.stack+=Array.from({length:200},()=>`\n    at function (${pathToFileURL(join(PROJECT_ROOT,'server/app.js'))}:90:1)`).join('');
  assert.equal(createErrorDiagnostic(large,request,{status:500}).trace.length,8);
  const expected=createErrorDiagnostic(error(),request,{status:404});assert.deepEqual(expected.trace,[]);assert(expected.causes.every(c=>!c.trace.length));
});
test('browser reports are bounded, explicitly copied, revalidated, ephemeral and cleared across identity boundaries',()=>{
  clearDiagnostics();const diagnostic=createErrorDiagnostic(error(),request,{status:500}),failure=requestError({error:'公開メッセージ',diagnostic},500);
  assert.equal(failure.status,500);assert.equal(recentDiagnostics().length,1);recordClientError(failure);assert.equal(recentDiagnostics().length,1);
  const copy=recentDiagnostics();copy[0].trace[0].source=secret;assert(!diagnosticText(recentDiagnostics()[0]).includes(secret));
  for(let n=0;n<25;n++)recordDiagnostic({...diagnostic,errorId:randomUUID()});assert.equal(recentDiagnostics().length,20);
  clearDiagnostics();assert.equal(recentDiagnostics().length,0);
  requestError({error:secret,diagnostic:{schemaVersion:1,errorId:secret}},502);assert.equal(recentDiagnostics().length,1);assert(!diagnosticText(recentDiagnostics()[0]).includes(secret));clearDiagnostics();
  requestError({error:secret,diagnostic},500,{record:false});assert.equal(recentDiagnostics().length,0,'late responses and expected remember-cookie failures stay quiet');
});
test('ordinary authenticated users receive only their own sanitized error; anonymous errors have no stack and failures are not exposed through a log API',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mirea-diagnostics-')),app=await createApp({dataDir,rateLimit:false}),db=new DatabaseSync(join(dataDir,'mirea.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');t.after(async()=>{await app.close();db.close();await rm(dataDir,{recursive:true,force:true});});
  app.get('/synthetic-error',async()=>{throw error();});
  const req=(method,path,user,payload)=>app.inject({method,url:'/api/v1'+path,headers:user?{authorization:'Bearer '+user.token}:{},...(payload?{payload}:{})});
  const user=(await req('POST','/auth/register',null,{name:'Synthetic normal user',email:'normal@example.test',password:'synthetic-test-password'})).json();
  assert.equal((await req('GET','/admin/processing-settings',user)).statusCode,403);
  const shelf=(await req('POST','/shelves',user,{name:secret})).json().id;
  const series=(await req('POST','/shelves/'+shelf+'/series',user,{title:secret})).json().series;
  db.exec(`CREATE TRIGGER synthetic_delete_failure BEFORE DELETE ON series BEGIN SELECT RAISE(ABORT,'${secret}');END;`);
  const response=await req('DELETE','/series/'+series.id,user,{revision:series.revision});assert.equal(response.statusCode,500);
  const value=response.json();assert.equal(value.error,'サーバーでエラーが発生しました。');assert.equal(value.diagnostic.code,'ERR_SQLITE_ERROR');assert.equal(value.diagnostic.operation,'seriesDelete');assert(value.diagnostic.trace.some(f=>f.source==='server/series-actions.js'));
  assert.equal(response.headers['x-mirea-error-id'],value.diagnostic.errorId);assert.match(response.headers['cache-control'],/no-store/);assert(!response.body.includes(secret));assert(!response.body.includes(series.id));
  const anonymous=await app.inject('/synthetic-error');assert.equal(anonymous.statusCode,500);assert.equal(anonymous.json().diagnostic,undefined);assert(!anonymous.body.includes(secret));
  assert.equal((await req('GET','/error-diagnostics',user)).statusCode,404);
  assert(db.prepare('SELECT 1 FROM series WHERE id=?').get(series.id),'transaction rolls back without data loss');
});
test('all UI details use textContent and escaped static markup; no local storage, raw stack, automatic upload or production-log retrieval',async()=>{
  const source=await readFile(new URL('../web/src/error-diagnostics.js',import.meta.url),'utf8');
  for(const forbidden of ['localStorage','sessionStorage','innerHTML','fetch(','error.stack','error.message'])assert(!source.includes(forbidden),forbidden);
  assert(source.includes('navigator.clipboard.writeText(diagnosticText(report))'));assert(source.includes("dialog[open]:not(.diagnostic-modal)"));
  const api=await readFile(new URL('../web/src/api.js',import.meta.url),'utf8');assert(api.includes('clearDiagnostics();session=null'));assert(api.includes('clearDiagnostics();authRevision++'));
  assert.match(api.split('export async function authenticatedBlob')[1],/const token = session\?\.token,context=authRevision;/);
});
