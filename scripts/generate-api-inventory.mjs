import {readFile, readdir, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

// Static registration inventory, not an OpenAPI/schema inference engine.
// It never imports the application or opens a database/network connection.
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const rows=[];
for(const filename of (await readdir(join(root,'server'))).filter(name=>name.endsWith('.js')).sort()){
  const source=await readFile(join(root,'server',filename),'utf8');
  const add=(method,path,index)=>rows.push({method,path,file:filename,line:source.slice(0,index).split('\n').length});
  for(const match of source.matchAll(/\b(?:app|routes)\.(get|post|put|patch|delete|head)\(\s*['"]([^'"]+)['"]/g))add(match[1].toUpperCase(),match[2],match.index);
  for(const match of source.matchAll(/\bapp\.route\(\s*\{\s*method\s*:\s*(\[[^\]]+\]|['"][A-Z]+['"])\s*,\s*url\s*:\s*['"]([^'"]+)['"]/g)){
    const methods=[...match[1].matchAll(/['"]([A-Z]+)['"]/g)].map(value=>value[1]);
    for(const method of methods)add(method,match[2],match.index);
  }
  // These four routes are registered using two literal loops, not direct strings.
  if(filename==='analytics.js'){
    const index=source.indexOf("for (const [base, global]");
    if(index<0)throw Error('Analytics route registration changed; update inventory extractor.');
    for(const base of ['/api/v1/shelves/:id/analytics','/api/v1/analytics/global'])for(const suffix of ['summary','export'])add('GET',`${base}/${suffix}`,index);
  }
}
rows.sort((a,b)=>a.path.localeCompare(b.path,'en')||a.method.localeCompare(b.method,'en'));
const unique=new Set();for(const row of rows){const key=row.method+' '+row.path;if(unique.has(key))throw Error('Duplicate route: '+key);unique.add(key);}
const lf=value=>value.replace(/\r\n?/g,'\n');
const output=lf(`# API登録一覧（自動生成）

現行のサーバーソースから抽出した **${rows.length}件のメソッド／パス** です。GETとHEADは別に数えます。
本文・応答・認可・競合処理は[APIガイド](../api.md)と各リンク先のschema／handlerを参照してください。
これは完全なOpenAPI定義ではありません。静的な登録式を抽出するため、登録方法を変えた場合は生成器も更新してください。

生成: <code>node scripts/generate-api-inventory.mjs</code>。差分確認: <code>node scripts/generate-api-inventory.mjs --check</code>。
ユーザーデータや稼働中サーバーへ接続せず生成します。

|メソッド|絶対パス|登録元（行番号は生成時点）|
|---|---|---|
${rows.map(row=>`|${row.method}|\`${row.path}\`|[${row.file}:${row.line}](../../server/${row.file}#L${row.line})|`).join('\n')}
`);
const destination=join(root,'docs','reference','api-routes.md');
if(process.argv.includes('--check')){
  if(lf(await readFile(destination,'utf8'))!==output)throw Error('API inventory is out of date. Run node scripts/generate-api-inventory.mjs');
}else{await mkdir(dirname(destination),{recursive:true});await writeFile(destination,output,'utf8');}
console.log(`API inventory: ${rows.length} method/path registrations${process.argv.includes('--check')?' verified':''}.`);
