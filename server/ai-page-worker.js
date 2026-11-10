import {parentPort,workerData} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {aiHash,normalizeAiText} from './ai-validation.js';
sharp.cache(false);sharp.concurrency(1);
const {source,destination,page=1,mode}=workerData;
try {
  let result={};
  if(mode==='pdf'){
    const {createCanvas,DOMMatrix,ImageData,Path2D}=await import('@napi-rs/canvas');
    Object.assign(globalThis,{DOMMatrix,ImageData,Path2D});
    const {getDocument,OPS}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const require=createRequire(import.meta.url),root=dirname(require.resolve('pdfjs-dist/package.json'));
    const directory=name=>join(root,name).replaceAll('\\','/')+'/';
    const task=getDocument({url:pathToFileURL(source).href,cMapUrl:directory('cmaps'),cMapPacked:true,
      standardFontDataUrl:directory('standard_fonts'),wasmUrl:directory('wasm'),
      isEvalSupported:false,useSystemFonts:true,maxImageSize:-1,disableAutoFetch:true,disableStream:true});
    try {
      const document=await task.promise,sheet=await document.getPage(page),view=sheet.getViewport({scale:1});
      const text=await sheet.getTextContent(),operators=await sheet.getOperatorList(),hasImages=operators.fnArray.some(op=>[OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject].includes(op));
      const blocks=text.items.filter(item=>typeof item.str==='string'&&item.str.trim()).map((item,index)=>{
        const [x,y]=view.convertToViewportPoint(item.transform[4],item.transform[5]);
        const width=Math.min(1,Math.max(.001,item.width/view.width)),height=Math.min(1,Math.max(.001,item.height/view.height));
        return {id:'p'+page+'t'+aiHash({text:normalizeAiText(item.str),x:Math.round(x),y:Math.round(y)}).slice(0,20),page,text:item.str,kind:'text',order:index,
          box:[Math.min(1-width,Math.max(0,x/view.width)),Math.min(1-height,Math.max(0,y/view.height-height)),width,height]};
      });
      const viewport=sheet.getViewport({scale:hasImages?Math.min(4800/view.width,4800/view.height,4):Math.min(2400/view.width,2400/view.height,2)});
      const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
      await sheet.render({canvasContext:canvas.getContext('2d'),viewport,background:'#fff'}).promise;
      const encoded=canvas.toBuffer('image/png'),width=canvas.width,height=canvas.height;
      await sharp(encoded).resize({width:2800,height:2800,fit:'inside',withoutEnlargement:true}).png().toFile(destination);
      result={blocks,pageCount:document.numPages,image:destination,hasImages};
      if(hasImages&&Math.max(width,height)>2800){result.tiles=[];for(let top=0;top<height;top+=1472)for(let left=0;left<width;left+=1472){const w=Math.min(1600,width-left),h=Math.min(1600,height-top),path=destination+'.tile-'+left+'-'+top+'.png';await sharp(encoded).extract({left,top,width:w,height:h}).png().toFile(path);result.tiles.push({image:path,box:[left/width,top/height,w/width,h/height]});}}
    }finally{await task.destroy();}
  }else{
    const input=sharp(source,{limitInputPixels:false,failOn:'warning'}).rotate();
    const metadata=await input.metadata();
    await input.resize({width:2800,height:2800,fit:'inside',withoutEnlargement:true}).png().toFile(destination);
    result={blocks:[],image:destination,width:metadata.width,height:metadata.height,hasImages:true};
    const rotated=await sharp(source,{limitInputPixels:false}).rotate().metadata();
    const width=metadata.orientation>=5?rotated.height:rotated.width,height=metadata.orientation>=5?rotated.width:rotated.height;
    if(Math.max(width,height)>3000){result.tiles=[];const step=1472,size=1600;
      if(Math.ceil(width/step)*Math.ceil(height/step)>256)throw Object.assign(Error('Page needs a smaller analysis profile'),{code:'AI_INPUT_LIMIT'});
      for(let top=0;top<height;top+=step)for(let left=0;left<width;left+=step){const w=Math.min(size,width-left),h=Math.min(size,height-top),path=destination+'.tile-'+left+'-'+top+'.png';
        await sharp(source,{limitInputPixels:false}).rotate().extract({left,top,width:w,height:h}).png().toFile(path);result.tiles.push({image:path,box:[left/width,top/height,w/width,h/height]});}
    }
  }
  parentPort.postMessage(result);
}catch(error){parentPort.postMessage({error:true,code:error.code??'AI_PAGE_FAILED'});}
finally{parentPort.close();}
