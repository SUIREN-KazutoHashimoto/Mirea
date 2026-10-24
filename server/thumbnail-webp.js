import sharp from 'sharp';
import {stat,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
sharp.cache(false);
const pending=new Map();
// Keep the source image. Replace only our derived WebP, after a complete write.
export async function thumbnailWebp(source){
  const destination=source.replace(/\.jpg$/,'.webp'),info=await stat(source);
  const cached=await stat(destination).catch(()=>null);if(cached?.mtimeMs>=info.mtimeMs&&cached.size)return destination;
  if(!pending.has(source)){
    const temporary=destination+'.'+randomUUID()+'.part';
    const work=(async()=>{try{
      await sharp(source,{limitInputPixels:40000000}).rotate().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toFile(temporary);
      await rename(temporary,destination);return destination;
    }finally{await unlink(temporary).catch(()=>{});pending.delete(source);}})();pending.set(source,work);
  }
  return pending.get(source);
}
