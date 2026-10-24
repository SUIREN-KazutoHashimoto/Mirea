import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/database.js';

test('real v11 MIME migration keeps all child rows, video metadata, keys and series guards; audio metadata cascades',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'mirea-audio-migration-')),filename=join(folder,'migration.sqlite');let db=openDatabase(filename);
  try{
    db.exec(`INSERT INTO users VALUES('u','migration@example.test','Existing','hash',1);
      INSERT INTO shelves VALUES('s','Shared','',1),('other','Other','',1);
      INSERT INTO memberships VALUES('s','u','owner');
      INSERT INTO sessions VALUES('session','hash','u',9999999999999);
      INSERT INTO items VALUES('v','s','Video','old.mp4','video/mp4',200,'u',1,1,1),('b','s','Book','old.png','application/vnd.mirea.image-book',100,'u',2,1,1);
      INSERT INTO video_assets VALUES('v','{"version":1,"renditions":[]}',1);
      INSERT INTO image_pages VALUES('b',1,'old.png',100,10,10,'image/png');
      INSERT INTO playback_tickets VALUES('ticket','session','v',9999999999999);
      INSERT INTO encrypted_downloads VALUES('download','u','v','{"id":"keep-key-binding"}',1);
      INSERT INTO asset_progress(user_id,asset_id,revision,update_id,payload_hash,position_ms,duration_ms,updated_at) VALUES('u','v',2,'update','payload',12000,60000,1);
      INSERT INTO upload_sessions(id,shelf_id,user_id,session_id,title,files_json,chunk_size,state,created_at,expires_at,retain_original,processing_json) VALUES('upload','s','u','session','Retry','[]',1024,'failed',1,2,1,'{"stage":"encode"}');
      INSERT INTO upload_parts VALUES('upload',0,0,1,'hash');
      INSERT INTO analytics_views(id,user_id,asset_id,shelf_id,asset_kind,asset_title,page_count,context,platform,client_version,auth_session_id,opened_at,first_received_at,last_received_at) VALUES('view','u','v','s','video','Video',1,'viewer','web','test','session',1,1,1);
      INSERT INTO analytics_events(event_id,view_id,seq,event_type,client_at,received_at,elapsed_ms,interval_ms,visible_ms,active_ms,watch_ms,payload_json,payload_hash) VALUES('event','view',1,'open',1,1,0,0,0,0,0,'{}','hash');
      INSERT INTO analytics_video_bins VALUES('view',0,1000,1000);
      INSERT INTO series(id,shelf_id,title,description,revision,created_at,updated_at) VALUES('album','s','Series','',2,1,1);
      INSERT INTO series_items VALUES('album','v',1,'Track');`);
    const definition=db.prepare("SELECT sql FROM sqlite_master WHERE name='items'").get().sql.replace(/CREATE TABLE "?items"?\s*\(/,'CREATE TABLE items_v11 (').replace(",'audio/mp4'",'');
    assert.match(definition,/CREATE TABLE items_v11/);assert.ok(!definition.includes('audio/mp4'));
    const guards=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'series_%'").all();
    db.exec('PRAGMA foreign_keys=OFF');for(const {name} of guards)db.exec(`DROP TRIGGER ${name}`);
    db.exec(`${definition};INSERT INTO items_v11 SELECT * FROM items;DROP TABLE items;ALTER TABLE items_v11 RENAME TO items;DROP TABLE audio_assets;UPDATE schema_version SET version=11;`);
    for(const {sql} of guards)db.exec(sql);
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_version','sqlite_sequence') ORDER BY name").all().map(row=>row.name);
    const before=tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());db.close();db=openDatabase(filename);
    tables.forEach((table,i)=>assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),before[i],table));
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version,18);
    assert.throws(()=>db.prepare("UPDATE items SET shelf_id='other' WHERE id='v'").run(),/before moving/);
    db.exec(`INSERT INTO items VALUES('a','s','Audio','music.m4a','audio/mp4',100,'u',3,1,1);INSERT INTO audio_assets VALUES('a','{}',0);DELETE FROM items WHERE id='a';`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM audio_assets').get().n,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.close();db=openDatabase(filename);tables.forEach((table,i)=>assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),before[i],table+' reopen'));
  }finally{db.close();await rm(folder,{recursive:true,force:true});}
});

test('version 1 migration preserves accounts, shelves, items, sessions and tickets', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mirea-migration-'));
  const filename = join(folder, 'migration.sqlite');
  let db = new DatabaseSync(filename);
  try {
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES(1);
      CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE shelves(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE memberships(shelf_id TEXT REFERENCES shelves(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, PRIMARY KEY(shelf_id,user_id));
      CREATE TABLE sessions(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE items(id TEXT PRIMARY KEY, shelf_id TEXT REFERENCES shelves(id) ON DELETE CASCADE, title TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT CHECK(mime_type IN ('application/pdf','video/mp4','video/webm')), size INTEGER NOT NULL, uploaded_by TEXT REFERENCES users(id), created_at INTEGER NOT NULL);
      CREATE TABLE playback_tickets(token_hash TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, item_id TEXT REFERENCES items(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      INSERT INTO users VALUES('user','migration@example.com','Existing user','hash',1);
      INSERT INTO shelves VALUES('shelf','Existing shelf','',1);
      INSERT INTO memberships VALUES('shelf','user','owner');
      INSERT INTO items VALUES('pdf','shelf','Existing PDF','book.pdf','application/pdf',100,'user',1);
      INSERT INTO sessions VALUES('session','session-hash','user',9999999999999);
      INSERT INTO playback_tickets VALUES('ticket-hash','session','pdf',9999999999999);
    `);
    db.close();
    db = openDatabase(filename);
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version,18);
    assert.equal(db.prepare('SELECT name FROM users').get().name, 'Existing user');
    assert.equal(db.prepare('SELECT title FROM items').get().title, 'Existing PDF');
    assert.equal(db.prepare('SELECT thumbnail_ready FROM items').get().thumbnail_ready, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM playback_tickets').get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.prepare(`INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at,page_count,thumbnail_ready)
      VALUES('images','shelf','Image book','p.png','application/vnd.mirea.image-book',200,'user',2,1,1)`).run();
    db.prepare("INSERT INTO image_pages(item_id,page_number,filename,size,width,height) VALUES('images',1,'p.png',200,100,150)").run();
    db.close();
    db = openDatabase(filename);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_pages').get().n, 1);
    db.prepare("DELETE FROM items WHERE id='images'").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_pages').get().n, 0);
    db.prepare("DELETE FROM items WHERE id='pdf'").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM playback_tickets').get().n, 0);
  } finally {
    db.close();
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep + 'mirea-migration-'));
    await rm(folder, { recursive: true, force: true });
  }
});

test('version 5 upgrade adds resume state without deleting detailed analytics',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'mirea-progress-migration-')),filename=join(folder,'migration.sqlite');
  let db=openDatabase(filename);
  try{
    db.exec(`DROP TABLE asset_progress;UPDATE schema_version SET version=5;
      INSERT INTO analytics_views(id,user_id,asset_id,shelf_id,asset_kind,asset_title,page_count,context,platform,client_version,auth_session_id,opened_at,first_received_at,last_received_at)
      VALUES('view','old-user','old-item','old-shelf','pdf','Preserved',3,'viewer','web','test','old-session',1,1,1);
      INSERT INTO analytics_events(event_id,view_id,seq,event_type,client_at,received_at,elapsed_ms,interval_ms,visible_ms,active_ms,watch_ms,payload_json,payload_hash)
      VALUES('event','view',1,'open',1,1,0,0,0,0,0,'{}','hash');`);
    db.close();db=openDatabase(filename);
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version,18);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM asset_progress').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM analytics_events').get().n,1);
    assert.equal(db.prepare('SELECT asset_title FROM analytics_views').get().asset_title,'Preserved');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();await rm(folder,{recursive:true,force:true});}
});

test('version 7 upgrade adds empty series without altering existing assets, progress, downloads or raw history',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'mirea-series-migration-')),filename=join(folder,'migration.sqlite');
  let db=openDatabase(filename);
  try{
    db.exec(`INSERT INTO users VALUES('user','series-migration@example.test','Existing','hash',1);
      INSERT INTO shelves VALUES('shelf','Existing shelf','',1);
      INSERT INTO memberships VALUES('shelf','user','owner');
      INSERT INTO items(id,shelf_id,title,filename,mime_type,size,uploaded_by,created_at) VALUES('item','shelf','Keep PDF','book.pdf','application/pdf',100,'user',1);
      INSERT INTO asset_progress(user_id,asset_id,revision,update_id,payload_hash,page_number,updated_at) VALUES('user','item',3,'update','hash',1,42);
      INSERT INTO encrypted_downloads VALUES('download','user','item','{"keep":"manifest"}',1);
      INSERT INTO analytics_views(id,user_id,asset_id,shelf_id,asset_kind,asset_title,page_count,context,platform,client_version,auth_session_id,opened_at,first_received_at,last_received_at)
        VALUES('view','user','item','shelf','pdf','Keep PDF',1,'viewer','web','test','session',1,1,1);
      INSERT INTO analytics_events(event_id,view_id,seq,event_type,client_at,received_at,elapsed_ms,interval_ms,visible_ms,active_ms,watch_ms,payload_json,payload_hash)
        VALUES('event','view',1,'open',1,1,0,0,0,0,0,'{}','hash');
      DROP TRIGGER series_asset_shelf_update;
      DROP TABLE series_items;
      DROP TABLE series;
      UPDATE schema_version SET version=7;`);
    const tables=['users','memberships','items','asset_progress','encrypted_downloads','analytics_views','analytics_events'];
    const before=tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all());
    db.close();db=openDatabase(filename);
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version,18);
    tables.forEach((table,index)=>assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(),before[index],table));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM series').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM series_items').get().n,0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();await rm(folder,{recursive:true,force:true});}
});

for (const oldVersion of [8,9]) test(`real version ${oldVersion} item-table rebuild preserves every child row and series guards, then safely clears deleted uploader attribution`,async()=>{
  const folder=await mkdtemp(join(tmpdir(),'mirea-account-migration-')),filename=join(folder,'migration.sqlite');
  let db=openDatabase(filename);
  try{
    db.exec(`INSERT INTO users VALUES('u','u@example.test','Uploader','hash',1),('v','v@example.test','Viewer','hash',1);
      INSERT INTO shelves VALUES('s','Shared','',1),('other','Other','',1);
      INSERT INTO memberships VALUES('s','v','owner'),('s','u','editor');
      INSERT INTO sessions VALUES('session','token','v',9999999999999);
      INSERT INTO items VALUES('i','s','Images','p.png','application/vnd.mirea.image-book',100,'u',1,1,1);
      INSERT INTO image_pages VALUES('i',1,'p.png',100,50,70,'image/png');
      INSERT INTO playback_tickets VALUES('ticket','session','i',9999999999999);
      INSERT INTO asset_progress(user_id,asset_id,revision,update_id,payload_hash,page_number,updated_at) VALUES('v','i',2,'id','hash',1,1);
      INSERT INTO encrypted_downloads VALUES('download','v','i','{}',1);
      INSERT INTO series(id,shelf_id,title,description,revision,created_at,updated_at) VALUES('series','s','Series','',1,1,1);
      INSERT INTO series_items VALUES('series','i',1,'Volume');`);
    const oldDefinition=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='items'").get().sql
      .replace('CREATE TABLE "items"','CREATE TABLE items_v8').replace('CREATE TABLE items (','CREATE TABLE items_v8 (')
      .replace(",'application/epub+zip'",'')
      .replace('uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL',oldVersion===8?'uploaded_by TEXT NOT NULL REFERENCES users(id)':'uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL');
    assert.match(oldDefinition,/CREATE TABLE items_v8/);
    const guards=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'series_%'").all();
    db.exec('PRAGMA foreign_keys=OFF');
    for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'series_%'").all())db.exec(`DROP TRIGGER ${name}`);
    db.exec(`${oldDefinition};INSERT INTO items_v8 SELECT * FROM items;DROP TABLE items;ALTER TABLE items_v8 RENAME TO items;UPDATE schema_version SET version=${oldVersion};`);
    for(const {sql} of guards)db.exec(sql);
    const tables=['users','shelves','memberships','sessions','items','image_pages','playback_tickets','asset_progress','encrypted_downloads','series','series_items'];
    const before=tables.map(table=>db.prepare(`SELECT * FROM ${table}`).all());
    db.close();db=openDatabase(filename);
    tables.forEach((table,index)=>assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(),before[index],table));
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version,18);
    db.prepare("INSERT INTO items VALUES('epub','s','EPUB','book.epub','application/epub+zip',100,NULL,1,2,1)").run();
    assert.throws(()=>db.prepare("UPDATE items SET shelf_id='other' WHERE id='i'").run(),/before moving/);
    assert.throws(()=>db.prepare("UPDATE series SET shelf_id='other' WHERE id='series'").run(),/before moving/);
    db.prepare("DELETE FROM users WHERE id='u'").run();
    assert.equal(db.prepare("SELECT uploaded_by FROM items WHERE id='i'").get().uploaded_by,null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM series_items').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM image_pages').get().n,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();await rm(folder,{recursive:true,force:true});}
});

test('v10 to current preserves existing download IDs/manifests and upload retention defaults, without altering existing asset rows',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'mirea-video-migration-')),filename=join(folder,'migration.sqlite');let db=openDatabase(filename);
  try{
    db.exec(`INSERT INTO users VALUES('u','video-migration@example.test','User','hash',1);
      INSERT INTO shelves VALUES('s','Shelf','',1);
      INSERT INTO memberships VALUES('s','u','owner');
      INSERT INTO items VALUES('i','s','Legacy video','legacy.webm','video/webm',42,'u',1,1,1);
      DROP TABLE video_assets;
      DROP TABLE encrypted_downloads;
      CREATE TABLE encrypted_downloads(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,manifest_json TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(user_id,asset_id));
      INSERT INTO encrypted_downloads VALUES('download','u','i','{"legacy":"preserved"}',1);
      DROP TABLE upload_parts;
      DROP TABLE upload_sessions;
      CREATE TABLE upload_sessions(id TEXT PRIMARY KEY,shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id TEXT NOT NULL,title TEXT NOT NULL,files_json TEXT NOT NULL,chunk_size INTEGER NOT NULL,state TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      INSERT INTO upload_sessions VALUES('upload','s','u','session','Old upload','[]',8388608,'uploading',NULL,1,9999999999999);
      UPDATE schema_version SET version=10;`);
    const items=db.prepare('SELECT * FROM items').all(),downloads=db.prepare('SELECT * FROM encrypted_downloads').all();db.close();db=openDatabase(filename);
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version,18);
    assert.deepEqual(db.prepare('SELECT * FROM items').all(),items);assert.deepEqual(db.prepare('SELECT * FROM encrypted_downloads').all(),downloads);
    assert.equal(db.prepare('SELECT retain_original FROM upload_sessions').get().retain_original,0);
    db.exec(`INSERT INTO encrypted_downloads VALUES('another-quality','u','i','{}',2)`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM encrypted_downloads').get().n,2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();await rm(folder,{recursive:true,force:true});}
});
