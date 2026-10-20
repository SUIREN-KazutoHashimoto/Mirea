import {githubJson,RELEASE_API,releaseCandidate} from '../server/server-updates.js';
const [tag,current]=process.argv.slice(2);
if(!/^v\d+\.\d+\.\d+(?:beta(?:\.\d+)?)?$/.test(tag??''))throw new Error('Invalid release tag');
const candidate=releaseCandidate(await githubJson(RELEASE_API+'/tags/'+tag),'v'+String(current).replace('-beta','beta'));
if(!candidate)throw new Error('No verified newer official server package');
console.log(JSON.stringify(candidate));
