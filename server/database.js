import { DatabaseSync } from 'node:sqlite';
import {orderSeriesItems} from './series-order.js';

export function openDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shelves (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memberships (
      shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
      PRIMARY KEY (shelf_id, user_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_owner_per_shelf ON memberships(shelf_id) WHERE role = 'owner';
    CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'video/mp4', 'video/webm')),
      size INTEGER NOT NULL CHECK (size > 0),
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS items_shelf ON items(shelf_id, created_at);
    CREATE TABLE IF NOT EXISTS playback_tickets (
      token_hash TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `);
  const { version } = db.prepare('SELECT version FROM schema_version').get();
  if (version === 1) {
    // Rebuild the MIME constraint without deleting tickets that refer to existing items.
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => db.exec(`
        CREATE TABLE items_v2 (
          id TEXT PRIMARY KEY,
          shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'video/mp4', 'video/webm', 'application/vnd.mirea.image-book')),
          size INTEGER NOT NULL CHECK (size > 0),
          uploaded_by TEXT NOT NULL REFERENCES users(id),
          created_at INTEGER NOT NULL,
          page_count INTEGER NOT NULL DEFAULT 1 CHECK (page_count > 0),
          thumbnail_ready INTEGER NOT NULL DEFAULT 0 CHECK (thumbnail_ready IN (0, 1))
        );
        INSERT INTO items_v2 (id, shelf_id, title, filename, mime_type, size, uploaded_by, created_at)
          SELECT id, shelf_id, title, filename, mime_type, size, uploaded_by, created_at FROM items;
        DROP TABLE items;
        ALTER TABLE items_v2 RENAME TO items;
        CREATE INDEX items_shelf ON items(shelf_id, created_at);
        UPDATE schema_version SET version = 2;
      `));
    } finally { db.exec('PRAGMA foreign_keys = ON'); }
  } else if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,21,22,23].includes(version)) throw new Error(`Unsupported database schema: ${version}`);
  if (version < 10) {
    // v10 adds EPUB while retaining v9's nullable uploader attribution.
    // Account deletion removes attribution, not another member's shared assets.
    // Disable FK actions only while replacing the parent table, preserving all
    // child rows; recreate the series guards below before serving requests.
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => db.exec(`
        DROP TRIGGER IF EXISTS series_same_shelf_insert;
        DROP TRIGGER IF EXISTS series_same_shelf_update;
        DROP TRIGGER IF EXISTS series_asset_shelf_update;
        DROP TRIGGER IF EXISTS series_shelf_update;
        DROP TRIGGER IF EXISTS series_asset_removed;
        CREATE TABLE items_v10 (
          id TEXT PRIMARY KEY, shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
          title TEXT NOT NULL, filename TEXT NOT NULL,
          mime_type TEXT NOT NULL CHECK(mime_type IN ('application/pdf','video/mp4','video/webm','application/vnd.mirea.image-book','application/epub+zip')),
          size INTEGER NOT NULL CHECK(size > 0), uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL, page_count INTEGER NOT NULL DEFAULT 1 CHECK(page_count > 0),
          thumbnail_ready INTEGER NOT NULL DEFAULT 0 CHECK(thumbnail_ready IN (0,1))
        );
        INSERT INTO items_v10 SELECT * FROM items;
        DROP TABLE items;
        ALTER TABLE items_v10 RENAME TO items;
        CREATE INDEX items_shelf ON items(shelf_id,created_at);
        UPDATE schema_version SET version=10;
      `));
    } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }

  if (version < 12) {
    // Replace only the MIME constraint; preserve all dependent IDs and rows.
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => db.exec(`
        DROP TRIGGER IF EXISTS series_same_shelf_insert;
        DROP TRIGGER IF EXISTS series_same_shelf_update;
        DROP TRIGGER IF EXISTS series_asset_shelf_update;
        DROP TRIGGER IF EXISTS series_shelf_update;
        DROP TRIGGER IF EXISTS series_asset_removed;
        CREATE TABLE items_v12 (
          id TEXT PRIMARY KEY, shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
          title TEXT NOT NULL, filename TEXT NOT NULL,
          mime_type TEXT NOT NULL CHECK(mime_type IN ('application/pdf','video/mp4','video/webm','application/vnd.mirea.image-book','application/epub+zip','audio/mp4')),
          size INTEGER NOT NULL CHECK(size > 0), uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL, page_count INTEGER NOT NULL DEFAULT 1 CHECK(page_count > 0),
          thumbnail_ready INTEGER NOT NULL DEFAULT 0 CHECK(thumbnail_ready IN (0,1))
        );
        INSERT INTO items_v12 SELECT * FROM items;
        DROP TABLE items;
        ALTER TABLE items_v12 RENAME TO items;
        CREATE INDEX items_shelf ON items(shelf_id,created_at);
        UPDATE schema_version SET version=12;
      `));
    } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_pages (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL CHECK (page_number > 0),
      filename TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size > 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      mime_type TEXT NOT NULL DEFAULT 'image/jpeg' CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
      PRIMARY KEY (item_id, page_number)
    );
  `);
  if (!db.prepare('PRAGMA table_info(image_pages)').all().some(column => column.name === 'mime_type')) {
    db.exec("ALTER TABLE image_pages ADD COLUMN mime_type TEXT NOT NULL DEFAULT 'image/jpeg' CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp'))");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      files_json TEXT NOT NULL,
      chunk_size INTEGER NOT NULL CHECK (chunk_size > 0),
      state TEXT NOT NULL CHECK (state IN ('uploading', 'processing', 'complete', 'failed', 'cancelled')),
      error TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS uploads_user ON upload_sessions(user_id, state);
    CREATE TABLE IF NOT EXISTS upload_parts (
      upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
      file_index INTEGER NOT NULL,
      part_index INTEGER NOT NULL,
      size INTEGER NOT NULL CHECK (size > 0),
      sha256 TEXT NOT NULL,
      PRIMARY KEY (upload_id, file_index, part_index)
    );
    CREATE TABLE IF NOT EXISTS analytics_views (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      shelf_id TEXT NOT NULL,
      asset_kind TEXT NOT NULL,
      asset_title TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      context TEXT NOT NULL CHECK (context IN ('viewer','preview')),
      platform TEXT NOT NULL CHECK (platform IN ('web','android')),
      client_version TEXT NOT NULL,
      auth_session_id TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      first_received_at INTEGER NOT NULL,
      last_received_at INTEGER NOT NULL,
      counted INTEGER NOT NULL DEFAULT 0,
      ended INTEGER NOT NULL DEFAULT 0,
      visible_ms INTEGER NOT NULL DEFAULT 0,
      active_ms INTEGER NOT NULL DEFAULT 0,
      watch_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS analytics_views_shelf ON analytics_views(shelf_id, context, opened_at);
    CREATE INDEX IF NOT EXISTS analytics_views_user ON analytics_views(user_id, opened_at);
    CREATE INDEX IF NOT EXISTS analytics_views_asset ON analytics_views(asset_id, context, opened_at);
    CREATE INDEX IF NOT EXISTS analytics_views_time ON analytics_views(opened_at);
    CREATE TABLE IF NOT EXISTS analytics_events (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      view_id TEXT NOT NULL REFERENCES analytics_views(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      client_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      elapsed_ms INTEGER NOT NULL,
      interval_ms INTEGER NOT NULL,
      visible_ms INTEGER NOT NULL,
      active_ms INTEGER NOT NULL,
      watch_ms INTEGER NOT NULL,
      from_ms REAL,
      to_ms REAL,
      page_number INTEGER,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      UNIQUE(view_id, seq)
    );
    CREATE INDEX IF NOT EXISTS analytics_events_view_time ON analytics_events(view_id, elapsed_ms);
    CREATE TABLE IF NOT EXISTS analytics_video_bins (
      view_id TEXT NOT NULL REFERENCES analytics_views(id) ON DELETE CASCADE,
      start_ms INTEGER NOT NULL,
      watch_ms REAL NOT NULL,
      media_ms REAL NOT NULL,
      PRIMARY KEY(view_id,start_ms)
    );
    CREATE TABLE IF NOT EXISTS analytics_pages (
      view_id TEXT NOT NULL REFERENCES analytics_views(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL,
      visits INTEGER NOT NULL,
      visible_ms INTEGER NOT NULL,
      active_ms INTEGER NOT NULL,
      PRIMARY KEY(view_id,page_number)
    );
    CREATE TABLE IF NOT EXISTS asset_progress (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision > 0),
      update_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      position_ms INTEGER,
      duration_ms INTEGER,
      page_number INTEGER,
      scroll_x REAL,
      scroll_y REAL,
      zoom TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,asset_id)
    );
    CREATE TABLE IF NOT EXISTS encrypted_downloads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      manifest_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS series (
      id TEXT PRIMARY KEY,
      shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS series_shelf ON series(shelf_id, title);
    CREATE TABLE IF NOT EXISTS series_items (
      series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position > 0),
      label TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(series_id, position)
    );
    CREATE TRIGGER IF NOT EXISTS series_same_shelf_insert BEFORE INSERT ON series_items
      WHEN (SELECT shelf_id FROM series WHERE id=NEW.series_id) != (SELECT shelf_id FROM items WHERE id=NEW.asset_id)
      BEGIN SELECT RAISE(ABORT, 'Series and asset must share a shelf'); END;
    CREATE TRIGGER IF NOT EXISTS series_same_shelf_update BEFORE UPDATE ON series_items
      WHEN (SELECT shelf_id FROM series WHERE id=NEW.series_id) != (SELECT shelf_id FROM items WHERE id=NEW.asset_id)
      BEGIN SELECT RAISE(ABORT, 'Series and asset must share a shelf'); END;
    CREATE TRIGGER IF NOT EXISTS series_asset_shelf_update BEFORE UPDATE OF shelf_id ON items
      WHEN EXISTS(SELECT 1 FROM series_items si JOIN series s ON s.id=si.series_id WHERE si.asset_id=NEW.id AND s.shelf_id!=NEW.shelf_id)
      BEGIN SELECT RAISE(ABORT, 'Remove series membership before moving asset'); END;
    CREATE TRIGGER IF NOT EXISTS series_shelf_update BEFORE UPDATE OF shelf_id ON series
      WHEN EXISTS(SELECT 1 FROM series_items si JOIN items i ON i.id=si.asset_id WHERE si.series_id=NEW.id AND i.shelf_id!=NEW.shelf_id)
      BEGIN SELECT RAISE(ABORT, 'Remove assets before moving series'); END;
    CREATE TRIGGER IF NOT EXISTS series_asset_removed AFTER DELETE ON series_items
      BEGIN UPDATE series SET revision=revision+1 WHERE id=OLD.series_id; END;
    CREATE TABLE IF NOT EXISTS video_assets (
      item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      metadata_json TEXT NOT NULL,
      original_retained INTEGER NOT NULL CHECK(original_retained IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS audio_assets (
      item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      metadata_json TEXT NOT NULL,
      original_retained INTEGER NOT NULL CHECK(original_retained IN (0,1))
    );
    UPDATE schema_version SET version=13;
  `);
  // Multiple devices may save different qualities. Preserve every old manifest
  // ID/key binding while removing the former one-registration-per-asset limit.
  if(/UNIQUE\s*\(user_id,\s*asset_id\)/i.test(db.prepare("SELECT sql FROM sqlite_master WHERE name='encrypted_downloads'").get().sql))transaction(db,()=>db.exec(`
    CREATE TABLE encrypted_downloads_v11 (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,manifest_json TEXT NOT NULL,created_at INTEGER NOT NULL
    );
    INSERT INTO encrypted_downloads_v11 SELECT * FROM encrypted_downloads;
    DROP TABLE encrypted_downloads;
    ALTER TABLE encrypted_downloads_v11 RENAME TO encrypted_downloads;
  `));
  db.exec('CREATE INDEX IF NOT EXISTS downloads_user_asset ON encrypted_downloads(user_id,asset_id)');
  const uploadColumns = db.prepare('PRAGMA table_info(upload_sessions)').all();
  if (!uploadColumns.some(column => column.name === 'retain_original')) db.exec('ALTER TABLE upload_sessions ADD COLUMN retain_original INTEGER NOT NULL DEFAULT 0 CHECK(retain_original IN (0,1))');
  if (!uploadColumns.some(column => column.name === 'processing_json')) db.exec("ALTER TABLE upload_sessions ADD COLUMN processing_json TEXT NOT NULL DEFAULT '{}'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_access (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      server_role TEXT NOT NULL CHECK(server_role IN ('admin','user')),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS admin_jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL,
      asset_id TEXT REFERENCES items(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','complete','failed')),
      progress_json TEXT NOT NULL DEFAULT '{}', error TEXT,
      requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      output_size INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS admin_asset_job ON admin_jobs(asset_id)
      WHERE state IN ('queued','running') AND asset_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
      target_id TEXT, detail_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_generations (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      generation TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(item_id,generation)
    );
    CREATE TABLE IF NOT EXISTS playback_generations (
      token_hash TEXT PRIMARY KEY REFERENCES playback_tickets(token_hash) ON DELETE CASCADE,
      generation TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_upload_retries (
      upload_id TEXT PRIMARY KEY REFERENCES upload_sessions(id) ON DELETE CASCADE,
      admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
  db.exec(`CREATE TABLE IF NOT EXISTS video_navigation (
    item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK(state IN ('queued','running','ready','failed')), job_id TEXT REFERENCES admin_jobs(id) ON DELETE SET NULL,
    requester_id TEXT REFERENCES users(id) ON DELETE SET NULL, duration_ms INTEGER NOT NULL DEFAULT 0,
    chapters_json TEXT NOT NULL DEFAULT '[]', chapters_manual INTEGER NOT NULL DEFAULT 0,
    captions_json TEXT NOT NULL DEFAULT '[]', storyboard_json TEXT, storyboard BLOB, error TEXT, updated_at INTEGER NOT NULL
  ); UPDATE schema_version SET version=14;`);
  db.exec(`CREATE TABLE IF NOT EXISTS analytics_replay_bins (
    view_id TEXT NOT NULL REFERENCES analytics_views(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,media_ms REAL NOT NULL,PRIMARY KEY(view_id,start_ms)
  );CREATE TABLE IF NOT EXISTS analytics_replay_state (
    view_id TEXT PRIMARY KEY REFERENCES analytics_views(id) ON DELETE CASCADE,state_json TEXT NOT NULL
  );CREATE INDEX IF NOT EXISTS analytics_events_view_arrival ON analytics_events(view_id,row_id);
  UPDATE schema_version SET version=15;`);
  // Additive v16 migration: keep every asset, key, history and old series row.
  transaction(db,()=>{
    if(!db.prepare('PRAGMA table_info(series)').all().some(c=>c.name==='parent_id'))db.exec('ALTER TABLE series ADD COLUMN parent_id TEXT REFERENCES series(id) ON DELETE SET NULL');
    const columns=db.prepare('PRAGMA table_info(upload_sessions)').all();
    if(!columns.some(c=>c.name==='target_series_id'))db.exec('ALTER TABLE upload_sessions ADD COLUMN target_series_id TEXT REFERENCES series(id) ON DELETE SET NULL');
    if(!columns.some(c=>c.name==='series_requested'))db.exec('ALTER TABLE upload_sessions ADD COLUMN series_requested INTEGER NOT NULL DEFAULT 0');
    if(!columns.some(c=>c.name==='series_warning'))db.exec("ALTER TABLE upload_sessions ADD COLUMN series_warning TEXT NOT NULL DEFAULT ''");
    db.exec(`CREATE INDEX IF NOT EXISTS series_parent ON series(parent_id);
      CREATE TABLE IF NOT EXISTS series_create_requests(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id TEXT NOT NULL,series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,PRIMARY KEY(user_id,request_id));
      CREATE TRIGGER IF NOT EXISTS series_parent_insert BEFORE INSERT ON series WHEN NEW.parent_id IS NOT NULL BEGIN
        SELECT CASE WHEN NEW.parent_id=NEW.id OR NOT EXISTS(SELECT 1 FROM series WHERE id=NEW.parent_id AND shelf_id=NEW.shelf_id) THEN RAISE(ABORT,'Invalid series parent') END;
      END;
      CREATE TRIGGER IF NOT EXISTS series_parent_update BEFORE UPDATE OF parent_id ON series WHEN NEW.parent_id IS NOT NULL BEGIN
        SELECT CASE WHEN NEW.parent_id=NEW.id OR NOT EXISTS(SELECT 1 FROM series WHERE id=NEW.parent_id AND shelf_id=NEW.shelf_id) THEN RAISE(ABORT,'Invalid series parent') END;
        SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id) AS (SELECT NEW.parent_id UNION SELECT s.parent_id FROM series s JOIN ancestors a ON s.id=a.id WHERE s.parent_id IS NOT NULL) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'Series hierarchy cycle') END;
      END;
      CREATE TRIGGER IF NOT EXISTS series_tree_shelf_update BEFORE UPDATE OF shelf_id ON series WHEN EXISTS(SELECT 1 FROM series WHERE id=NEW.parent_id AND shelf_id!=NEW.shelf_id) OR EXISTS(SELECT 1 FROM series WHERE parent_id=NEW.id AND shelf_id!=NEW.shelf_id) BEGIN SELECT RAISE(ABORT,'Detach series hierarchy before moving shelves');END;
      CREATE TRIGGER IF NOT EXISTS series_parent_changed AFTER UPDATE OF parent_id ON series WHEN OLD.parent_id IS NOT NEW.parent_id BEGIN UPDATE series SET revision=revision+1,updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=NEW.id;END;
      UPDATE schema_version SET version=16;`);
  });
  db.exec(`CREATE TABLE IF NOT EXISTS thumbnail_overrides(asset_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,image_id TEXT NOT NULL,updated_at INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS thumbnail_image ON thumbnail_overrides(image_id);UPDATE schema_version SET version=17;`);
  transaction(db,()=>db.exec(`
    CREATE TABLE IF NOT EXISTS playlists(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS playlists_user ON playlists(user_id,updated_at);
    CREATE TABLE IF NOT EXISTS playlist_items(playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,position INTEGER NOT NULL,
      PRIMARY KEY(playlist_id,asset_id),UNIQUE(playlist_id,position));
    UPDATE schema_version SET version=18;
  `));
  transaction(db,()=>{
    if(!db.prepare('PRAGMA table_info(shelves)').all().some(c=>c.name==='private'))db.exec('ALTER TABLE shelves ADD COLUMN private INTEGER NOT NULL DEFAULT 0 CHECK(private IN (0,1))');
    db.exec(`CREATE TABLE IF NOT EXISTS server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_hidden(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,asset_id TEXT NOT NULL,hidden_at INTEGER NOT NULL,PRIMARY KEY(user_id,asset_id));
      CREATE TABLE IF NOT EXISTS bootstrap_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,initial_hash TEXT NOT NULL);
      UPDATE schema_version SET version=19;`);
    // Preserve existing duplicate paths without renaming or merging the owner's data.
    // Triggers reject NEW collisions, while allowing unrelated edits to old rows.
    db.exec(`CREATE TRIGGER IF NOT EXISTS series_unique_path_insert BEFORE INSERT ON series
      WHEN EXISTS(SELECT 1 FROM series WHERE shelf_id=NEW.shelf_id AND parent_id IS NEW.parent_id AND title=NEW.title)
      BEGIN SELECT RAISE(ABORT,'Duplicate series path');END;
      CREATE TRIGGER IF NOT EXISTS series_unique_path_update BEFORE UPDATE OF title,parent_id,shelf_id ON series
      WHEN (NEW.title!=OLD.title OR NEW.parent_id IS NOT OLD.parent_id OR NEW.shelf_id!=OLD.shelf_id) AND EXISTS(SELECT 1 FROM series WHERE id!=NEW.id AND shelf_id=NEW.shelf_id AND parent_id IS NEW.parent_id AND title=NEW.title)
      BEGIN SELECT RAISE(ABORT,'Duplicate series path');END;`);
  });
  db.exec(`CREATE TABLE IF NOT EXISTS video_thumbnail_state(
    asset_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    position_seconds REAL NOT NULL CHECK(position_seconds>=0),
    preview_position_seconds REAL,preview_version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );UPDATE schema_version SET version=20;`);
  transaction(db,()=>db.exec(`
    CREATE TABLE IF NOT EXISTS media_ingest(
      asset_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      source_mime TEXT NOT NULL,source_filename TEXT NOT NULL,source_size INTEGER NOT NULL,
      retain_original INTEGER NOT NULL CHECK(retain_original IN (0,1)),
      canonical_ready INTEGER NOT NULL DEFAULT 0,source_removed INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL,created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_tasks(
      id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('thumbnail','transcode','preview')),
      state TEXT NOT NULL CHECK(state IN ('queued','running','complete','failed','cancelled')),
      progress_json TEXT NOT NULL DEFAULT '{}',error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(asset_id,kind)
    );
    CREATE INDEX IF NOT EXISTS media_tasks_queue ON media_tasks(kind,state,created_at);
    CREATE TABLE IF NOT EXISTS shelf_unlocks(token_hash TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,password_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shelf_biometric_keys(id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,public_key TEXT NOT NULL,password_hash TEXT NOT NULL,PRIMARY KEY(id,user_id));
    CREATE TABLE IF NOT EXISTS shelf_challenges(challenge TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,key_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    UPDATE schema_version SET version=21;
  `));
  transaction(db,()=>db.exec(`
    CREATE TABLE IF NOT EXISTS upload_queue(
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
      series_id TEXT REFERENCES series(id) ON DELETE SET NULL,title TEXT NOT NULL,mime_type TEXT NOT NULL,
      total_bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      upload_id TEXT UNIQUE REFERENCES upload_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS upload_queue_user ON upload_queue(user_id,expires_at);
    UPDATE schema_version SET version=22;
  `));
  transaction(db,()=>{
    if(!db.prepare('PRAGMA table_info(series)').all().some(row=>row.name==='order_mode')){
      db.exec("ALTER TABLE series ADD COLUMN order_mode TEXT NOT NULL DEFAULT 'name' CHECK(order_mode IN ('name','manual'))");
      for(const row of db.prepare('SELECT id FROM series').all()){orderSeriesItems(db,row.id,{force:true});db.prepare('UPDATE series SET revision=revision+1,updated_at=? WHERE id=?').run(Date.now(),row.id);}
    }
    db.exec('UPDATE schema_version SET version=23');
  });
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database foreign key validation failed');
  return db;
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
