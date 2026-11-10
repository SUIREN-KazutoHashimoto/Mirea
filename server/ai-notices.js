import {readdir,lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AI_RUNTIME_ROOT} from './ai-runtime.js';
import {httpError} from './security.js';
// Only installed inference code notices, never model or data directories.
export async function aiNotices(root=AI_RUNTIME_ROOT){
 const files=[];let inspected=0;
 async function visit(parts,depth){
  const path=join(root,...parts),info=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!info||info.isSymbolicLink())return;
  if(info.isFile()){if(!/^(?:(?:[0-9]+|[a-f0-9]{16})-)?(?:LICENSE|LICENCE|COPYING|NOTICE|THIRD[-_]PARTY)(?:[._-].*)?$/i.test(parts.at(-1))&&parts.at(-1)!=='python-notices.json')return;if(info.size>2*1024*1024)return;const name=parts.join('/');files.push({id:createHash('sha256').update(name).digest('hex'),name,size:info.size,path});return;}
  if(!info.isDirectory()||depth>4)return;
  for(const entry of await readdir(path,{withFileTypes:true})){if(++inspected>5000)throw httpError(503,'実行ライブラリーの文書が多すぎます。管理者に確認してください。');if(entry.isSymbolicLink())continue;await visit([...parts,entry.name],depth+1);}
 }
 for(const engine of ['llama-cpu','llama-vulkan','whisper','whisper-vulkan']){const info=await lstat(join(root,engine)).catch(()=>null);if(!info?.isDirectory()||info.isSymbolicLink())continue;await visit([engine,'LICENSE.runtime'],0);await visit([engine,'notices'],0);}
 await visit(['notices'],0);
 return files;
}
export function registerAiNotices(app,auth){
 app.get('/api/v1/ai/notices',auth,async()=>({documents:(await aiNotices()).map(({path,...publicFile})=>publicFile)}));
 app.get('/api/v1/ai/notices/:id',auth,async(req,reply)=>{
  if(!/^[0-9a-f]{64}$/.test(req.params.id))throw httpError(404,'文書が見つかりません。');
  const file=(await aiNotices()).find(f=>f.id===req.params.id);if(!file)throw httpError(404,'文書が見つかりません。');
  return {text:await readFile(file.path,'utf8')};
 });
}
