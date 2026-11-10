// Synthetic Linux container check: no weights or user data.
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {AI_RUNTIME_ROOT,createAiRuntime,runAiProcess,aiProcessEnvironment}=await import(new URL('server/ai-runtime.js',pathToFileURL(process.cwd()+'/')));
if(process.platform!=='linux')throw Error('Linux container verification required');
async function inspectCode(path){for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())await inspectCode(file);else assert(!/\.(?:gguf|safetensors|pth|pt|th|onnx|ckpt|tflite|weights)$/i.test(entry.name),'Model weights must not be bundled with inference code');}}
await inspectCode(AI_RUNTIME_ROOT);
const runtime=createAiRuntime({settings:()=>({})});
try{const supported=await runtime.supported();assert(supported.cpu&&supported.transcription&&supported.music,'Inference code must be installed without weights');
 await runAiProcess(join(AI_RUNTIME_ROOT,'llama-cpu','llama-server'),['--version'],{timeout:30000,captureStderr:true,maxOutput:65536});
 await runAiProcess(join(AI_RUNTIME_ROOT,'whisper','whisper-cli'),['--help'],{timeout:30000,captureStderr:true,maxOutput:65536});
 const code="import socket,errno,json,sys\ns=socket.socket()\ntry:\n s.connect(('127.0.0.1',9));raise RuntimeError('outbound connection allowed')\nexcept OSError as e:\n assert e.errno==errno.EPERM\ns.close()\ns=socket.socket();s.bind(('127.0.0.1',int(sys.argv[1])));s.listen(1);print('READY',flush=True)\nc,a=s.accept();c.recv(8192);data=json.dumps({'local':True}).encode();c.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Length: '+str(len(data)).encode()+b'\\r\\nConnection: close\\r\\n\\r\\n'+data);c.close();s.close()";
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(join(AI_RUNTIME_ROOT,'mirea-ai-exec'),['/usr/bin/python3','-c',code,String(port)],{stdio:['ignore','pipe','pipe'],env:aiProcessEnvironment()});
 let stderr='';child.stderr.on('data',c=>{stderr=(stderr+c).slice(-4096);});const closed=new Promise(resolve=>child.once('close',resolve));
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic listener startup failed')),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);child.once('exit',code=>{if(code)reject(Error('Synthetic listener exited'));});});
  const response=await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(5000)});assert.deepEqual(await response.json(),{local:true});assert.equal(await closed,0,stderr);
 }finally{child.kill('SIGKILL');await closed;}
 console.log(JSON.stringify({inferenceCode:true,weightsRequired:false,outboundDenied:true,acceptedLoopbackReplies:true}));
}finally{await runtime.close();}
