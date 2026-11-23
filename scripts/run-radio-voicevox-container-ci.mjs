// Official Linux CI only. Official vendor archives are temporary runner inputs,
// never build context, container layers, logs, cached dependencies, or assets.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';

const base=process.env.RUNNER_TEMP;
assert(process.platform==='linux'&&process.arch==='x64'&&process.env.GITHUB_ACTIONS==='true'
  &&typeof base==='string'&&resolve(base)===base&&base.length>10,'Official x64 GitHub Actions runner is required');
assert(/^mirea-ci-\d+-\d+$/.test(process.env.COMPOSE_PROJECT_NAME??''),'Isolated CI project is required');
assert.equal(process.env.MIREA_IMAGE,'mirea:ci','Only the built candidate image may be tested here');
const assets={
 core:['https://github.com/VOICEVOX/voicevox_core/releases/download/0.17.1/voicevox_core-linux-x64-0.17.1.zip',
       '844b49ce48040ecd85c8b2baaf75f77855277a0f92f6e87ea7ec45c820943323',167772160],
 onnx:['https://github.com/VOICEVOX/onnxruntime-builder/releases/download/voicevox_onnxruntime-1.23.2/voicevox_onnxruntime-linux-x64-1.23.2.tgz',
       '0860cfbd5a80201b1bf95cae13ca2db8dc01f32f5674cc8193146047a9212fdb',67108864],
 model:['https://github.com/VOICEVOX/voicevox_vvm/releases/download/0.17.1/n0.vvm',
        'f9793559a0ecad1622c15e68674860d7d00ce2736cf02b3f46b083e989c74ec7',134217728],
 dictionary:['https://downloads.sourceforge.net/project/open-jtalk/Dictionary/open_jtalk_dic-1.11/open_jtalk_dic_utf_8-1.11.tar.gz',
             '33e9cd251bc41aa2bd7ca36f57abbf61eae3543ca25ca892ae345e394cb10549',50331648]
};
const run=(program,args,overrides={})=>execFileSync(program,args,{encoding:'utf8',timeout:210000,maxBuffer:512*1024,...overrides});
const root=await mkdtemp(join(base,'mirea-native-voice-ci-'));
const mount=join(root,'mounted'), dictionary=join(mount,'dictionary');
const remote='/app/radio-voice';
assert(root.startsWith(base+sep+'mirea-native-voice-ci-'));
assert(!/[\r\n,]/.test(mount),'Unexpected mount path');
const config={
 python:'/usr/bin/python3',core:remote+'/libvoicevox_core.so',onnx:remote+'/libvoicevox_onnxruntime.so.1.23.2',
 dictionary:remote+'/dictionary',model:remote+'/n0.vvm',modelSha256:assets.model[1],
 style:10005,credit:'VOICEVOX Nemo',spokenCredit:'ボイスボックス・ネモ',modelTermsReviewed:true
};
async function fetchVerified(name){
  const [url,sha,max]=assets[name], output=join(root,name+'.download');
  assert.match(url,/^https:\/\//);
  run('curl',['--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https',
    '--max-filesize',String(max),'--connect-timeout','15','--max-time','180','--output',output,url]);
  const info=await stat(output);
  assert(info.isFile()&&info.size>0&&info.size<=max,'Unexpected asset length: '+name);
  const hash=createHash('sha256');for await(const chunk of createReadStream(output))hash.update(chunk);
  assert.equal(hash.digest('hex'),sha,'Official asset digest mismatch: '+name);
  return output;
}
function listArchive(type,file){
  const entries=(type==='zip'?run('unzip',['-Z1',file]):run('tar',['-tzf',file])).split('\n').filter(Boolean);
  assert(entries.length>0&&entries.length<1024);
  assert(entries.every(path=>!/^[\/\\]|(^|\/)\.\.(\/|$)|[\0\r]/.test(path)),'Unexpected vendor archive layout');
  return entries;
}
async function extractOne(type,file,entry,destination){
  // Extract a fixed verified entry to a new regular file, without following
  // archive link/directory metadata or accepting archive-owned pathname writes.
  const cmd=type==='zip'?'unzip':'tar', args=type==='zip'?['-p',file,entry]:['-xOzf',file,'--',entry];
  const process=spawn(cmd,args,{stdio:['ignore','pipe','ignore'],signal:AbortSignal.timeout(45_000)});
  const finished=new Promise((ok,no)=>{process.once('error',no);process.once('close',code=>code===0?ok():no(Error('Cannot extract exact vendor member')));});
  await Promise.all([pipeline(process.stdout,createWriteStream(destination,{flags:'wx',mode:0o644})),finished]);
  const info=await stat(destination);assert(info.isFile()&&info.size>0&&info.size<160*1024*1024);
}
function uniqueMember(entries,name){
  const matches=entries.filter(p=>p.endsWith('/'+name)||p===name);
  assert.equal(matches.length,1,'Expected one official archive member: '+name);
  assert(/^[A-Za-z0-9_./-]+$/.test(matches[0]));
  return matches[0];
}
async function elf(file){
  const bytes=await readFile(file);
  assert(bytes.length>=64&&bytes.subarray(0,4).equals(Buffer.from([0x7f,69,76,70]))&&bytes[4]===2&&bytes[5]===1&&bytes.readUInt16LE(18)===62,
    'Expected little-endian ELF64 amd64 native library');
}
let rootOwned=false;
try{
  await mkdir(mount,{mode:0o755});await mkdir(dictionary,{mode:0o755});
  const core=await fetchVerified('core'), onnx=await fetchVerified('onnx');
  const model=await fetchVerified('model'), lexicon=await fetchVerified('dictionary');
  const coreEntries=listArchive('zip',core), onnxEntries=listArchive('tar',onnx),dictEntries=listArchive('tar',lexicon);
  const coreName=coreEntries.some(p=>p.endsWith('/libvoicevox_core.so.0.17.1')||p==='libvoicevox_core.so.0.17.1')
    ?'libvoicevox_core.so.0.17.1':'libvoicevox_core.so';
  const coreFile=join(mount,'libvoicevox_core.so'), onnxName='libvoicevox_onnxruntime.so.1.23.2',onnxFile=join(mount,onnxName);
  await extractOne('zip',core,uniqueMember(coreEntries,coreName),coreFile);
  await extractOne('tar',onnx,uniqueMember(onnxEntries,onnxName),onnxFile);
  await elf(coreFile);await elf(onnxFile);
  for(const name of ['char.bin','matrix.bin','sys.dic','unk.dic','left-id.def','rewrite.def','pos-id.def','right-id.def','COPYING'])
    await extractOne('tar',lexicon,uniqueMember(dictEntries,name),join(dictionary,name));
  await pipeline(createReadStream(model),createWriteStream(join(mount,'n0.vvm'),{flags:'wx',mode:0o644}));
  await writeFile(join(mount,'runtime.json'),JSON.stringify(config),{flag:'wx',mode:0o644});
  await chmod(mount,0o755);await chmod(dictionary,0o755);
  // Docker sees root ownership. The bind itself remains read-only and no
  // capabilities or writable root are passed even on this disposable runner.
  rootOwned=true;run('sudo',['-n','chown','-R','0:0','--',mount]);
  const check=await readFile(new URL('./check-radio-voicevox-container.mjs',import.meta.url));
  const result=run('docker',['run','--rm','-i','--network','none','--user','1000:1000','--read-only',
    '--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,noexec,nosuid,size=128m,mode=1777',
    '--mount','type=bind,source='+mount+',target='+remote+',readonly',
    '-e','MIREA_TEST_VOICEVOX_CONFIG='+remote+'/runtime.json','mirea:ci','/usr/local/bin/node','--input-type=module'],
    {input:check,timeout:180000});
  const proof=JSON.parse(result.trim().split('\n').at(-1));
  assert.equal(proof.realVoice,true,'Real Linux VOICEVOX probe and AAC are mandatory');
  console.log(JSON.stringify(proof));
}finally{
  if(rootOwned)run('sudo',['-n','chown','-R',process.getuid()+':'+process.getgid(),'--',mount]);
  await rm(root,{recursive:true,force:true});
}
