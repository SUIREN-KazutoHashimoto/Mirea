import {githubJson,RELEASE_API,releaseCandidate} from '../server/server-updates.js';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const [tag,current,destination]=process.argv.slice(2);
if(!/^v\d+\.\d+\.\d+(?:beta(?:\.\d+)?)?$/.test(tag??''))throw new Error('Invalid release tag');
const asset=releaseCandidate(await githubJson(RELEASE_API+'/tags/'+tag),'v'+String(current).replace('-beta','beta'));
if(!asset)throw new Error('No verified package');
let url=asset.url,response;
for(let redirects=0;redirects<6;redirects++){
  const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))throw new Error('Untrusted release redirect');
  response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10*60000),headers:{'User-Agent':'Mirea-Windows-Maintenance'}});
  if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');await response.body?.cancel();url=new URL(next,url).href;continue;}
  break;
}
if(!response?.ok)throw new Error('Release download failed');
const hash=createHash('sha256');let size=0;
await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,done){size+=chunk.length;if(size>asset.size){done(new Error('Package exceeds confirmed size'));return;}hash.update(chunk);done(null,chunk);}}),createWriteStream(destination,{flags:'wx',mode:0o600}));
if(size!==asset.size||hash.digest('hex')!==asset.sha256)throw new Error('Package integrity failed');
