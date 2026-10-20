import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {dirname,resolve,join,sep} from 'node:path';
import {decryptBackup} from '../server/backup-archive.js';

const inputs=process.argv.filter(a=>a.startsWith('--input=')).map(a=>resolve(a.slice(8))).sort();
const output=process.argv.find(a=>a.startsWith('--output='))?.slice(9),passwordFile=process.argv.find(a=>a.startsWith('--password-file='))?.slice(16);
if(!inputs.length||!output)throw new Error('Usage: node scripts/decrypt-backup.mjs --input=backup[.part-000001] [--input=...part-000002] --output=backup.tar.gz [--password-file=protected-file]');
async function prompt(){
  if(!process.stdin.isTTY)throw new Error('Use an interactive terminal or an explicitly protected --password-file');
  process.stderr.write('Backup password (hidden): ');process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  return new Promise((resolve,reject)=>{let password='';const handler=text=>{for(const char of text){if(char==='\u0003'){finish();reject(new Error('Cancelled'));return;}if(char==='\r'||char==='\n'){finish();resolve(password);return;}if(char==='\u007f'||char==='\b')password=password.slice(0,-1);else if(char>=' '&&password.length<128)password+=char;}};const finish=()=>{process.stdin.off('data',handler);process.stdin.setRawMode(false);process.stdin.pause();process.stderr.write('\n');};process.stdin.on('data',handler);});
}
let password=passwordFile?(await readFile(passwordFile,'utf8')).replace(/\r?\n$/,''):await prompt();
let temporary;
try{
  let source=inputs[0];
  if(inputs.length>1){temporary=await mkdtemp(join(dirname(resolve(output)),'.mirea-join-'));source=join(temporary,'joined.mireabackup');
    await pipeline(Readable.from((async function*(){for(const file of inputs)for await(const chunk of createReadStream(file))yield chunk;})()),createWriteStream(source,{flags:'wx',mode:0o600}));}
  await decryptBackup(source,resolve(output),password);console.log('Backup authentication passed. Decrypted tar.gz written. Restore only while Mirea is stopped; inspect backup-manifest.json first.');
}finally{password='';if(temporary){if(!resolve(temporary).startsWith(dirname(resolve(output))+sep+'.mirea-join-'))throw new Error('Unsafe temporary cleanup target');await rm(temporary,{recursive:true,force:true});}}
