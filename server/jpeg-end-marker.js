import {constants} from 'node:fs';
import {mkdtemp,open,copyFile,appendFile,rm} from 'node:fs/promises';
import {join,dirname,resolve,sep} from 'node:path';
import {validateImagePixels} from './image-integrity.js';

// Some viewers accept a JPEG whose pixels are complete but whose final EOI
// marker is missing. Repair only a temporary copy, then require a full strict
// decode. Missing scan/pixel data must still fail; never relax failOn.
export async function retryJpegEndMarker(source,error,metadata,options,work){
 if(metadata?.format!=='jpeg'||!/premature end of JPEG image/i.test(error?.message??''))throw error;
 const handle=await open(source,'r');
 try{
  const info=await handle.stat();if(info.size<4||info.size>100*1024*1024)throw error;
  const tail=Buffer.alloc(2);await handle.read(tail,0,2,info.size-2);if(tail[0]===0xff&&tail[1]===0xd9)throw error;
 }finally{await handle.close();}
 // Keep the copy under the original's protected storage root, including on
 // Windows where a shared system temp directory can have broader ACLs.
 const parent=dirname(resolve(source)),directory=await mkdtemp(join(parent,'.mirea-jpeg-eoi-')),temporary=join(directory,'image.jpg');
 try{
  await copyFile(source,temporary,constants.COPYFILE_EXCL);await appendFile(temporary,Buffer.from([0xff,0xd9]));
  // Preserve the actual validation cause, including storage failures.
  await validateImagePixels(temporary,options);
  return await work(temporary);
 }finally{
  if(dirname(resolve(directory))!==parent||!resolve(directory).startsWith(parent+sep+'.mirea-jpeg-eoi-'))throw Error('Unsafe JPEG scratch cleanup');
  await rm(directory,{recursive:true,force:true});
 }
}
