import http from 'node:http';
import https from 'node:https';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PROJECT_ROOT} from './runtime.js';
import pkg from '../package.json' with {type:'json'};

// Local-only probe; no credentials, database writes, redirects or TLS bypass.
export async function checkHealth(env=process.env,{timeout=4000}={}){
  const tls=Boolean(env.HTTPS_KEY_FILE||env.HTTPS_CERT_FILE);
  if(tls&&!(env.HTTPS_KEY_FILE&&env.HTTPS_CERT_FILE))throw Error('Incomplete TLS configuration');
  const port=Number(env.PORT??3000);if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error('Invalid health port');
  const servername=env.HEALTHCHECK_TLS_SERVER_NAME;
  if(servername&&!/^[A-Za-z0-9.-]{1,253}$/.test(servername))throw Error('Invalid health TLS name');
  const ca=tls&&env.HEALTHCHECK_CA_FILE?await readFile(resolve(PROJECT_ROOT,env.HEALTHCHECK_CA_FILE)):undefined;
  return new Promise((done,reject)=>{
    const request=(tls?https:http).get({hostname:'127.0.0.1',port,path:'/api/health',timeout,agent:false,...(tls?{ca,servername:servername??'localhost',rejectUnauthorized:true}:{})},response=>{
      let text='';response.setEncoding('utf8');response.on('data',part=>{text+=part;if(text.length>16384)response.destroy(Error('Oversized health response'));});response.on('error',reject);
      response.on('end',()=>{try{const body=JSON.parse(text);if(response.statusCode!==200||body.status!=='ok'||body.version!==pkg.version)throw Error('Unhealthy or mismatched service');done(body);}catch(error){reject(error);}});
    });request.on('timeout',()=>request.destroy(Error('Health timeout')));request.on('error',reject);
  });
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)try{await checkHealth();}catch{console.error('Mirea health check failed');process.exitCode=1;}
