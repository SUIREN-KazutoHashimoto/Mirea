export const DOWNLOAD_PATH='/__mirea_download__/';
export const chunkKey=(id,file,part)=>`${id}|${file}|${part}`;
export function validateManifest(manifest){
  if(manifest?.version!==1 || manifest.algorithm!=='AES-256-GCM' || manifest.chunkSize!==1048576 || !/^[0-9a-f-]{36}$/.test(manifest.id) || !/^[0-9a-f-]{36}$/.test(manifest.assetId) || !['video','pdf','image-book'].includes(manifest.kind) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length>500)throw new Error('ダウンロード情報が不正です。');
  if(!Number.isSafeInteger(manifest.pageCount) || manifest.pageCount<1 || manifest.pageCount>1000000 || manifest.kind==='image-book' && manifest.files.length!==manifest.pageCount || manifest.kind!=='image-book' && manifest.files.length!==1)throw new Error('ページ情報が不正です。');
  let total=0;
  for(const [index,file] of manifest.files.entries()){
    if(file.index!==index || !Number.isSafeInteger(file.size) || file.size<=0 || file.size>2147483648 || file.chunks!==Math.ceil(file.size/manifest.chunkSize) || !['video/mp4','video/webm','application/pdf','image/png','image/jpeg','image/webp'].includes(file.mime))throw new Error('ダウンロード情報が不正です。');
    total+=file.size;
  }
  if(total>2147483648)throw new Error('ダウンロード容量の上限を超えています。');
  return manifest;
}
export async function importDownloadKey(base64,cryptoApi=globalThis.crypto){
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
  if(bytes.length!==32)throw new Error('復号鍵が不正です。');
  try{return await cryptoApi.subtle.importKey('raw',bytes,'AES-GCM',false,['decrypt']);}finally{bytes.fill(0);}
}
export async function decryptDownloadChunk(key,manifest,fileIndex,part,encrypted,cryptoApi=globalThis.crypto){
  const file=manifest.files[fileIndex],length=Math.min(manifest.chunkSize,file.size-part*manifest.chunkSize),bytes=new Uint8Array(encrypted);
  if(part<0 || part>=file.chunks || bytes.byteLength!==length+28)throw new Error('ダウンロードした分割データが不足しています。');
  const additionalData=new TextEncoder().encode(`mirea-download-v1|${manifest.id}|${fileIndex}|${part}|${length}`);
  return new Uint8Array(await cryptoApi.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12),additionalData,tagLength:128},key,bytes.subarray(12)));
}
export async function ciphertextHash(bytes,cryptoApi=globalThis.crypto){return [...new Uint8Array(await cryptoApi.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export function downloadRange(header,size){
  if(!header)return {start:0,end:size-1,partial:false};
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!match || (!match[1]&&!match[2]))throw new Error('Range');
  let start,end;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)throw new Error('Range');start=Math.max(0,size-suffix);end=size-1;}
  else{start=Number(match[1]);end=match[2]?Number(match[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)throw new Error('Range');end=Math.min(end,size-1);}
  return {start,end,partial:true};
}
// A Range response decrypts one small chunk per pull, never the whole video.
export function encryptedRangeResponse(request,grant,fileIndex,readChunk,{now=Date.now,revoked=()=>false,cryptoApi=globalThis.crypto}={}){
  const manifest=validateManifest(grant.manifest),file=manifest.files[fileIndex];
  if(!file || revoked() || grant.expiresAt<=now())return new Response('オンラインで開き直してください。',{status:403});
  let range;try{range=downloadRange(request.headers.get('range'),file.size);}catch{return new Response(null,{status:416,headers:{'Content-Range':`bytes */${file.size}`,'Cache-Control':'no-store'}});}
  const {start,end,partial}=range;
  const headers={'Content-Type':file.mime,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"};
  if(partial)headers['Content-Range']=`bytes ${start}-${end}/${file.size}`;
  if(request.method==='HEAD')return new Response(null,{status:partial?206:200,headers});
  let offset=start,cancelled=false;
  const body=new ReadableStream({
    async pull(controller){
      try{
        if(cancelled || revoked() || grant.expiresAt<=now() || request.signal.aborted)throw new Error('閲覧セッションは終了しました。');
        const part=Math.floor(offset/manifest.chunkSize),record=await readChunk(manifest.id,fileIndex,part);
        if(!record)throw new Error('保存データが不足しています。再ダウンロードしてください。');
        const plain=await decryptDownloadChunk(grant.key,manifest,fileIndex,part,record.bytes,cryptoApi);
        try{
          if(cancelled || revoked())throw new Error('閲覧セッションは終了しました。');
          const from=offset-part*manifest.chunkSize,to=Math.min(plain.length,end-part*manifest.chunkSize+1);
          const output=plain.slice(from,to);offset+=output.length;controller.enqueue(output);
        }finally{plain.fill(0);}
        if(offset>end)controller.close();
      }catch(error){controller.error(error);}
    },cancel(){cancelled=true;}
  },{highWaterMark:0});
  return new Response(body,{status:partial?206:200,headers});
}
