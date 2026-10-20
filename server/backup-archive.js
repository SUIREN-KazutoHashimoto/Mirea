import {createCipheriv,createDecipheriv,randomBytes,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {createReadStream,createWriteStream} from 'node:fs';
import {open,stat,unlink,link} from 'node:fs/promises';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';

const derive=promisify(scrypt),MAGIC=Buffer.from('MIREABACKUP1\n');
const parameters={N:32768,r:8,p:1,maxmem:64*1024*1024};
function tarHeader(path,size,mtime){
  if(!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p=>p==='..'||p==='.') || Buffer.byteLength(path)>255)throw new Error('Unsafe archive path');
  const block=Buffer.alloc(512),parts=path.split('/');let name=parts.pop(),prefix=parts.join('/');
  while(Buffer.byteLength(prefix)>155&&parts.length){name=parts.pop()+'/'+name;prefix=parts.join('/');}
  if(Buffer.byteLength(name)>100||Buffer.byteLength(prefix)>155)throw new Error('Archive name exceeds ustar limits');
  block.write(name,0,100);block.write('0000600\0',100);block.write('0000000\0',108);block.write('0000000\0',116);
  if(size>0o77777777777){block.writeBigUInt64BE(BigInt(size),128);block[124]=0x80;}else block.write(size.toString(8).padStart(11,'0')+'\0',124);
  block.write(Math.floor(mtime/1000).toString(8).padStart(11,'0')+'\0',136);block.fill(32,148,156);block[156]=48;
  block.write('ustar\0',257);block.write('00',263);block.write(prefix,345,155);
  block.write([...block].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);return block;
}
export async function encryptBackup({files,destination,password,authorize=()=>{},progress=()=>{}}){
  const salt=randomBytes(16),iv=randomBytes(12),key=await derive(password,salt,32,parameters);
  const metadata=Buffer.from(JSON.stringify({version:1,cipher:'aes-256-gcm',kdf:'scrypt',N:parameters.N,r:8,p:1,salt:salt.toString('base64'),iv:iv.toString('base64'),archive:'tar.gz'}));
  const length=Buffer.alloc(4);length.writeUInt32BE(metadata.length);const prefix=Buffer.concat([MAGIC,length,metadata]);
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(prefix);
  let completed=0,total=files.reduce((n,f)=>n+f.size,0);
  const source=Readable.from((async function*(){
    for(const file of files){
      authorize();yield tarHeader(file.name,file.size,file.mtime??Date.now());
      let read=0;
      for await(const chunk of file.bytes?[file.bytes]:createReadStream(file.path,{highWaterMark:256*1024})){
        authorize();read+=chunk.length;completed+=chunk.length;if(read>file.size)throw new Error('Source changed during backup');yield chunk;progress({completed,total});
      }
      if(read!==file.size)throw new Error('Source changed during backup');
      if(file.size%512)yield Buffer.alloc(512-file.size%512);
    }yield Buffer.alloc(1024);
  })());
  let started=false;
  const envelope=new Transform({transform(chunk,_encoding,done){if(!started){this.push(prefix);started=true;}done(null,chunk);},flush(done){if(!started)this.push(prefix);this.push(cipher.getAuthTag());done();}});
  try{await pipeline(source,createGzip({level:1}),cipher,envelope,createWriteStream(destination,{flags:'wx',mode:0o600}));}
  finally{key.fill(0);}
}
// Offline utility: do not expose a server-side restore/decryption endpoint.
// The .partial file is never renamed to the requested output until GCM verifies.
export async function decryptBackup(source,destination,password){
  const handle=await open(source,'r');let key;
  const partial=destination+'.partial';let partialOwned=false;
  try{
    const info=await handle.stat(),head=Buffer.alloc(MAGIC.length+4);await handle.read(head,0,head.length,0);
    if(!head.subarray(0,MAGIC.length).equals(MAGIC))throw new Error('Not a Mirea backup');
    const size=head.readUInt32BE(MAGIC.length);if(size<1||size>2048||info.size<head.length+size+16)throw new Error('Invalid backup header');
    const metadata=Buffer.alloc(size);await handle.read(metadata,0,size,head.length);const config=JSON.parse(metadata);
    if(config.version!==1||config.cipher!=='aes-256-gcm'||config.kdf!=='scrypt'||config.N!==32768||config.r!==8||config.p!==1||config.archive!=='tar.gz')throw new Error('Unsupported backup format');
    const salt=Buffer.from(config.salt,'base64'),iv=Buffer.from(config.iv,'base64');if(salt.length!==16||iv.length!==12)throw new Error('Invalid backup salt/IV');
    key=await derive(password,salt,32,parameters);const decipher=createDecipheriv('aes-256-gcm',key,iv);
    decipher.setAAD(Buffer.concat([head,metadata]));const tag=Buffer.alloc(16);await handle.read(tag,0,16,info.size-16);decipher.setAuthTag(tag);
    const output=await open(partial,'wx',0o600);partialOwned=true;
    try{await pipeline(createReadStream(source,{start:head.length+size,end:info.size-17}),decipher,output.createWriteStream());}finally{await output.close();}
    await link(partial,destination);
    return {size:(await stat(destination)).size};
  }finally{key?.fill(0);await handle.close();if(partialOwned)await unlink(partial).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
