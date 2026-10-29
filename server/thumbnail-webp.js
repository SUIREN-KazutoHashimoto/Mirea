import sharp from 'sharp';
import {stat,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {retryJpegEndMarker} from './jpeg-end-marker.js';
sharp.cache(false);
const pending=new Map();
// Keep the source image. Replace only our derived WebP, after a complete write.
export async function thumbnailWebp(source,{destination=source.replace(/\.jpg$/,'.webp'),force=false}={}){
  if(destination===source)throw Error('Thumbnail output must not replace its source');
  const info=await stat(source);
  const cached=await stat(destination).catch(()=>null);if(!force&&cached?.mtimeMs>=info.mtimeMs&&cached.size)return destination;
  const key=source+'|'+destination;
  if(!pending.has(key)){
    const temporary=destination+'.'+randomUUID()+'.part';
    const work=(async()=>{try{
      const options={limitInputPixels:false,failOn:'warning'};
      const convert=path=>sharp(path,options).rotate().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toFile(temporary);
      try{await convert(source);}catch(error){const metadata=await sharp(source,options).metadata().catch(()=>null);await retryJpegEndMarker(source,error,metadata,options,convert);}
      await rename(temporary,destination);return destination;
    }finally{await unlink(temporary).catch(()=>{});pending.delete(key);}})();pending.set(key,work);
  }
  return pending.get(key);
}
