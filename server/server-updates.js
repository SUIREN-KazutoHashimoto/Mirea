import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {httpError} from './security.js';
import {adminBody} from './admin.js';
import packageInfo from '../package.json' with {type:'json'};

export const RELEASE_API='https://api.github.com/repos/SUIREN-KazutoHashimoto/Mirea/releases';
export const RELEASE_PREFIX='https://github.com/SUIREN-KazutoHashimoto/Mirea/releases/download/';
const tagPattern=/^v(\d+)\.(\d+)\.(\d+)(beta(?:\.\d+)?)?$/;
export function versionTuple(tag){const m=tagPattern.exec(tag);return m?[Number(m[1]),Number(m[2]),Number(m[3]),m[4]?0:1,Number(m[4]?.split('.')[1]??0)]:null;}
export function newer(tag,current){const a=versionTuple(tag),b=versionTuple(current);if(!a||!b)return false;for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;}
export function releaseCandidate(release,current){
  const tag=release?.tag_name;if(!tagPattern.test(tag??'')||release.draft||!newer(tag,current))return null;
  const name=`mirea-${tag.slice(1)}-server.tar.gz`,asset=release.assets?.find(a=>a.name===name);
  if(!asset||asset.state!=='uploaded'||!Number.isSafeInteger(asset.id)||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>512*1024*1024||!/^sha256:[a-f0-9]{64}$/.test(asset.digest??'')||asset.browser_download_url!==RELEASE_PREFIX+tag+'/'+name)return null;
  return {tag,assetId:asset.id,name,size:asset.size,sha256:asset.digest.slice(7),url:asset.browser_download_url};
}
export async function githubJson(url,fetcher=fetch){
  if(url!==RELEASE_API+'?per_page=20' && !(url.startsWith(RELEASE_API+'/tags/') && tagPattern.test(url.slice((RELEASE_API+'/tags/').length))))throw new Error('Untrusted release API');
  const response=await fetcher(url,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Mirea-Server-Updater'},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw httpError(502,'GitHubのリリース情報を取得できません。時間をおいて再試行してください。');
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='',size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw new Error('Release metadata exceeds limit');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
  return JSON.parse(text);
}
export async function registerServerUpdates(app,{adminAccess:a,maintenance,options}){
  const directory=options.windowsMaintenanceDir??process.env.WINDOWS_MAINTENANCE_DIR;
  const root=directory?resolve(directory):null;let candidates=[],checkedAt=0;
  const watchers=new Map();
  app.addHook('onClose',async()=>{for(const [timer,unlock] of watchers){clearInterval(timer);unlock();}watchers.clear();});
  async function capability(){
    if(options.storageSeparated)return {enabled:false,reason:'分離ストレージは専用ヘルパーの自動バックアップ対象外です。全保存先を停止中にバックアップし、ホスト側で更新してください。'};
    if(!root)return {enabled:false,reason:'WinVAI01の専用更新ヘルパーを管理者が初期設定すると利用できます。'};
    try{const config=JSON.parse(await readFile(join(root,'capabilities.json'),'utf8'));if(config.protocol!==1||config.platform!=='win32'||!config.installed)throw new Error('Invalid helper');return {enabled:true,platform:'win32',automaticRollback:true};}
    catch{return {enabled:false,reason:'更新ヘルパーの設定・権限・稼働状態を確認してください。'};}
  }
  const auth={onRequest:async req=>a.requireAdmin(req)};
  app.get('/api/v1/admin/updates/status',auth,async()=>{
    let requests=[];
    if(root){try{for(const name of (await readdir(join(root,'status'))).filter(n=>/^[0-9a-f-]{36}\.json$/.test(n)).slice(-20)){
      const entry=JSON.parse(await readFile(join(root,'status',name),'utf8'));requests.push({id:name.slice(0,-5),state:entry.state,stage:entry.stage,tag:entry.tag,error:entry.error,updatedAt:entry.updatedAt});
    }}catch{/* Uninstalled helper: explicit disabled state, no fallback execution. */}}
    return {currentVersion:packageInfo.version,...await capability(),candidates,checkedAt,requests};
  });
  app.post('/api/v1/admin/updates/check',{...auth,config:{rateLimit:options.rateLimit===false?false:{max:6,timeWindow:'1 minute'}}},async req=>{
    const releases=await githubJson(RELEASE_API+'?per_page=20',options.releaseFetch);a.requireAdmin(req);
    if(!Array.isArray(releases))throw httpError(502,'リリース一覧が不正です。');
    candidates=releases.map(r=>releaseCandidate(r,'v'+packageInfo.version.replace('-beta','beta'))).filter(Boolean).sort((a,b)=>newer(a.tag,b.tag)?-1:1);checkedAt=Date.now();return {candidates,checkedAt};
  });
  app.post('/api/v1/admin/updates/apply',{...auth,schema:{body:adminBody({tag:{type:'string',pattern:tagPattern.source},confirmTag:{type:'string',maxLength:60},acknowledgeRestart:{const:true}})}},async(req,reply)=>{
    await a.reauthenticate(req);if(!(await capability()).enabled)throw httpError(409,'専用更新ヘルパーは未設定です。');
    if(req.body.confirmTag!==req.body.tag)throw httpError(400,'確認用バージョンが一致しません。');
    const release=await githubJson(RELEASE_API+'/tags/'+req.body.tag,options.releaseFetch);
    const candidate=releaseCandidate(release,'v'+packageInfo.version.replace('-beta','beta'));if(!candidate)throw httpError(409,'検証できる新しい公式サーバーパッケージがありません。');
    a.requireAdmin(req);const unlock=await maintenance.acquire(req);
    try{
      const requests=(await readdir(join(root,'requests'))).filter(n=>/^[0-9a-f-]{36}\.json$/.test(n));
      for(const name of requests){let status;try{status=JSON.parse(await readFile(join(root,'status',name),'utf8'));}catch{}if(!status||!['complete','failed','rolled_back'].includes(status.state))throw httpError(409,'別の更新要求が処理中です。');}
      const id=randomUUID();await writeFile(join(root,'requests',id+'.json'),JSON.stringify({protocol:1,id,tag:candidate.tag,assetId:candidate.assetId,sha256:candidate.sha256,requestedAt:Date.now()}),{flag:'wx',mode:0o600});
      a.audit(req,'server.update.request',id,{tag:candidate.tag,sha256:candidate.sha256});
      // Keep writes frozen until the agent claims the request and restarts the
      // process, or reports a terminal result. An unclaimed request expires at
      // the same two-minute boundary enforced independently by the helper.
      const started=Date.now();let watching=false,claimed=false;
      const timer=setInterval(async()=>{if(watching)return;watching=true;try{
        let status;try{status=JSON.parse(await readFile(join(root,'status',id+'.json'),'utf8'));}catch{}
        if(status)claimed=true;
        if(status&&['complete','failed','rolled_back'].includes(status.state)||!claimed&&Date.now()-started>125000){clearInterval(timer);watchers.delete(timer);unlock();}
      }finally{watching=false;}},2000);timer.unref();
      watchers.set(timer,unlock);
      return reply.code(202).send({id,tag:candidate.tag});
    }catch(error){unlock();throw error;}
  });
}
