import {Worker} from 'node:worker_threads';
import {join} from 'node:path';
import {httpError} from './security.js';
import {aiText} from './ai-validation.js';
import {waitForMediaWorker} from './media-worker-lifecycle.js';
export function validateAiSearch({query='',scope={},tags=[],tagMode='all',mode='text',offset=0,limit=40}={}) {
  query=aiText(query,500);
  if(!scope||typeof scope!=='object'||Array.isArray(scope)||Object.keys(scope).some(k=>!['shelfId','seriesId','playlistId','kind'].includes(k))||['shelfId','seriesId','playlistId'].some(k=>scope[k]!==undefined&&(typeof scope[k]!=='string'||!/^[0-9a-f-]{36}$/i.test(scope[k])))||scope.kind&&!['book','pdf','epub','image-book','video','audio'].includes(scope.kind)||!['all','any'].includes(tagMode))throw httpError(422,'検索範囲を確認してください。');
  if(!['text','semantic'].includes(mode)||!Number.isSafeInteger(offset)||offset<0||offset>100000||mode==='semantic'&&offset>10000||!Number.isSafeInteger(limit)||limit<1||limit>100||!Array.isArray(tags)||tags.length>16||tags.some(tag=>typeof tag!=='string'||tag.length>80))throw httpError(422,'検索条件を確認してください。');
  return {query,scope:{...scope},tags,tagMode,mode,offset,limit};
}
export async function searchAiLibrary({dataDir,userId,vector,vectorSpace,signal,...options}) {
  const validated=validateAiSearch(options);
  const worker=new Worker(new URL('./ai-search-worker.js',import.meta.url),{workerData:{filename:join(dataDir,'mirea.sqlite'),userId,...validated,vector,vectorSpace},resourceLimits:{maxOldGenerationSizeMb:128}});
  const result=await waitForMediaWorker(worker,{signal,timeoutMs:5000});
  if(result.error)throw httpError(503,'検索を準備できません。もう一度検索してください。');return result;
}
