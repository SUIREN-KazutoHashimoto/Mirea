import { randomBytes,randomUUID,createCipheriv,hkdfSync,createHash } from 'node:crypto';
import { mkdir,readFile,writeFile,stat,open } from 'node:fs/promises';
import { join } from 'node:path';
import { httpError } from './security.js';
import { IMAGE_BOOK_MIME,imageExtension } from './media.js';
import { EPUB_MIME, EPUB_BUNDLE_MIME } from './ebook-types.js';
import { isAudio } from './audio-types.js';
import { videoMetadata,videoFolder } from './video-stream.js';

const CHUNK=1024*1024;
const aad=(id,file,part,length)=>Buffer.from(`mirea-download-v1|${id}|${file}|${part}|${length}`);
export async function registerDownloads(app,{db,dataDir,uploadDir,booksDir,videoDir,authenticate,findItem,options}){
  let master=options.downloadMasterKey;
  if(!master){
    const folder=join(dataDir,'keys'),path=join(folder,'download-master.key');
    await mkdir(folder,{recursive:true,mode:0o700});
    try{master=await readFile(path);}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      if(db.prepare('SELECT COUNT(*) n FROM encrypted_downloads').get().n)throw new Error('Download master key is missing. Restore DATA_DIR/keys/download-master.key from backup.');
      const generated=randomBytes(32);
      try{await writeFile(path,generated,{flag:'wx',mode:0o600});master=generated;}
      catch(error){if(error.code!=='EEXIST')throw error;master=await readFile(path);}
    }
  }
  if(!Buffer.isBuffer(master) || master.length!==32)throw new Error('Invalid download master key (expected 32 bytes)');
  const keyFor=row=>Buffer.from(hkdfSync('sha256',master,Buffer.from(row.id),Buffer.from(`mirea-download-v1|${row.user_id}|${row.asset_id}`),32));
  const auth={onRequest:async req=>authenticate(req)};
  let activeTransfers=0;const perUser=new Map();
  const transferAuth=async(req,reply)=>{
    authenticate(req);const user=req.user.id;
    if(activeTransfers>=8 || (perUser.get(user)??0)>=2){reply.header('Retry-After','1');throw httpError(429,'ダウンロードが混雑しています。少し待って再試行してください。');}
    activeTransfers++;perUser.set(user,(perUser.get(user)??0)+1);let released=false;
    const release=()=>{if(released)return;released=true;activeTransfers--;const n=perUser.get(user)-1;if(n)perUser.set(user,n);else perUser.delete(user);};
    reply.raw.once('finish',release);reply.raw.once('close',release);
    reply.raw.setTimeout?.(60000,()=>reply.raw.destroy());
  };
  const limit={rateLimit:options.rateLimit===false?false:{hook:'preHandler',max:180,timeWindow:'1 minute',keyGenerator:req=>req.user.id}};
  const get=db.prepare('SELECT * FROM encrypted_downloads WHERE id=? AND user_id=?');
  function authorize(req){
    const row=get.get(req.params.id,req.user.id);
    if(!row)throw httpError(404,'ダウンロードが見つかりません。');
    return {row,item:findItem(row.asset_id,req.user.id)};
  }
  function source(item,file){
    if(file.quality){
      const metadata=videoMetadata(db,item.id,file.generation??'base');
      if(!metadata?.renditions.some(r=>r.quality===file.quality))throw httpError(409,'選択した画質のデータがありません。');
      return join(videoFolder(videoDir,item.id,metadata),`${file.quality}.mp4`);
    }
    return item.mime_type===EPUB_MIME?join(booksDir,item.id,'book.json'):item.mime_type===IMAGE_BOOK_MIME?join(booksDir,item.id,`${file.number}.${imageExtension(file.mime)}`):join(uploadDir,item.id);
  }
  async function manifestFor(item,quality,generation){
    const files=item.mime_type===IMAGE_BOOK_MIME?db.prepare('SELECT page_number AS number,size,mime_type AS mime,width,height FROM image_pages WHERE item_id=? ORDER BY page_number').all(item.id):[{number:1,size:item.size,mime:item.mime_type}];
    const video=videoMetadata(db,item.id,generation);
    if(video){
      const rendition=quality?video.renditions.find(r=>r.quality===quality):video.renditions[0];
      if(!rendition)throw httpError(400,'生成済みの画質を選択してください。');
      Object.assign(files[0],{size:rendition.size,mime:'video/mp4',quality:rendition.quality});
      if(video.generation)files[0].generation=video.generation;
    }else if(quality)throw httpError(400,'このアセットは画質を選択できません。');
    if(item.mime_type===EPUB_MIME){files[0].size=(await stat(source(item,files[0])).catch(()=>{throw httpError(404,'EPUBの閲覧データが見つかりません。');})).size;files[0].mime=EPUB_BUNDLE_MIME;}
    if(!files.length)throw httpError(404,'原本が見つかりません。');
    for(const [index,file] of files.entries()){
      const info=await stat(source(item,file)).catch(()=>{throw httpError(404,'原本が見つかりません。');});
      if(!info.isFile() || info.size!==file.size)throw httpError(409,'原本のサイズが変更されています。');
      Object.assign(file,{index,chunks:Math.ceil(file.size/CHUNK),stamp:info.mtimeMs});
    }
    return {version:1,algorithm:'AES-256-GCM',chunkSize:CHUNK,assetId:item.id,title:item.title,kind:item.mime_type===IMAGE_BOOK_MIME?'image-book':item.mime_type===EPUB_MIME?'epub':item.mime_type==='application/pdf'?'pdf':isAudio(item.mime_type)?'audio':'video',pageCount:item.page_count,files};
  }
  const publicManifest=(row,manifest)=>({...manifest,id:row.id,files:manifest.files.map(({stamp,...file})=>file)});
  async function validateSource(row,item){
    const old=JSON.parse(row.manifest_json),current=await manifestFor(item,old.files[0].quality,old.files[0].quality?(old.files[0].generation??'base'):undefined);
    if(JSON.stringify(old)!==JSON.stringify(current))throw httpError(409,'原本が変更されました。暗号化ダウンロードを作り直してください。');
    return old;
  }
  app.post('/api/v1/items/:id/download',{...auth,config:limit},async req=>{
    if(req.body!==undefined&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).some(k=>k!=='quality')||req.body.quality!==undefined&&!/^[0-9]{2,4}p$/.test(req.body.quality)))throw httpError(400,'画質の指定が不正です。');
    const item=findItem(req.params.id,req.user.id),manifest=await manifestFor(item,req.body?.quality);
    authenticate(req);findItem(item.id,req.user.id);
    let row=db.prepare("SELECT * FROM encrypted_downloads WHERE user_id=? AND asset_id=? AND json_extract(manifest_json,'$.files[0].quality') IS ?").get(req.user.id,item.id,manifest.files[0].quality??null);
    if(row && row.manifest_json!==JSON.stringify(manifest)){db.prepare('DELETE FROM encrypted_downloads WHERE id=?').run(row.id);row=null;}
    if(!row){
      row={id:randomUUID(),user_id:req.user.id,asset_id:item.id,manifest_json:JSON.stringify(manifest),created_at:Date.now()};
      db.prepare('INSERT INTO encrypted_downloads VALUES(?,?,?,?,?)').run(row.id,row.user_id,row.asset_id,row.manifest_json,row.created_at);
    }
    return {manifest:publicManifest(row,manifest)}; // No content key during download.
  });
  app.post('/api/v1/downloads/:id/open',{...auth,config:limit},async req=>{
    const {row,item}=authorize(req),manifest=await validateSource(row,item);
    authenticate(req);authorize(req);
    const key=keyFor(row);
    try{return {manifest:publicManifest(row,manifest),key:key.toString('base64'),expiresAt:req.session.expires_at};}finally{key.fill(0);}
  });
  app.get('/api/v1/downloads/:id/files/:file/parts/:part',{onRequest:transferAuth,config:{rateLimit:options.rateLimit===false?false:{hook:'preHandler',max:600,timeWindow:'1 minute',keyGenerator:req=>req.user.id}}},async(req,reply)=>{
    const {row,item}=authorize(req),manifest=JSON.parse(row.manifest_json);
    if(!/^\d{1,5}$/.test(req.params.file) || !/^\d{1,6}$/.test(req.params.part))throw httpError(404,'分割データが見つかりません。');
    const index=Number(req.params.file),part=Number(req.params.part),file=manifest.files[index];
    if(!file || part>=file.chunks)throw httpError(404,'分割データが見つかりません。');
    const handle=await open(source(item,file),'r').catch(()=>{throw httpError(404,'原本が見つかりません。');});
    let plain;
    try{
      const info=await handle.stat();
      if(info.size!==file.size || info.mtimeMs!==file.stamp)throw httpError(409,'原本が変更されました。ダウンロードを作り直してください。');
      const length=Math.min(CHUNK,file.size-part*CHUNK);plain=Buffer.alloc(length);
      let received=0;
      while(received<length){const {bytesRead}=await handle.read(plain,received,length-received,part*CHUNK+received);if(!bytesRead)throw httpError(409,'原本を読み切れませんでした。');received+=bytesRead;}
    }finally{await handle.close();}
    authenticate(req);authorize(req);
    const iv=randomBytes(12),key=keyFor(row),cipher=createCipheriv('aes-256-gcm',key,iv);
    try{
      cipher.setAAD(aad(row.id,index,part,plain.length));
      const bytes=Buffer.concat([iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
      return reply.type('application/octet-stream').header('X-Chunk-SHA256',createHash('sha256').update(bytes).digest('hex')).header('Content-Length',bytes.length).send(bytes);
    }finally{key.fill(0);plain.fill(0);}
  });
}
