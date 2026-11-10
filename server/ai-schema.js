// AI metadata belongs to the library. Models remain separately installed files.
export function initializeAiSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_policies (
      shelf_id TEXT PRIMARY KEY REFERENCES shelves(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      features_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_models (
      id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL,
      state TEXT NOT NULL, progress_json TEXT NOT NULL DEFAULT '{}',
      accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      accepted_at INTEGER NOT NULL, license_hash TEXT NOT NULL,
      error_code TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_jobs (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      requester_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      feature TEXT NOT NULL, model_id TEXT NOT NULL,
      input_stamp TEXT NOT NULL, profile_hash TEXT NOT NULL,
      state TEXT NOT NULL, automatic INTEGER NOT NULL DEFAULT 0,
      checkpoint INTEGER NOT NULL DEFAULT 0, total_units INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, updated_at INTEGER NOT NULL,
      finished_at INTEGER, lease TEXT
    );
    CREATE INDEX IF NOT EXISTS ai_jobs_queue ON ai_jobs(state,updated_at,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS ai_job_active ON
      ai_jobs(asset_id,feature,input_stamp,profile_hash)
      WHERE state IN ('queued','running','paused','resource-wait','dependency-wait');
    CREATE TABLE IF NOT EXISTS ai_batches (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,features_json TEXT NOT NULL,regenerate INTEGER NOT NULL,
      state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS ai_batch_assets (
      batch_id TEXT NOT NULL REFERENCES ai_batches(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,state TEXT NOT NULL DEFAULT 'queued',error_code TEXT,
      PRIMARY KEY(batch_id,asset_id)
    );
    CREATE INDEX IF NOT EXISTS ai_batch_queue ON ai_batch_assets(batch_id,state);
    CREATE TABLE IF NOT EXISTS ai_requests (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS ai_units (
      job_id TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
      unit INTEGER NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(job_id,unit)
    );
    CREATE TABLE IF NOT EXISTS ai_results (
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      feature TEXT NOT NULL, revision INTEGER NOT NULL,
      input_stamp TEXT NOT NULL, model_id TEXT NOT NULL,
      result_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(asset_id,feature)
    );
    CREATE TABLE IF NOT EXISTS ai_result_units (
      asset_id TEXT NOT NULL,feature TEXT NOT NULL,unit INTEGER NOT NULL,result_json TEXT NOT NULL,
      PRIMARY KEY(asset_id,feature,unit),FOREIGN KEY(asset_id,feature) REFERENCES ai_results(asset_id,feature) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ai_result_locations (
      asset_id TEXT NOT NULL,feature TEXT NOT NULL,block_id TEXT NOT NULL,unit INTEGER NOT NULL,
      PRIMARY KEY(asset_id,feature,block_id),FOREIGN KEY(asset_id,feature,unit) REFERENCES ai_result_units(asset_id,feature,unit) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ai_edits (
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      feature TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      patch_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL,
      PRIMARY KEY(asset_id,feature)
    );
    CREATE TABLE IF NOT EXISTS ai_edit_history (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      feature TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      revision INTEGER NOT NULL, patch_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(asset_id,feature,request_id)
    );
    CREATE TABLE IF NOT EXISTS asset_tags (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL, normalized TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL, rejected INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS asset_tags_key
      ON asset_tags(asset_id,COALESCE(user_id,''),normalized);
    CREATE INDEX IF NOT EXISTS asset_tags_name ON asset_tags(normalized,asset_id);
    CREATE TABLE IF NOT EXISTS ai_documents (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      feature TEXT NOT NULL, locator_json TEXT NOT NULL,
      text TEXT NOT NULL, normalized TEXT NOT NULL,
      vector BLOB, vector_space TEXT, revision INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_documents_asset ON ai_documents(asset_id,feature);
    CREATE VIRTUAL TABLE IF NOT EXISTS ai_documents_fts USING fts5(
      normalized,content='ai_documents',content_rowid='rowid',tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS ai_document_insert AFTER INSERT ON ai_documents BEGIN
      INSERT INTO ai_documents_fts(rowid,normalized) VALUES(new.rowid,new.normalized);
    END;
    CREATE TRIGGER IF NOT EXISTS ai_document_delete AFTER DELETE ON ai_documents BEGIN
      INSERT INTO ai_documents_fts(ai_documents_fts,rowid,normalized)
        VALUES('delete',old.rowid,old.normalized);
    END;
    CREATE TRIGGER IF NOT EXISTS ai_document_update AFTER UPDATE OF normalized ON ai_documents BEGIN
      INSERT INTO ai_documents_fts(ai_documents_fts,rowid,normalized)
        VALUES('delete',old.rowid,old.normalized);
      INSERT INTO ai_documents_fts(rowid,normalized) VALUES(new.rowid,new.normalized);
    END;
    CREATE TABLE IF NOT EXISTS ai_smart_lists (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, filter_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
}
