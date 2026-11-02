import {createReadStream} from 'node:fs';
import {createGunzip} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

export async function verifyServerArchive(archive,folder){
  if(!/^mirea-\d+\.\d+\.\d+(?:beta(?:\.\d+)?)?-server$/.test(folder))throw new Error('Invalid release root');
  let buffer=Buffer.alloc(0),remaining=0,padding=0,pax=null,paxBytes=[],type='',ended=false,total=0,count=0;
  const names=new Set();
  const safe=name=>{if(!name||name.includes('\\')||name.includes(':')||/[\x00-\x1f]/.test(name)||name.startsWith('/')||name.replace(/\/$/,'').split('/').some(p=>!p||p==='..'||p==='.'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))||!(name===folder||name===folder+'/'||name.startsWith(folder+'/')))throw new Error('Unsafe archive member');};
  function parsePax(bytes){const text=bytes.toString('utf8'),result={};let pos=0;
    while(pos<Buffer.byteLength(text)){const rest=bytes.subarray(pos),space=rest.indexOf(32),length=Number(rest.subarray(0,space).toString());if(space<1||!Number.isSafeInteger(length)||length<=space+2||length>rest.length||rest[length-1]!==10)throw new Error('Invalid PAX header');const entry=rest.subarray(space+1,length-1).toString(),equal=entry.indexOf('=');const key=entry.slice(0,equal);if(equal<1||!['path','size','mtime','atime','ctime','LIBARCHIVE.creationtime'].includes(key))throw new Error('Unsupported PAX attribute');result[key]=entry.slice(equal+1);pos+=length;}return result;}
  const source=createReadStream(archive),stream=source.pipe(createGunzip());source.on('error',error=>stream.destroy(error));
  try{for await(const chunk of stream){
    total+=chunk.length;if(total>1024**3)throw new Error('Unpacked archive exceeds limit');buffer=Buffer.concat([buffer,chunk]);
    while(buffer.length){
      if(remaining){const n=Math.min(remaining,buffer.length);if(type==='x')paxBytes.push(buffer.subarray(0,n));remaining-=n;buffer=buffer.subarray(n);if(remaining)break;if(type==='x')pax=parsePax(Buffer.concat(paxBytes));continue;}
      if(padding){const n=Math.min(padding,buffer.length);padding-=n;buffer=buffer.subarray(n);if(padding)break;continue;}
      if(buffer.length<512)break;
      const header=buffer.subarray(0,512);buffer=buffer.subarray(512);
      if(header.every(byte=>byte===0)){ended=true;continue;}
      if(ended)throw new Error('Nonzero data after tar terminator');
      const text=(start,length)=>header.subarray(start,start+length).toString('utf8').split('\0')[0];
      const checksum=Number.parseInt(text(148,8).trim(),8),sum=[...header].reduce((s,b,i)=>s+(i>=148&&i<156?32:b),0);if(sum!==checksum)throw new Error('Tar checksum mismatch');
      if(header[124]&128)throw new Error('Binary tar sizes are not supported in server packages');
      type=text(156,1)||'0';let size=Number.parseInt(text(124,12).trim()||'0',8);
      if(!['0','5','x'].includes(type))throw new Error('Archive links and special files are forbidden');
      if(type==='x'){if(size>65536)throw new Error('PAX header too large');paxBytes=[];}
      else{
        let name=(text(345,155)?text(345,155)+'/':'')+text(0,100);if(pax?.path)name=pax.path;if(pax?.size)size=Number(pax.size);pax=null;
        safe(name);name=name.toLowerCase();if(names.has(name.replace(/\/$/,'')))throw new Error('Duplicate archive member');names.add(name.replace(/\/$/,''));
        if(++count>20000||type==='5'&&size!==0)throw new Error('Invalid archive entry');
      }
      if(!Number.isSafeInteger(size)||size<0||size>1024**3)throw new Error('Invalid tar size');remaining=size;padding=(512-size%512)%512;
    }
  }}finally{source.destroy();}
  if(remaining||padding||!ended||buffer.some(b=>b!==0)||!names.has(folder+'/package.json')||!names.has(folder+'/release-manifest.json'))throw new Error('Incomplete server archive');
  return {safe:true,files:count,uncompressedBytes:total};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await verifyServerArchive(...process.argv.slice(2))));
