// Explicit download onto an administrator's computer; models are never bundled.
import {resolve,join,sep} from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../server/database.js';
import {AI_MODEL_CATALOG,previewAiModel,validateModelManifest,createAiModels} from '../server/ai-models.js';
import {aiHash} from '../server/ai-validation.js';
const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
if(process.argv.includes('--list')){for(const model of AI_MODEL_CATALOG)console.log(model.key+' · '+model.name+' · '+model.license);process.exit(0);}
if(!arg('destination')||!arg('key')&&!arg('manifest'))throw Error('Use --key=<catalog-key> or --manifest=<saved-json>, and --destination=<folder>. First use --list to see models.');
const destination=resolve(arg('destination')),project=resolve(fileURLToPath(new URL('../',import.meta.url)));
if(destination===project||destination.startsWith(project+sep)&&!destination.startsWith(join(project,'.local')+sep))throw Error('Keep downloaded models outside the source checkout.');
await mkdir(destination,{recursive:true});
let manifest,licenseUrl;
if(arg('manifest')){manifest=validateModelManifest(JSON.parse(await readFile(resolve(arg('manifest')),'utf8')));licenseUrl=manifest.downloadBase?'https://github.com/facebookresearch/demucs/blob/v4.0.1/LICENSE':'https://huggingface.co/'+manifest.repo+'/tree/'+manifest.revision;}
else({manifest,licenseUrl}=await previewAiModel(arg('key')));
const saved=join(destination,'mirea-model-'+manifest.key+'.json');await writeFile(saved,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'}).catch(async error=>{if(error.code!=='EEXIST')throw error;const old=validateModelManifest(JSON.parse(await readFile(saved,'utf8')));if(old.id!==manifest.id)throw Error('A different fixed revision is already saved. Choose a new destination.');});
console.log('Model: '+manifest.name+'\nLicense: '+manifest.license+'\nTerms and fixed source: '+licenseUrl+'\nBytes: '+manifest.files.reduce((n,f)=>n+f.size,0));
if(!process.argv.includes('--accept-model-terms')){console.log('Preview saved. Review the terms, then rerun using --manifest='+saved+' and --accept-model-terms to download.');process.exit(0);}
const db=openDatabase(':memory:');db.prepare("INSERT INTO users VALUES('local-model-operator','operator@example.invalid','Local operator','no-login',1)").run();
const models=createAiModels({db,dataDir:destination});let last=0;
try{models.accept(manifest,'local-model-operator',aiHash({id:manifest.id,license:manifest.license}));
 while(models.get(manifest.id).state==='downloading'){await new Promise(resolve=>setTimeout(resolve,500));const current=models.get(manifest.id);if(Date.now()-last>3000){console.log((current.progress.receivedBytes??0)+' / '+(current.progress.totalBytes??0)+' bytes');last=Date.now();}}
 const current=models.get(manifest.id);if(current.state!=='ready')throw Error('Download stopped: '+current.errorCode+'; rerun with the same manifest to resume.');
 console.log('Verified files: '+models.resolve(manifest.id).folder+'\nImport manifest: '+saved);
}finally{await models.close();db.close();}
