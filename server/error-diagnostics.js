import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {relative,isAbsolute} from 'node:path';
import {PROJECT_ROOT} from './runtime.js';
import {DIAGNOSTIC_CODES,DIAGNOSTIC_SOURCES,normalizeDiagnostic} from './error-diagnostic-schema.js';
const get=(error,key)=>{try{return error?.[key];}catch{return undefined;}};
function classify(error,status){
  const code=get(error,'code');
  if(['EACCES','EPERM','EROFS','ERR_ACCESS_DENIED'].includes(code))return 'permission';
  if(['ENOSPC','EDQUOT','SQLITE_FULL'].includes(code))return 'capacity';
  if(code==='ERR_SQLITE_ERROR'||typeof code==='string'&&code.startsWith('SQLITE_'))return 'database';
  if(['EIO','ENODEV','ESTALE','ENOENT','ENOTDIR','EISDIR','ENOTEMPTY','EBUSY','EMFILE','ENFILE'].includes(code))return 'storage';
  if([401,403,404].includes(status))return 'authorization';
  if(status>=400&&status<500)return 'validation';
  return 'internal';
}
function trace(error){
  const stack=get(error,'stack');if(typeof stack!=='string')return [];
  const frames=[];
  // Take only V8 file locations rooted in this installation and known source
  // files. Discard function names, exception messages and all other frames.
  for(const line of stack.slice(0,65536).split('\n').slice(1,65)){
    const match=line.match(/^\s+at (?:.*? \()?((?:file:\/\/\/|[A-Za-z]:[\\/]|\/).*):(\d+):(\d+)\)?$/);if(!match)continue;
    let path;try{path=match[1].startsWith('file:')?fileURLToPath(match[1]):match[1];}catch{continue;}
    const source=relative(PROJECT_ROOT,path).replaceAll('\\','/');
    if(isAbsolute(source)||!DIAGNOSTIC_SOURCES.has(source))continue;
    frames.push({source,line:Number(match[2]),column:Number(match[3])});if(frames.length===8)break;
  }
  return frames;
}
const routes=new Map([
  ['DELETE /api/v1/series/:id','seriesDelete'],['POST /api/v1/series/bulk','seriesBulk'],
  ['PUT /api/v1/series/:id','seriesEdit'],['POST /api/v1/shelves/:id/series','seriesEdit'],
  ['DELETE /api/v1/items/:id','assetDelete'],['GET /api/v1/library/catalog','catalog'],
  ['GET /api/v1/shelves/:id/items','catalog'],['PATCH /api/v1/account','account'],['DELETE /api/v1/account','account']
]);
function operation(request){const route=request.routeOptions?.url??'';return routes.get(request.method+' '+route)??(route.startsWith('/api/v1/uploads/')||route==='/api/v1/shelves/:id/uploads'?'upload':route.startsWith('/api/v1/downloads')?'download':'request');}
function describe(error,status,includeTrace){
  const code=get(error,'code');return {category:classify(error,status),code:DIAGNOSTIC_CODES.has(code)?code:status<500?'HTTP_ERROR':'INTERNAL_ERROR',type:get(error,'name'),syscall:get(error,'syscall'),permission:get(error,'permission'),sqliteCode:get(error,'errcode'),trace:includeTrace?trace(error):[]};
}
export function createErrorDiagnostic(error,request,{status,serverVersion,now=Date.now()}={}){
  const includeTrace=status>=500,causes=[],seen=new Set([error]);let next=get(error,'cause');
  while(next&&typeof next==='object'&&!seen.has(next)&&causes.length<2){seen.add(next);causes.push(describe(next,status,includeTrace));next=get(next,'cause');}
  return normalizeDiagnostic({schemaVersion:1,errorId:randomUUID(),occurredAt:new Date(now).toISOString(),status,serverVersion,operation:operation(request),...describe(error,status,includeTrace),causes});
}
