import {access,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const noticeName=/(?:^|[-_.])(?:licen[cs]es?|notices?|copying|copyright)(?:$|[-_.])/i;
const fullGrant=/Permission is hereby granted|Permission to use, copy|Redistribution and use in source and binary forms|TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/;
const hasLicense=documents=>documents.some(d=>/(?:^|[-_.])(?:licen[cs]es?|copying)(?:$|[-_.])/i.test(d.path.split('/').at(-1))||fullGrant.test(d.text));
const skipped=new Set(['node_modules','.git','.github','test','tests','__tests__']);
const safeUrl=value=>{try{const url=new URL(String(value).replace(/^git\+/,''));return ['https:','http:'].includes(url.protocol)?url.href:undefined;}catch{return undefined;}};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function packageDirectory(name,parent){
  for(let base=parent;;base=dirname(base)){
    const candidate=join(base,'node_modules',name);
    try{await access(join(candidate,'package.json'));return await realpath(candidate);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(dirname(base)===base)return null;
  }
}
async function licenseFiles(directory){
  const documents=[];
  async function visit(folder,relative=''){
    for(const entry of (await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
      if(entry.isSymbolicLink())continue;
      const path=join(folder,entry.name),name=relative+entry.name;
      if(entry.isDirectory()){if(!skipped.has(entry.name))await visit(path,name+'/');}
      else if(entry.isFile()&&(noticeName.test(entry.name)||/^(?:ffmpeg|ffprobe).*\.README$/i.test(entry.name)||entry.name==='sbom.cdx.json')){
        const bytes=await readFile(path);
        if(bytes.includes(0))throw new Error('Binary notice needs review: '+name);
        documents.push({path:name,text:bytes.toString('utf8')});
      }
    }
  }
  await visit(directory);
  // Some upstream packages publish the complete license inside their README.
  // Preserve that original file, never substitute a guessed copyright owner.
  if(!hasLicense(documents))for(const name of await readdir(directory))if(/^readme(?:\.|$)/i.test(name)){
    const text=await readFile(join(directory,name),'utf8');
    if(fullGrant.test(text))documents.push({path:name,text});
  }
  return documents;
}
export async function collectNpmNotices({projectRoot=root}={}){
  const pkg=JSON.parse(await readFile(join(projectRoot,'package.json'),'utf8')),seen=new Set(),packages=[],missing=[];
  async function visit(name,parent,optional=false){
    const directory=await packageDirectory(name,parent);
    if(!directory){if(optional)return;throw new Error('Runtime dependency is not installed: '+name);}
    if(seen.has(directory))return;seen.add(directory);
    const item=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
    let documents=await licenseFiles(directory),licenseSource;
    // NAPI platform packages are the same tagged upstream project and omit
    // their duplicate MIT file. Use the exact-version parent project's copy.
    if(!hasLicense(documents)&&/^@napi-rs\/canvas-/.test(item.name)){
      const parentDirectory=await packageDirectory('@napi-rs/canvas',projectRoot),parentPackage=parentDirectory&&JSON.parse(await readFile(join(parentDirectory,'package.json'),'utf8'));
      if(parentPackage?.version===item.version&&parentPackage.license===item.license&&parentPackage.repository?.url===item.repository?.url){documents.push(...await licenseFiles(parentDirectory));licenseSource=parentPackage.name+'@'+parentPackage.version;}
    }
    if(!hasLicense(documents)&&['saxes@6.0.0','abstract-logging@2.0.1'].includes(item.name+'@'+item.version)){
      const name=item.name+'-'+item.version+'.LICENSE';
      documents.push({path:name,text:await readFile(join(projectRoot,'third-party',name),'utf8')});licenseSource='Supplementary notice; see third-party/README.md in the source distribution';
    }
    if(!hasLicense(documents))missing.push(item.name+'@'+item.version);
    packages.push({name:item.name,version:item.version,license:typeof item.license==='string'?item.license:JSON.stringify(item.license??item.licenses??'See included documents'),source:safeUrl(item.repository?.url??item.repository??item.homepage),...(licenseSource?{licenseSource}:{}),documents});
    const dependencies={...item.dependencies,...item.optionalDependencies};
    for(const dependency of Object.keys(dependencies).sort())await visit(dependency,directory,Object.hasOwn(item.optionalDependencies??{},dependency));
    for(const peer of Object.keys(item.peerDependencies??{}).sort())await visit(peer,directory,Boolean(item.peerDependenciesMeta?.[peer]?.optional));
  }
  for(const name of Object.keys({...pkg.dependencies,...pkg.optionalDependencies}).sort())await visit(name,projectRoot,Object.hasOwn(pkg.optionalDependencies??{},name));
  if(missing.length)throw new Error('No license/notice file found for: '+missing.join(', '));
  packages.sort((a,b)=>(a.name+'@'+a.version).localeCompare(b.name+'@'+b.version,'en'));
  return {schemaVersion:1,scope:'npm-production',description:'Installed production dependencies, including platform-specific dependencies. The list is intentionally broader than any one browser bundle. Upstream license and notice files are reproduced without modification; supplementary notices identify their source separately.',packages};
}
export function renderNotices(catalog){
  const text=catalog.packages.map(p=>`${p.name}@${p.version}\nLicense: ${p.license}\n${p.source??''}\n${p.licenseSource??''}\n`+p.documents.map(d=>`--- ${d.path} ---\n${d.text}`).join('\n\n')).join('\n\n'+ '='.repeat(72)+'\n\n');
  return {
    'third-party-notices.json':{type:'application/json',body:JSON.stringify(catalog)+'\n'},
    'third-party-notices.txt':{type:'text/plain',body:catalog.description+'\n\n'+text+'\n'},
    'third-party-notices.html':{type:'text/html',body:'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mirea — Third-party notices</title><body><h1>Third-party notices</h1><p>'+escape(catalog.description)+'</p>'+catalog.packages.map(p=>'<details><summary>'+escape(p.name+'@'+p.version+' — '+p.license)+'</summary>'+(p.licenseSource?'<p>'+escape(p.licenseSource)+'</p>':'')+p.documents.map(d=>'<h2>'+escape(d.path)+'</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">'+escape(d.text)+'</pre>').join('')+'</details>').join('')+'</body></html>\n'}
  };
}
export async function writeNotices({projectRoot=root,outputDirectory=join(root,'dist')}={}){
  const catalog=await collectNpmNotices({projectRoot});await mkdir(outputDirectory,{recursive:true});
  for(const [name,{body}]of Object.entries(renderNotices(catalog)))await writeFile(join(outputDirectory,name),body);
  return {packages:catalog.packages.length};
}
export function thirdPartyNoticesDevPlugin({projectRoot=root}={}){
  return {name:'mirea-third-party-notices-dev',apply:'serve',configureServer(server){
    let pending;
    server.middlewares.use(async(req,res,next)=>{
      const path=req.url?.split('?')[0];
      if(!['GET','HEAD'].includes(req.method)||!/^\/third-party-notices\.(?:json|txt|html)$/.test(path??''))return next();
      try{
        // Serve the same renderer without depending on a previous dist build.
        // Only these three fixed public resources are exposed by middleware.
        pending??=collectNpmNotices({projectRoot}).then(renderNotices);
        const file=(await pending)[path.slice(1)];
        res.setHeader('Content-Type',file.type+'; charset=utf-8');res.setHeader('Content-Length',Buffer.byteLength(file.body));res.setHeader('Cache-Control','no-cache');
        res.end(req.method==='HEAD'?undefined:file.body);
      }catch(error){pending=undefined;next(error);}
    });
  }};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await writeNotices({outputDirectory:process.argv.find(a=>a.startsWith('--output='))?.slice(9)??join(root,'dist')})));
