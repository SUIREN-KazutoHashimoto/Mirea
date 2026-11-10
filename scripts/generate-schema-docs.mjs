// Documentation only: construct an empty, in-memory database, never DATA_DIR.
import {writeFile, mkdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {openDatabase} from '../server/database.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const db=openDatabase(':memory:');
const cell=value=>String(value??'—').replaceAll('|','\\|').replaceAll('\n',' ');
const quoted=name=>'"'+name.replaceAll('"','""')+'"';
const version=db.prepare('SELECT version FROM schema_version').get().version;
const tables=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (SELECT name FROM pragma_table_list WHERE type='shadow') ORDER BY name").all();
let text=`# SQLite スキーマ参照\n\n[設計書の入口](overview.md) · [データ設計](data-model.md)\n\nこの参照表は server/database.js を空のインメモリDBへ適用して生成します。既存のデータ領域・利用者レコードは読みません。現在のスキーマ番号は **${version}**、アプリケーションテーブルは **${tables.length}個**です。FTS仮想表を含み、FTSのshadow表、移行途中の置換表、SQLite内部表は含みません。\n\n再生成: リポジトリ直下で node scripts/generate-schema-docs.mjs。差分確認のみ: node scripts/generate-schema-docs.mjs --check。この資料は作業ツリーの定義を示します。配布版を調べる場合は対応するGitタグの資料を参照してください。\n\n## テーブル一覧\n\n${tables.map(row=>`- [${row.name}](#${row.name.replaceAll('_','-')})`).join('\n')}\n`;
for(const row of tables){
 text+=`\n## ${row.name.replaceAll('_',' ')}\n\nテーブル名: \`${row.name}\`\n\n| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |\n| --- | --- | --- | --- | --- |\n`;
 for(const column of db.prepare(`PRAGMA table_info(${quoted(row.name)})`).all())text+=`| ${cell(column.name)} | ${cell(column.type)} | ${column.notnull?'はい':'いいえ'} | ${cell(column.dflt_value)} | ${column.pk||'—'} |\n`;
 text+='\nSQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。\n';
 const foreign=db.prepare(`PRAGMA foreign_key_list(${quoted(row.name)})`).all();
 if(foreign.length){text+='\n| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |\n| --- | --- | --- | --- |\n';for(const f of foreign)text+=`| ${cell(f.from)} | ${cell(f.table)}.${cell(f.to)} | ${f.on_update} | ${f.on_delete} |\n`;}
 else text+='\n外部キーはありません。\n';
 const indexes=db.prepare(`PRAGMA index_list(${quoted(row.name)})`).all();
 if(indexes.length){text+='\n| 索引 | 一意 | 作成元 | 部分索引 | 列 |\n| --- | --- | --- | --- | --- |\n';for(const index of indexes){const cols=db.prepare(`PRAGMA index_info(${quoted(index.name)})`).all().map(x=>x.name??'(式)').join(', ');text+=`| ${cell(index.name)} | ${index.unique?'はい':'いいえ'} | ${index.origin} | ${index.partial?'はい':'いいえ'} | ${cell(cols)} |\n`;}}
 text+=`\n<details>\n<summary>CREATE TABLE 定義</summary>\n\n\`\`\`sql\n${row.sql};\n\`\`\`\n\n</details>\n`;
}
const indexes=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all();
text+='\n## 明示的な索引の定義\n\n`origin`の`pk`は主キー、`u`はUNIQUE制約、`c`はCREATE INDEX由来です。部分索引の条件は次のSQLで確認できます。\n\n```sql\n'+indexes.map(x=>x.sql+';').join('\n')+'\n```\n';
const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
text+='\n## トリガー\n\nシリーズの整合性、再試行時の非表示解除、ジョブの開始・終了時計をDB側で補助します。HTTPの認証・権限検査の代わりにはなりません。\n';
for(const trigger of triggers)text+=`\n### ${trigger.name.replaceAll('_',' ')}\n\n\`\`\`sql\n${trigger.sql};\n\`\`\`\n`;
db.close();
const destination=resolve(root,'docs/design/schema-reference.md');
const lf=value=>value.replace(/\r\n?/g,'\n');
text=lf(text);
if(process.argv.includes('--check')){if(lf(await readFile(destination,'utf8'))!==text){console.error('Schema documentation differs; regenerate docs/design/schema-reference.md');process.exitCode=1;}else console.log('Schema documentation matches the in-memory schema.');}
else{await mkdir(dirname(destination),{recursive:true});await writeFile(destination,text);console.log(`Generated schema ${version}: ${tables.length} tables, ${indexes.length} explicit indexes, ${triggers.length} triggers.`);}
