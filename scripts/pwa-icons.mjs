// Rasterize the approved vector brand; never fetch artwork or include user data.
import sharp from 'sharp';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function buildPwaIcons({source='web/public/brand/orbit-icon.svg',destination='dist/pwa'}={}){
  await mkdir(destination,{recursive:true});
  const svg=await readFile(source);
  for(const size of [192,512])await sharp(svg).resize(size,size).png().toFile(join(destination,`icon-${size}.png`));
  // Full-bleed solid tile and centered existing mark fit the maskable safe zone.
  for(const [name,size]of [['maskable-512.png',512],['apple-touch-icon.png',180]])await sharp(svg).resize(size,size).flatten({background:'#4026df'}).png().toFile(join(destination,name));
}
