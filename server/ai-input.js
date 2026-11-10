import {stat,lstat,readFile,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {aiHash,normalizeAiText} from './ai-validation.js';
import {IMAGE_BOOK_MIME,imageExtension,ffmpegPath} from './media.js';
import {EPUB_MIME} from './ebook-types.js';
import {selectVideoSource} from './media-source.js';
import {waitForMediaWorker} from './media-worker-lifecycle.js';
import {runAiProcess} from './ai-runtime.js';
import {AI_OCR_OUTPUT,AI_TAG_OUTPUT,aiChapterOutput,ocrBox} from './ai-output.js';

const timed=mime=>mime.startsWith('audio/')||mime.startsWith('video/');
export function aiFeatureApplies(feature,mime) {
  if(['tags','embedding'].includes(feature))return true;
  if(feature==='ocr')return mime===IMAGE_BOOK_MIME||mime===EPUB_MIME||mime==='application/pdf';
  if(feature==='structure')return mime.startsWith('audio/');
  if(feature==='chapters')return mime.startsWith('video/');
  return feature==='transcript'&&timed(mime);
}
export async function resolveAiInput(context,item) {
  const {db,uploadDir,booksDir,originalDir}=context;
  let path=join(uploadDir,item.id),files=[];
  if(item.mime_type===IMAGE_BOOK_MIME) {
    files=db.prepare('SELECT * FROM image_pages WHERE item_id=? ORDER BY page_number').all(item.id)
      .map(row=>({...row,path:join(booksDir,item.id,row.page_number+'.'+imageExtension(row.mime_type))}));
  } else if(item.mime_type===EPUB_MIME)path=join(booksDir,item.id,'book.json');
  else if(item.mime_type.startsWith('video/')){const raw=join(originalDir,item.id),info=await lstat(raw).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});path=info?.isFile()&&!info.isSymbolicLink()?raw:(await selectVideoSource({...context,item})).path;}
  else if(item.mime_type.startsWith('audio/')) {
    const raw=join(originalDir,item.id),info=await lstat(raw).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(info?.isFile()&&!info.isSymbolicLink())path=raw;
  }
  const identities=[];
  for(const file of files.length?files:[{path}]) {
    const info=await lstat(file.path);
    if(!info.isFile()||info.isSymbolicLink())throw Object.assign(Error('AI input unavailable'),{code:'AI_INPUT_UNAVAILABLE'});
    identities.push([file.path,info.size,info.mtimeMs]);
  }
  const media=db.prepare('SELECT metadata_json FROM media_ingest WHERE asset_id=?').get(item.id);
  const audio=db.prepare('SELECT metadata_json FROM audio_assets WHERE item_id=?').get(item.id);
  const video=db.prepare('SELECT metadata_json FROM video_assets WHERE item_id=?').get(item.id);
  const durationMs=Math.round(Number(JSON.parse(media?.metadata_json??audio?.metadata_json??video?.metadata_json??'{}').duration??0)*1000);
  let book;
  if(item.mime_type===EPUB_MIME)book=JSON.parse(await readFile(path,'utf8'));
  return {path,files,book,durationMs,pageCount:item.page_count,stamp:aiHash(identities)};
}
export function aiUnitCount(feature,input,item,documents=[]) {
  if(feature==='embedding')return documents.length;
  if(feature==='structure')return 1;
  if(feature==='ocr'||feature==='tags'&&!timed(item.mime_type))
    return input.book?.chapters.length??Math.max(1,item.page_count);
  return Math.max(1,Math.ceil(input.durationMs/90000));
}
function chapterBlocks(chapter,index) {
  const blocks=[];
  function visit(nodes,path='',anchor='') {
    for(const [number,node]of nodes.entries()) {
      const element=path?path+'.'+number:String(number),id=node.id??anchor;
      if(typeof node.text==='string'&&node.text.trim())for(let offset=0;offset<node.text.length;offset+=1800){blocks.push({id:'c'+index+':'+aiHash({element,offset,text:normalizeAiText(node.text.slice(offset,offset+1800))}).slice(0,24),chapter:index,element:'node:'+element,textOffset:offset,text:node.text.slice(offset,offset+1800),kind:'text'});}
      if(node.children)visit(node.children,element,id);
    }
  }
  visit(chapter.children);return blocks;
}
async function renderPage(source,destination,page,mode,signal) {
  const url=new URL('./ai-page-worker.js',import.meta.url);
  const worker=new Worker(url,{workerData:{source,destination,page,mode},resourceLimits:{maxOldGenerationSizeMb:512}});
  const result=await waitForMediaWorker(worker,{signal,timeoutMs:180000});
  if(result.error)throw Object.assign(Error('Page preparation failed'),{code:result.code});
  return result;
}
export async function analyzeAiUnit({context,item,input,feature,unit,folder,model,runtime,store,signal,document}) {
  await mkdir(folder,{recursive:true,mode:0o700});
  const empty={tags:[],blocks:[],segments:[],summary:''};
  if(feature==='embedding') {
    document=document&&context.db.prepare('SELECT * FROM ai_documents WHERE id=? AND asset_id=?').get(document.id,item.id);
    if(!document)return {...empty,vector:null};
    const [vector]=await runtime.embed(model,[document.text.slice(0,1800)],{signal});
    return {...empty,vector,documentId:document.id,documentRevision:document.revision,documentText:document.text};
  }
  let images=[],imageHashes=new Set(),nativeBlocks=[],pageTiles=[],hasPageImages=false,description='',frameTimes=[],startMs=unit*90000;
  if(input.book) {
    nativeBlocks=chapterBlocks(input.book.chapters[unit],unit);
    description=nativeBlocks.map(b=>b.text).join('\n').slice(0,24000);
  }else if(!timed(item.mime_type)) {
    const page=unit+1,source=input.files[unit]?.path??input.path;
    const prepared=await renderPage(source,join(folder,'page.png'),page,item.mime_type==='application/pdf'?'pdf':'image',signal);
    nativeBlocks=prepared.blocks;images=[prepared.image];pageTiles=prepared.tiles??[];hasPageImages=prepared.hasImages;
    description=nativeBlocks.map(b=>b.text).join('\n').slice(0,24000);
  }
  const startSeconds=startMs/1000,seconds=Math.min(90,Math.max(0,(input.durationMs-startMs)/1000));
  const extract=async args=>{
    await runAiProcess(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y',
      '-threads','1','-protocol_whitelist','file,pipe','-ss',String(startSeconds),'-i',input.path,
      '-t',String(seconds||90),...args],{signal,maxOutput:65536});
  };
  if(feature==='transcript') {
    const wav=join(folder,'audio.wav');
    await extract(['-vn','-ac','1','-ar','16000','-f','wav',wav]);
    const segments=await runtime.transcribe(model,wav,{signal,folder});
    return {...empty,segments:segments.filter(s=>s.text).map((s,index)=>({...s,id:'t'+unit+':'+aiHash({text:normalizeAiText(s.text),start:Math.round(s.startMs/1000)}).slice(0,20),
      startMs:s.startMs+startMs,endMs:Math.min(input.durationMs,s.endMs+startMs)}))};
  }
  if(feature==='structure') {
    const normalized=join(folder,'music.wav');await runAiProcess(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-protocol_whitelist','file,pipe','-i',input.path,'-vn','-ac','2','-ar','44100','-c:a','pcm_f32le','-rf64','auto',normalized],{signal,maxOutput:65536});
    const music=await runtime.structure(model,normalized,{signal,folder});
    const labels={intro:'イントロ',verse:'Aメロ',chorus:'サビ',bridge:'ブリッジ',inst:'間奏',break:'ブレイク',solo:'ソロ',outro:'アウトロ',start:'開始',end:'終了'};
    return {...empty,summary:Number.isFinite(music.bpm)&&music.bpm>0?'テンポの目安: '+Math.round(music.bpm)+' BPM':'',
      segments:(music.segments??[]).filter(s=>s.end>s.start).map((s,index)=>({
        id:'music:'+aiHash({start:Math.round(s.start),label:s.label}).slice(0,20),startMs:Math.max(0,Math.round(s.start*1000)),
        endMs:Math.min(input.durationMs,Math.round(s.end*1000)),
        label:labels[s.label]??s.label??'区間',kind:s.label??'section',text:''}))};
  }
  if(item.mime_type.startsWith('video/')) {
    const log=await runAiProcess(ffmpegPath(),['-hide_banner','-loglevel','info','-nostdin','-threads','1','-protocol_whitelist','file,pipe','-ss',String(startSeconds),'-i',input.path,'-t',String(seconds),'-an','-sn','-vf',"select='gt(scene,0.30)',showinfo",'-f','null','-'],{signal,maxOutput:65536,captureStderr:true});
    const cuts=[...log.matchAll(/pts_time:([\d.]+)/g)].map(m=>Number(m[1])).filter(t=>t>0&&t<seconds);
    const selected=[0,...cuts.map(t=>Math.min(seconds-.05,t+.05)),Math.max(0,seconds-.05)];
    for(let i=1;selected.length<6&&i<6;i++)selected.push(seconds*i/6);
    const positions=[...new Set(selected.map(t=>Math.round(t*100)/100))].sort((a,b)=>a-b);
    const samples=positions.length<=6?positions:Array.from({length:6},(_,i)=>positions[Math.round(i*(positions.length-1)/5)]);
    for(const [index,position]of samples.entries()){const image=join(folder,'frame-'+index+'.png');await runAiProcess(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-protocol_whitelist','file,pipe','-ss',String(startSeconds+position),'-i',input.path,'-an','-sn','-frames:v','1','-vf',"scale=w='min(iw,960)':h='min(ih,960)':force_original_aspect_ratio=decrease",'-threads','1',image],{signal,maxOutput:65536});if(await lstat(image).catch(()=>null)){const hash=createHash('sha256').update(await readFile(image)).digest('hex');if(!imageHashes.has(hash)){imageHashes.add(hash);images.push(image);frameTimes.push(startMs+Math.round(position*1000));}}}
  }
  if(timed(item.mime_type)) {
    const transcript=store.read(item.id,'transcript',{offset:unit,limit:1})?.result;
    description=JSON.stringify({speech:transcript?.segments.filter(s=>s.endMs>startMs&&s.startMs<startMs+90000)??[],
      music:store.read(item.id,'structure')?.result??null});
  }
  if(feature==='ocr') {
    if(input.book||!hasPageImages&&nativeBlocks.length)return {...empty,blocks:nativeBlocks};
    const blocks=[...nativeBlocks],tiles=pageTiles.length?pageTiles:[{image:images[0],box:[0,0,1,1]}];
    for(const [tileIndex,tile]of tiles.entries()){
      const value=await runtime.generate(model,{images:[tile.image],signal,schema:AI_OCR_OUTPUT,text:'Read each text region once, in reading order, including vertical Japanese and speech balloons. Return blocks with original text, kind, and bbox [left, top, right, bottom] using integers 0..1000 relative to this image. Do not repeat any region. Do not translate or invent text. Omit unreadable symbols. Use an empty blocks array for an image without readable text.'});
      for(const [index,block]of (value.blocks??[]).entries()){
        const mapped=ocrBox(block.bbox,tile.box);
        if(blocks.some(prior=>prior.text===block.text&&prior.box&&Math.abs(prior.box[0]-mapped[0])<.04&&Math.abs(prior.box[1]-mapped[1])<.04))continue;
        blocks.push({...block,box:mapped,id:'p'+(unit+1)+':'+aiHash({text:normalizeAiText(block.text??''),box:mapped.map(n=>Math.round(n*1000))}).slice(0,20),page:unit+1});
      }
    }
    return {...empty,blocks};
  }
  if(feature==='tags') {
    const value=await runtime.generate(model,{images,signal,schema:AI_TAG_OUTPUT,text:
      'Tag the provided media content using concise Japanese labels. Return {"tags":[{"label":"tag","category":"genre or topic or mood or language"}],"summary":"brief factual description"}. Use only supported content. Do not identify real people or infer sensitive personal attributes. Maximum 12 tags. Extracted content: '+description});
    return {...empty,tags:value.tags??[],summary:value.summary??''};
  }
  if(feature==='chapters') {
    const value=await runtime.generate(model,{images,signal,schema:aiChapterOutput(startMs,Math.min(input.durationMs,startMs+90000)),text:
      'Identify meaningful video chapters within the supplied interval. Return {"segments":[{"startMs":integer,"endMs":integer,"label":"concise Japanese title","text":"factual summary"}]}. Use absolute media milliseconds. Interval: '+startMs+'..'+Math.min(input.durationMs,startMs+90000)+'. Images correspond to these absolute millisecond positions: '+JSON.stringify(frameTimes)+'. Use visual scene changes and speech topics together, not fixed-duration chapters. Speech: '+description});
    return {...empty,segments:(value.segments??[]).map((segment,index)=>({...segment,id:'chapter'+unit+':'+aiHash({start:Math.round(segment.startMs/1000),label:segment.label}).slice(0,20),kind:'chapter'}))};
  }
  throw Object.assign(Error('Unsupported AI feature'),{code:'AI_FEATURE_UNAVAILABLE'});
}
