# SQLite スキーマ参照

[設計書の入口](overview.md) · [データ設計](data-model.md)

この参照表は server/database.js を空のインメモリDBへ適用して生成します。既存のデータ領域・利用者レコードは読みません。現在のスキーマ番号は **26**、アプリケーションテーブルは **63個**です。FTS仮想表を含み、FTSのshadow表、移行途中の置換表、SQLite内部表は含みません。

再生成: リポジトリ直下で node scripts/generate-schema-docs.mjs。差分確認のみ: node scripts/generate-schema-docs.mjs --check。この資料は作業ツリーの定義を示します。配布版を調べる場合は対応するGitタグの資料を参照してください。

## テーブル一覧

- [admin_audit](#admin-audit)
- [admin_jobs](#admin-jobs)
- [admin_upload_retries](#admin-upload-retries)
- [ai_batch_assets](#ai-batch-assets)
- [ai_batches](#ai-batches)
- [ai_documents](#ai-documents)
- [ai_documents_fts](#ai-documents-fts)
- [ai_edit_history](#ai-edit-history)
- [ai_edits](#ai-edits)
- [ai_jobs](#ai-jobs)
- [ai_models](#ai-models)
- [ai_policies](#ai-policies)
- [ai_requests](#ai-requests)
- [ai_result_locations](#ai-result-locations)
- [ai_result_units](#ai-result-units)
- [ai_results](#ai-results)
- [ai_smart_lists](#ai-smart-lists)
- [ai_units](#ai-units)
- [analytics_events](#analytics-events)
- [analytics_pages](#analytics-pages)
- [analytics_replay_bins](#analytics-replay-bins)
- [analytics_replay_state](#analytics-replay-state)
- [analytics_video_bins](#analytics-video-bins)
- [analytics_views](#analytics-views)
- [asset_progress](#asset-progress)
- [asset_tags](#asset-tags)
- [audio_assets](#audio-assets)
- [bootstrap_accounts](#bootstrap-accounts)
- [diagnostic_batches](#diagnostic-batches)
- [encrypted_downloads](#encrypted-downloads)
- [history_hidden](#history-hidden)
- [image_pages](#image-pages)
- [items](#items)
- [job_timings](#job-timings)
- [manual_upload_starts](#manual-upload-starts)
- [media_ingest](#media-ingest)
- [media_tasks](#media-tasks)
- [memberships](#memberships)
- [playback_generations](#playback-generations)
- [playback_tickets](#playback-tickets)
- [playlist_items](#playlist-items)
- [playlists](#playlists)
- [schema_version](#schema-version)
- [series](#series)
- [series_create_requests](#series-create-requests)
- [series_items](#series-items)
- [server_settings](#server-settings)
- [sessions](#sessions)
- [shelf_biometric_keys](#shelf-biometric-keys)
- [shelf_challenges](#shelf-challenges)
- [shelf_unlocks](#shelf-unlocks)
- [shelves](#shelves)
- [thumbnail_overrides](#thumbnail-overrides)
- [transfer_hidden](#transfer-hidden)
- [upload_parts](#upload-parts)
- [upload_queue](#upload-queue)
- [upload_sessions](#upload-sessions)
- [user_access](#user-access)
- [users](#users)
- [video_assets](#video-assets)
- [video_generations](#video-generations)
- [video_navigation](#video-navigation)
- [video_thumbnail_state](#video-thumbnail-state)

## admin audit

テーブル名: `admin_audit`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | INTEGER | いいえ | — | 1 |
| actor_id | TEXT | いいえ | — | — |
| action | TEXT | はい | — | — |
| target_id | TEXT | いいえ | — | — |
| detail_json | TEXT | はい | '{}' | — |
| created_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

外部キーはありません。

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
      target_id TEXT, detail_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
```

</details>

## admin jobs

テーブル名: `admin_jobs`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| kind | TEXT | はい | — | — |
| asset_id | TEXT | いいえ | — | — |
| state | TEXT | はい | — | — |
| progress_json | TEXT | はい | '{}' | — |
| error | TEXT | いいえ | — | — |
| requested_by | TEXT | いいえ | — | — |
| created_at | INTEGER | はい | — | — |
| updated_at | INTEGER | はい | — | — |
| output_size | INTEGER | はい | 0 | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| requested_by | users.id | NO ACTION | SET NULL |
| asset_id | items.id | NO ACTION | SET NULL |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| admin_asset_job | はい | c | はい | asset_id |
| sqlite_autoindex_admin_jobs_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE admin_jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL,
      asset_id TEXT REFERENCES items(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','complete','failed')),
      progress_json TEXT NOT NULL DEFAULT '{}', error TEXT,
      requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      output_size INTEGER NOT NULL DEFAULT 0
    );
```

</details>

## admin upload retries

テーブル名: `admin_upload_retries`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| upload_id | TEXT | いいえ | — | 1 |
| admin_id | TEXT | はい | — | — |
| session_id | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| session_id | sessions.id | NO ACTION | CASCADE |
| admin_id | users.id | NO ACTION | CASCADE |
| upload_id | upload_sessions.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_admin_upload_retries_1 | はい | pk | いいえ | upload_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE admin_upload_retries (
      upload_id TEXT PRIMARY KEY REFERENCES upload_sessions(id) ON DELETE CASCADE,
      admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
    );
```

</details>

## ai batch assets

テーブル名: `ai_batch_assets`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| batch_id | TEXT | はい | — | 1 |
| asset_id | TEXT | はい | — | 2 |
| state | TEXT | はい | 'queued' | — |
| error_code | TEXT | いいえ | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |
| batch_id | ai_batches.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| ai_batch_queue | いいえ | c | いいえ | batch_id, state |
| sqlite_autoindex_ai_batch_assets_1 | はい | pk | いいえ | batch_id, asset_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_batch_assets (
      batch_id TEXT NOT NULL REFERENCES ai_batches(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,state TEXT NOT NULL DEFAULT 'queued',error_code TEXT,
      PRIMARY KEY(batch_id,asset_id)
    );
```

</details>

## ai batches

テーブル名: `ai_batches`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| user_id | TEXT | はい | — | — |
| request_id | TEXT | はい | — | — |
| payload_hash | TEXT | はい | — | — |
| features_json | TEXT | はい | — | — |
| regenerate | INTEGER | はい | — | — |
| state | TEXT | はい | — | — |
| created_at | INTEGER | はい | — | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_ai_batches_2 | はい | u | いいえ | user_id, request_id |
| sqlite_autoindex_ai_batches_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_batches (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,features_json TEXT NOT NULL,regenerate INTEGER NOT NULL,
      state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,request_id)
    );
```

</details>

## ai documents

テーブル名: `ai_documents`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| asset_id | TEXT | はい | — | — |
| feature | TEXT | はい | — | — |
| locator_json | TEXT | はい | — | — |
| text | TEXT | はい | — | — |
| normalized | TEXT | はい | — | — |
| vector | BLOB | いいえ | — | — |
| vector_space | TEXT | いいえ | — | — |
| revision | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| ai_documents_asset | いいえ | c | いいえ | asset_id, feature |
| sqlite_autoindex_ai_documents_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_documents (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      feature TEXT NOT NULL, locator_json TEXT NOT NULL,
      text TEXT NOT NULL, normalized TEXT NOT NULL,
      vector BLOB, vector_space TEXT, revision INTEGER NOT NULL
    );
```

</details>

## ai documents fts

テーブル名: `ai_documents_fts`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| normalized |  | いいえ | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

外部キーはありません。

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE VIRTUAL TABLE ai_documents_fts USING fts5(
      normalized,content='ai_documents',content_rowid='rowid',tokenize='trigram'
    );
```

</details>

## ai edit history

テーブル名: `ai_edit_history`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| asset_id | TEXT | はい | — | — |
| feature | TEXT | はい | — | — |
| user_id | TEXT | いいえ | — | — |
| request_id | TEXT | はい | — | — |
| payload_hash | TEXT | はい | — | — |
| revision | INTEGER | はい | — | — |
| patch_json | TEXT | はい | — | — |
| created_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | SET NULL |
| asset_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_ai_edit_history_2 | はい | u | いいえ | asset_id, feature, request_id |
| sqlite_autoindex_ai_edit_history_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_edit_history (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      feature TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      revision INTEGER NOT NULL, patch_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(asset_id,feature,request_id)
    );
```

</details>

## ai edits

テーブル名: `ai_edits`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| asset_id | TEXT | はい | — | 1 |
| feature | TEXT | はい | — | 2 |
| revision | INTEGER | はい | 0 | — |
| patch_json | TEXT | はい | '{}' | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_ai_edits_1 | はい | pk | いいえ | asset_id, feature |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_edits (
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      feature TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      patch_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL,
      PRIMARY KEY(asset_id,feature)
    );
```

</details>

## ai jobs

テーブル名: `ai_jobs`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| asset_id | TEXT | はい | — | — |
| requester_id | TEXT | いいえ | — | — |
| feature | TEXT | はい | — | — |
| model_id | TEXT | はい | — | — |
| input_stamp | TEXT | はい | — | — |
| profile_hash | TEXT | はい | — | — |
| state | TEXT | はい | — | — |
| automatic | INTEGER | はい | 0 | — |
| checkpoint | INTEGER | はい | 0 | — |
| total_units | INTEGER | いいえ | — | — |
| attempts | INTEGER | はい | 0 | — |
| error_code | TEXT | いいえ | — | — |
| created_at | INTEGER | はい | — | — |
| started_at | INTEGER | いいえ | — | — |
| updated_at | INTEGER | はい | — | — |
| finished_at | INTEGER | いいえ | — | — |
| lease | TEXT | いいえ | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| requester_id | users.id | NO ACTION | SET NULL |
| asset_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| ai_job_active | はい | c | はい | asset_id, feature, input_stamp, profile_hash |
| ai_jobs_queue | いいえ | c | いいえ | state, updated_at, created_at |
| sqlite_autoindex_ai_jobs_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_jobs (
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
```

</details>

## ai models

テーブル名: `ai_models`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| manifest_json | TEXT | はい | — | — |
| state | TEXT | はい | — | — |
| progress_json | TEXT | はい | '{}' | — |
| accepted_by | TEXT | いいえ | — | — |
| accepted_at | INTEGER | はい | — | — |
| license_hash | TEXT | はい | — | — |
| error_code | TEXT | いいえ | — | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| accepted_by | users.id | NO ACTION | SET NULL |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_ai_models_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_models (
      id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL,
      state TEXT NOT NULL, progress_json TEXT NOT NULL DEFAULT '{}',
      accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      accepted_at INTEGER NOT NULL, license_hash TEXT NOT NULL,
      error_code TEXT, updated_at INTEGER NOT NULL
    );
```

</details>

## ai policies

テーブル名: `ai_policies`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| shelf_id | TEXT | いいえ | — | 1 |
| enabled | INTEGER | はい | 0 | — |
| features_json | TEXT | はい | '[]' | — |
| revision | INTEGER | はい | 1 | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| shelf_id | shelves.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_ai_policies_1 | はい | pk | いいえ | shelf_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_policies (
      shelf_id TEXT PRIMARY KEY REFERENCES shelves(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      features_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );
```

</details>

## ai requests

テーブル名: `ai_requests`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| user_id | TEXT | はい | — | 1 |
| request_id | TEXT | はい | — | 2 |
| payload_hash | TEXT | はい | — | — |
| response_json | TEXT | はい | — | — |
| created_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_ai_requests_1 | はい | pk | いいえ | user_id, request_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_requests (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_id)
    );
```

</details>

## ai result locations

テーブル名: `ai_result_locations`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| asset_id | TEXT | はい | — | 1 |
| feature | TEXT | はい | — | 2 |
| block_id | TEXT | はい | — | 3 |
| unit | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | ai_result_units.asset_id | NO ACTION | CASCADE |
| feature | ai_result_units.feature | NO ACTION | CASCADE |
| unit | ai_result_units.unit | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_ai_result_locations_1 | はい | pk | いいえ | asset_id, feature, block_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_result_locations (
      asset_id TEXT NOT NULL,feature TEXT NOT NULL,block_id TEXT NOT NULL,unit INTEGER NOT NULL,
      PRIMARY KEY(asset_id,feature,block_id),FOREIGN KEY(asset_id,feature,unit) REFERENCES ai_result_units(asset_id,feature,unit) ON DELETE CASCADE
    );
```

</details>

## ai result units

テーブル名: `ai_result_units`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| asset_id | TEXT | はい | — | 1 |
| feature | TEXT | はい | — | 2 |
| unit | INTEGER | はい | — | 3 |
| result_json | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | ai_results.asset_id | NO ACTION | CASCADE |
| feature | ai_results.feature | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_ai_result_units_1 | はい | pk | いいえ | asset_id, feature, unit |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_result_units (
      asset_id TEXT NOT NULL,feature TEXT NOT NULL,unit INTEGER NOT NULL,result_json TEXT NOT NULL,
      PRIMARY KEY(asset_id,feature,unit),FOREIGN KEY(asset_id,feature) REFERENCES ai_results(asset_id,feature) ON DELETE CASCADE
    );
```

</details>

## ai results

テーブル名: `ai_results`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| asset_id | TEXT | はい | — | 1 |
| feature | TEXT | はい | — | 2 |
| revision | INTEGER | はい | — | — |
| input_stamp | TEXT | はい | — | — |
| model_id | TEXT | はい | — | — |
| result_json | TEXT | はい | — | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_ai_results_1 | はい | pk | いいえ | asset_id, feature |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_results (
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      feature TEXT NOT NULL, revision INTEGER NOT NULL,
      input_stamp TEXT NOT NULL, model_id TEXT NOT NULL,
      result_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(asset_id,feature)
    );
```

</details>

## ai smart lists

テーブル名: `ai_smart_lists`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| user_id | TEXT | はい | — | — |
| title | TEXT | はい | — | — |
| filter_json | TEXT | はい | — | — |
| revision | INTEGER | はい | 1 | — |
| created_at | INTEGER | はい | — | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_ai_smart_lists_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_smart_lists (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, filter_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
```

</details>

## ai units

テーブル名: `ai_units`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| job_id | TEXT | はい | — | 1 |
| unit | INTEGER | はい | — | 2 |
| result_json | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| job_id | ai_jobs.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_ai_units_1 | はい | pk | いいえ | job_id, unit |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE ai_units (
      job_id TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
      unit INTEGER NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(job_id,unit)
    );
```

</details>

## analytics events

テーブル名: `analytics_events`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| row_id | INTEGER | いいえ | — | 1 |
| event_id | TEXT | はい | — | — |
| view_id | TEXT | はい | — | — |
| seq | INTEGER | はい | — | — |
| event_type | TEXT | はい | — | — |
| client_at | INTEGER | はい | — | — |
| received_at | INTEGER | はい | — | — |
| elapsed_ms | INTEGER | はい | — | — |
| interval_ms | INTEGER | はい | — | — |
| visible_ms | INTEGER | はい | — | — |
| active_ms | INTEGER | はい | — | — |
| watch_ms | INTEGER | はい | — | — |
| from_ms | REAL | いいえ | — | — |
| to_ms | REAL | いいえ | — | — |
| page_number | INTEGER | いいえ | — | — |
| payload_json | TEXT | はい | — | — |
| payload_hash | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| view_id | analytics_views.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| analytics_events_view_arrival | いいえ | c | いいえ | view_id, row_id |
| analytics_events_view_time | いいえ | c | いいえ | view_id, elapsed_ms |
| sqlite_autoindex_analytics_events_2 | はい | u | いいえ | view_id, seq |
| sqlite_autoindex_analytics_events_1 | はい | u | いいえ | event_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE analytics_events (
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
```

</details>

## analytics pages

テーブル名: `analytics_pages`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| view_id | TEXT | はい | — | 1 |
| page_number | INTEGER | はい | — | 2 |
| visits | INTEGER | はい | — | — |
| visible_ms | INTEGER | はい | — | — |
| active_ms | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| view_id | analytics_views.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_analytics_pages_1 | はい | pk | いいえ | view_id, page_number |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE analytics_pages (
      view_id TEXT NOT NULL REFERENCES analytics_views(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL,
      visits INTEGER NOT NULL,
      visible_ms INTEGER NOT NULL,
      active_ms INTEGER NOT NULL,
      PRIMARY KEY(view_id,page_number)
    );
```

</details>

## analytics replay bins

テーブル名: `analytics_replay_bins`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| view_id | TEXT | はい | — | 1 |
| start_ms | INTEGER | はい | — | 2 |
| media_ms | REAL | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| view_id | analytics_views.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_analytics_replay_bins_1 | はい | pk | いいえ | view_id, start_ms |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE analytics_replay_bins (
    view_id TEXT NOT NULL REFERENCES analytics_views(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,media_ms REAL NOT NULL,PRIMARY KEY(view_id,start_ms)
  );
```

</details>

## analytics replay state

テーブル名: `analytics_replay_state`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| view_id | TEXT | いいえ | — | 1 |
| state_json | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| view_id | analytics_views.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_analytics_replay_state_1 | はい | pk | いいえ | view_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE analytics_replay_state (
    view_id TEXT PRIMARY KEY REFERENCES analytics_views(id) ON DELETE CASCADE,state_json TEXT NOT NULL
  );
```

</details>

## analytics video bins

テーブル名: `analytics_video_bins`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| view_id | TEXT | はい | — | 1 |
| start_ms | INTEGER | はい | — | 2 |
| watch_ms | REAL | はい | — | — |
| media_ms | REAL | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| view_id | analytics_views.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_analytics_video_bins_1 | はい | pk | いいえ | view_id, start_ms |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE analytics_video_bins (
      view_id TEXT NOT NULL REFERENCES analytics_views(id) ON DELETE CASCADE,
      start_ms INTEGER NOT NULL,
      watch_ms REAL NOT NULL,
      media_ms REAL NOT NULL,
      PRIMARY KEY(view_id,start_ms)
    );
```

</details>

## analytics views

テーブル名: `analytics_views`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| user_id | TEXT | はい | — | — |
| asset_id | TEXT | はい | — | — |
| shelf_id | TEXT | はい | — | — |
| asset_kind | TEXT | はい | — | — |
| asset_title | TEXT | はい | — | — |
| page_count | INTEGER | はい | — | — |
| context | TEXT | はい | — | — |
| platform | TEXT | はい | — | — |
| client_version | TEXT | はい | — | — |
| auth_session_id | TEXT | はい | — | — |
| opened_at | INTEGER | はい | — | — |
| first_received_at | INTEGER | はい | — | — |
| last_received_at | INTEGER | はい | — | — |
| counted | INTEGER | はい | 0 | — |
| ended | INTEGER | はい | 0 | — |
| visible_ms | INTEGER | はい | 0 | — |
| active_ms | INTEGER | はい | 0 | — |
| watch_ms | INTEGER | はい | 0 | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

外部キーはありません。

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| analytics_views_time | いいえ | c | いいえ | opened_at |
| analytics_views_asset | いいえ | c | いいえ | asset_id, context, opened_at |
| analytics_views_user | いいえ | c | いいえ | user_id, opened_at |
| analytics_views_shelf | いいえ | c | いいえ | shelf_id, context, opened_at |
| sqlite_autoindex_analytics_views_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE analytics_views (
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
```

</details>

## asset progress

テーブル名: `asset_progress`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| user_id | TEXT | はい | — | 1 |
| asset_id | TEXT | はい | — | 2 |
| revision | INTEGER | はい | — | — |
| update_id | TEXT | はい | — | — |
| payload_hash | TEXT | はい | — | — |
| position_ms | INTEGER | いいえ | — | — |
| duration_ms | INTEGER | いいえ | — | — |
| page_number | INTEGER | いいえ | — | — |
| scroll_x | REAL | いいえ | — | — |
| scroll_y | REAL | いいえ | — | — |
| zoom | TEXT | いいえ | — | — |
| completed | INTEGER | はい | 0 | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_asset_progress_1 | はい | pk | いいえ | user_id, asset_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE asset_progress (
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
```

</details>

## asset tags

テーブル名: `asset_tags`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| asset_id | TEXT | はい | — | — |
| user_id | TEXT | いいえ | — | — |
| label | TEXT | はい | — | — |
| normalized | TEXT | はい | — | — |
| category | TEXT | はい | '' | — |
| source | TEXT | はい | — | — |
| rejected | INTEGER | はい | 0 | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |
| asset_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| asset_tags_name | いいえ | c | いいえ | normalized, asset_id |
| asset_tags_key | はい | c | いいえ | asset_id, (式), normalized |
| sqlite_autoindex_asset_tags_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE asset_tags (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL, normalized TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL, rejected INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
```

</details>

## audio assets

テーブル名: `audio_assets`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| item_id | TEXT | いいえ | — | 1 |
| metadata_json | TEXT | はい | — | — |
| original_retained | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| item_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_audio_assets_1 | はい | pk | いいえ | item_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE audio_assets (
      item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      metadata_json TEXT NOT NULL,
      original_retained INTEGER NOT NULL CHECK(original_retained IN (0,1))
    );
```

</details>

## bootstrap accounts

テーブル名: `bootstrap_accounts`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| user_id | TEXT | いいえ | — | 1 |
| initial_hash | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_bootstrap_accounts_1 | はい | pk | いいえ | user_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE bootstrap_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,initial_hash TEXT NOT NULL);
```

</details>

## diagnostic batches

テーブル名: `diagnostic_batches`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| user_id | TEXT | はい | — | — |
| reports_json | TEXT | はい | — | — |
| report_count | INTEGER | はい | — | — |
| created_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| diagnostic_batches_created | いいえ | c | いいえ | created_at, id |
| sqlite_autoindex_diagnostic_batches_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE diagnostic_batches(
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reports_json TEXT NOT NULL,report_count INTEGER NOT NULL,created_at INTEGER NOT NULL);
```

</details>

## encrypted downloads

テーブル名: `encrypted_downloads`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| user_id | TEXT | はい | — | — |
| asset_id | TEXT | はい | — | — |
| manifest_json | TEXT | はい | — | — |
| created_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| downloads_user_asset | いいえ | c | いいえ | user_id, asset_id |
| sqlite_autoindex_encrypted_downloads_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE encrypted_downloads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      manifest_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
```

</details>

## history hidden

テーブル名: `history_hidden`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| user_id | TEXT | はい | — | 1 |
| asset_id | TEXT | はい | — | 2 |
| hidden_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_history_hidden_1 | はい | pk | いいえ | user_id, asset_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE history_hidden(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,asset_id TEXT NOT NULL,hidden_at INTEGER NOT NULL,PRIMARY KEY(user_id,asset_id));
```

</details>

## image pages

テーブル名: `image_pages`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| item_id | TEXT | はい | — | 1 |
| page_number | INTEGER | はい | — | 2 |
| filename | TEXT | はい | — | — |
| size | INTEGER | はい | — | — |
| width | INTEGER | はい | — | — |
| height | INTEGER | はい | — | — |
| mime_type | TEXT | はい | 'image/jpeg' | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| item_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_image_pages_1 | はい | pk | いいえ | item_id, page_number |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE image_pages (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL CHECK (page_number > 0),
      filename TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size > 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      mime_type TEXT NOT NULL DEFAULT 'image/jpeg' CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
      PRIMARY KEY (item_id, page_number)
    );
```

</details>

## items

テーブル名: `items`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| shelf_id | TEXT | はい | — | — |
| title | TEXT | はい | — | — |
| filename | TEXT | はい | — | — |
| mime_type | TEXT | はい | — | — |
| size | INTEGER | はい | — | — |
| uploaded_by | TEXT | いいえ | — | — |
| created_at | INTEGER | はい | — | — |
| page_count | INTEGER | はい | 1 | — |
| thumbnail_ready | INTEGER | はい | 0 | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| uploaded_by | users.id | NO ACTION | SET NULL |
| shelf_id | shelves.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| items_shelf | いいえ | c | いいえ | shelf_id, created_at |
| sqlite_autoindex_items_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE "items" (
          id TEXT PRIMARY KEY, shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
          title TEXT NOT NULL, filename TEXT NOT NULL,
          mime_type TEXT NOT NULL CHECK(mime_type IN ('application/pdf','video/mp4','video/webm','application/vnd.mirea.image-book','application/epub+zip','audio/mp4')),
          size INTEGER NOT NULL CHECK(size > 0), uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL, page_count INTEGER NOT NULL DEFAULT 1 CHECK(page_count > 0),
          thumbnail_ready INTEGER NOT NULL DEFAULT 0 CHECK(thumbnail_ready IN (0,1))
        );
```

</details>

## job timings

テーブル名: `job_timings`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| scope | TEXT | はい | — | 1 |
| id | TEXT | はい | — | 2 |
| started_at | INTEGER | いいえ | — | — |
| finished_at | INTEGER | いいえ | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

外部キーはありません。

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_job_timings_1 | はい | pk | いいえ | scope, id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE job_timings(scope TEXT NOT NULL,id TEXT NOT NULL,started_at INTEGER,finished_at INTEGER,PRIMARY KEY(scope,id));
```

</details>

## manual upload starts

テーブル名: `manual_upload_starts`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| user_id | TEXT | いいえ | — | 1 |
| queue_id | TEXT | はい | — | — |
| requested_at | INTEGER | はい | — | — |
| expires_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| queue_id | upload_queue.id | NO ACTION | CASCADE |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_manual_upload_starts_2 | はい | u | いいえ | queue_id |
| sqlite_autoindex_manual_upload_starts_1 | はい | pk | いいえ | user_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE manual_upload_starts(
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    queue_id TEXT NOT NULL UNIQUE REFERENCES upload_queue(id) ON DELETE CASCADE,
    requested_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
```

</details>

## media ingest

テーブル名: `media_ingest`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| asset_id | TEXT | いいえ | — | 1 |
| source_mime | TEXT | はい | — | — |
| source_filename | TEXT | はい | — | — |
| source_size | INTEGER | はい | — | — |
| retain_original | INTEGER | はい | — | — |
| canonical_ready | INTEGER | はい | 0 | — |
| source_removed | INTEGER | はい | 0 | — |
| metadata_json | TEXT | はい | — | — |
| created_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_media_ingest_1 | はい | pk | いいえ | asset_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE media_ingest(
      asset_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      source_mime TEXT NOT NULL,source_filename TEXT NOT NULL,source_size INTEGER NOT NULL,
      retain_original INTEGER NOT NULL CHECK(retain_original IN (0,1)),
      canonical_ready INTEGER NOT NULL DEFAULT 0,source_removed INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL,created_at INTEGER NOT NULL
    );
```

</details>

## media tasks

テーブル名: `media_tasks`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| asset_id | TEXT | はい | — | — |
| kind | TEXT | はい | — | — |
| state | TEXT | はい | — | — |
| progress_json | TEXT | はい | '{}' | — |
| error | TEXT | いいえ | — | — |
| created_at | INTEGER | はい | — | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| media_tasks_queue | いいえ | c | いいえ | kind, state, created_at |
| sqlite_autoindex_media_tasks_2 | はい | u | いいえ | asset_id, kind |
| sqlite_autoindex_media_tasks_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE media_tasks(
      id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('thumbnail','transcode','preview')),
      state TEXT NOT NULL CHECK(state IN ('queued','running','complete','failed','cancelled')),
      progress_json TEXT NOT NULL DEFAULT '{}',error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(asset_id,kind)
    );
```

</details>

## memberships

テーブル名: `memberships`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| shelf_id | TEXT | はい | — | 1 |
| user_id | TEXT | はい | — | 2 |
| role | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |
| shelf_id | shelves.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| memberships_user | いいえ | c | いいえ | user_id |
| one_owner_per_shelf | はい | c | はい | shelf_id |
| sqlite_autoindex_memberships_1 | はい | pk | いいえ | shelf_id, user_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE memberships (
      shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
      PRIMARY KEY (shelf_id, user_id)
    );
```

</details>

## playback generations

テーブル名: `playback_generations`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| token_hash | TEXT | いいえ | — | 1 |
| generation | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| token_hash | playback_tickets.token_hash | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_playback_generations_1 | はい | pk | いいえ | token_hash |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE playback_generations (
      token_hash TEXT PRIMARY KEY REFERENCES playback_tickets(token_hash) ON DELETE CASCADE,
      generation TEXT NOT NULL
    );
```

</details>

## playback tickets

テーブル名: `playback_tickets`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| token_hash | TEXT | いいえ | — | 1 |
| session_id | TEXT | はい | — | — |
| item_id | TEXT | はい | — | — |
| expires_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| item_id | items.id | NO ACTION | CASCADE |
| session_id | sessions.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_playback_tickets_1 | はい | pk | いいえ | token_hash |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE playback_tickets (
      token_hash TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
```

</details>

## playlist items

テーブル名: `playlist_items`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| playlist_id | TEXT | はい | — | 1 |
| asset_id | TEXT | はい | — | 2 |
| position | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |
| playlist_id | playlists.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_playlist_items_2 | はい | u | いいえ | playlist_id, position |
| sqlite_autoindex_playlist_items_1 | はい | pk | いいえ | playlist_id, asset_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE playlist_items(playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,position INTEGER NOT NULL,
      PRIMARY KEY(playlist_id,asset_id),UNIQUE(playlist_id,position));
```

</details>

## playlists

テーブル名: `playlists`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| user_id | TEXT | はい | — | — |
| title | TEXT | はい | — | — |
| revision | INTEGER | はい | 1 | — |
| created_at | INTEGER | はい | — | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| playlists_user | いいえ | c | いいえ | user_id, updated_at |
| sqlite_autoindex_playlists_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE playlists(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
```

</details>

## schema version

テーブル名: `schema_version`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| version | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

外部キーはありません。

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE schema_version (version INTEGER NOT NULL);
```

</details>

## series

テーブル名: `series`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| shelf_id | TEXT | はい | — | — |
| title | TEXT | はい | — | — |
| description | TEXT | はい | '' | — |
| revision | INTEGER | はい | 1 | — |
| created_at | INTEGER | はい | — | — |
| updated_at | INTEGER | はい | — | — |
| parent_id | TEXT | いいえ | — | — |
| order_mode | TEXT | はい | 'name' | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| parent_id | series.id | NO ACTION | SET NULL |
| shelf_id | shelves.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| series_parent | いいえ | c | いいえ | parent_id |
| series_shelf | いいえ | c | いいえ | shelf_id, title |
| sqlite_autoindex_series_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE series (
      id TEXT PRIMARY KEY,
      shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    , parent_id TEXT REFERENCES series(id) ON DELETE SET NULL, order_mode TEXT NOT NULL DEFAULT 'name' CHECK(order_mode IN ('name','manual')));
```

</details>

## series create requests

テーブル名: `series_create_requests`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| user_id | TEXT | はい | — | 1 |
| request_id | TEXT | はい | — | 2 |
| series_id | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| series_id | series.id | NO ACTION | CASCADE |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_series_create_requests_1 | はい | pk | いいえ | user_id, request_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE series_create_requests(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id TEXT NOT NULL,series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,PRIMARY KEY(user_id,request_id));
```

</details>

## series items

テーブル名: `series_items`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| series_id | TEXT | はい | — | 1 |
| asset_id | TEXT | はい | — | — |
| position | INTEGER | はい | — | 2 |
| label | TEXT | はい | '' | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |
| series_id | series.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_series_items_2 | はい | pk | いいえ | series_id, position |
| sqlite_autoindex_series_items_1 | はい | u | いいえ | asset_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE series_items (
      series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position > 0),
      label TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(series_id, position)
    );
```

</details>

## server settings

テーブル名: `server_settings`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| key | TEXT | いいえ | — | 1 |
| value | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

外部キーはありません。

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_server_settings_1 | はい | pk | いいえ | key |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
```

</details>

## sessions

テーブル名: `sessions`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| token_hash | TEXT | はい | — | — |
| user_id | TEXT | はい | — | — |
| expires_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_sessions_2 | はい | u | いいえ | token_hash |
| sqlite_autoindex_sessions_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
```

</details>

## shelf biometric keys

テーブル名: `shelf_biometric_keys`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | はい | — | 1 |
| user_id | TEXT | はい | — | 2 |
| public_key | TEXT | はい | — | — |
| password_hash | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_shelf_biometric_keys_1 | はい | pk | いいえ | id, user_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE shelf_biometric_keys(id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,public_key TEXT NOT NULL,password_hash TEXT NOT NULL,PRIMARY KEY(id,user_id));
```

</details>

## shelf challenges

テーブル名: `shelf_challenges`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| challenge | TEXT | いいえ | — | 1 |
| session_id | TEXT | はい | — | — |
| shelf_id | TEXT | はい | — | — |
| key_id | TEXT | はい | — | — |
| expires_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| shelf_id | shelves.id | NO ACTION | CASCADE |
| session_id | sessions.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_shelf_challenges_1 | はい | pk | いいえ | challenge |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE shelf_challenges(challenge TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,key_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
```

</details>

## shelf unlocks

テーブル名: `shelf_unlocks`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| token_hash | TEXT | いいえ | — | 1 |
| session_id | TEXT | はい | — | — |
| shelf_id | TEXT | はい | — | — |
| password_hash | TEXT | はい | — | — |
| expires_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| shelf_id | shelves.id | NO ACTION | CASCADE |
| session_id | sessions.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_shelf_unlocks_1 | はい | pk | いいえ | token_hash |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE shelf_unlocks(token_hash TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,password_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
```

</details>

## shelves

テーブル名: `shelves`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| name | TEXT | はい | — | — |
| description | TEXT | はい | '' | — |
| created_at | INTEGER | はい | — | — |
| private | INTEGER | はい | 0 | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

外部キーはありません。

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_shelves_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE shelves (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    , private INTEGER NOT NULL DEFAULT 0 CHECK(private IN (0,1)));
```

</details>

## thumbnail overrides

テーブル名: `thumbnail_overrides`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| asset_id | TEXT | いいえ | — | 1 |
| image_id | TEXT | はい | — | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| thumbnail_image | いいえ | c | いいえ | image_id |
| sqlite_autoindex_thumbnail_overrides_1 | はい | pk | いいえ | asset_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE thumbnail_overrides(asset_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,image_id TEXT NOT NULL,updated_at INTEGER NOT NULL);
```

</details>

## transfer hidden

テーブル名: `transfer_hidden`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| user_id | TEXT | はい | — | 1 |
| upload_id | TEXT | はい | — | 2 |
| hidden_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| upload_id | upload_sessions.id | NO ACTION | CASCADE |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_transfer_hidden_1 | はい | pk | いいえ | user_id, upload_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE transfer_hidden(
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    hidden_at INTEGER NOT NULL,PRIMARY KEY(user_id,upload_id));
```

</details>

## upload parts

テーブル名: `upload_parts`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| upload_id | TEXT | はい | — | 1 |
| file_index | INTEGER | はい | — | 2 |
| part_index | INTEGER | はい | — | 3 |
| size | INTEGER | はい | — | — |
| sha256 | TEXT | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| upload_id | upload_sessions.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_upload_parts_1 | はい | pk | いいえ | upload_id, file_index, part_index |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE upload_parts (
      upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
      file_index INTEGER NOT NULL,
      part_index INTEGER NOT NULL,
      size INTEGER NOT NULL CHECK (size > 0),
      sha256 TEXT NOT NULL,
      PRIMARY KEY (upload_id, file_index, part_index)
    );
```

</details>

## upload queue

テーブル名: `upload_queue`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| user_id | TEXT | はい | — | — |
| shelf_id | TEXT | はい | — | — |
| series_id | TEXT | いいえ | — | — |
| title | TEXT | はい | — | — |
| mime_type | TEXT | はい | — | — |
| total_bytes | INTEGER | はい | — | — |
| created_at | INTEGER | はい | — | — |
| expires_at | INTEGER | はい | — | — |
| upload_id | TEXT | いいえ | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| upload_id | upload_sessions.id | NO ACTION | CASCADE |
| series_id | series.id | NO ACTION | SET NULL |
| shelf_id | shelves.id | NO ACTION | CASCADE |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| upload_queue_user | いいえ | c | いいえ | user_id, expires_at |
| sqlite_autoindex_upload_queue_2 | はい | u | いいえ | upload_id |
| sqlite_autoindex_upload_queue_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE upload_queue(
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
      series_id TEXT REFERENCES series(id) ON DELETE SET NULL,title TEXT NOT NULL,mime_type TEXT NOT NULL,
      total_bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      upload_id TEXT UNIQUE REFERENCES upload_sessions(id) ON DELETE CASCADE
    );
```

</details>

## upload sessions

テーブル名: `upload_sessions`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| shelf_id | TEXT | はい | — | — |
| user_id | TEXT | はい | — | — |
| session_id | TEXT | はい | — | — |
| title | TEXT | はい | — | — |
| files_json | TEXT | はい | — | — |
| chunk_size | INTEGER | はい | — | — |
| state | TEXT | はい | — | — |
| error | TEXT | いいえ | — | — |
| created_at | INTEGER | はい | — | — |
| expires_at | INTEGER | はい | — | — |
| retain_original | INTEGER | はい | 0 | — |
| processing_json | TEXT | はい | '{}' | — |
| target_series_id | TEXT | いいえ | — | — |
| series_requested | INTEGER | はい | 0 | — |
| series_warning | TEXT | はい | '' | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| target_series_id | series.id | NO ACTION | SET NULL |
| user_id | users.id | NO ACTION | CASCADE |
| shelf_id | shelves.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| uploads_user | いいえ | c | いいえ | user_id, state |
| sqlite_autoindex_upload_sessions_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE upload_sessions (
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
    , retain_original INTEGER NOT NULL DEFAULT 0 CHECK(retain_original IN (0,1)), processing_json TEXT NOT NULL DEFAULT '{}', target_series_id TEXT REFERENCES series(id) ON DELETE SET NULL, series_requested INTEGER NOT NULL DEFAULT 0, series_warning TEXT NOT NULL DEFAULT '');
```

</details>

## user access

テーブル名: `user_access`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| user_id | TEXT | いいえ | — | 1 |
| server_role | TEXT | はい | — | — |
| disabled | INTEGER | はい | 0 | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| user_id | users.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_user_access_1 | はい | pk | いいえ | user_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE user_access (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      server_role TEXT NOT NULL CHECK(server_role IN ('admin','user')),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))
    );
```

</details>

## users

テーブル名: `users`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| id | TEXT | いいえ | — | 1 |
| email | TEXT | はい | — | — |
| name | TEXT | はい | — | — |
| password_hash | TEXT | はい | — | — |
| created_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

外部キーはありません。

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_users_2 | はい | u | いいえ | email |
| sqlite_autoindex_users_1 | はい | pk | いいえ | id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
```

</details>

## video assets

テーブル名: `video_assets`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| item_id | TEXT | いいえ | — | 1 |
| metadata_json | TEXT | はい | — | — |
| original_retained | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| item_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_video_assets_1 | はい | pk | いいえ | item_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE video_assets (
      item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
      metadata_json TEXT NOT NULL,
      original_retained INTEGER NOT NULL CHECK(original_retained IN (0,1))
    );
```

</details>

## video generations

テーブル名: `video_generations`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| item_id | TEXT | はい | — | 1 |
| generation | TEXT | はい | — | 2 |
| metadata_json | TEXT | はい | — | — |
| created_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| item_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_video_generations_1 | はい | pk | いいえ | item_id, generation |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE video_generations (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      generation TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(item_id,generation)
    );
```

</details>

## video navigation

テーブル名: `video_navigation`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| item_id | TEXT | いいえ | — | 1 |
| revision | INTEGER | はい | 0 | — |
| state | TEXT | はい | — | — |
| job_id | TEXT | いいえ | — | — |
| requester_id | TEXT | いいえ | — | — |
| duration_ms | INTEGER | はい | 0 | — |
| chapters_json | TEXT | はい | '[]' | — |
| chapters_manual | INTEGER | はい | 0 | — |
| captions_json | TEXT | はい | '[]' | — |
| storyboard_json | TEXT | いいえ | — | — |
| storyboard | BLOB | いいえ | — | — |
| error | TEXT | いいえ | — | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| requester_id | users.id | NO ACTION | SET NULL |
| job_id | admin_jobs.id | NO ACTION | SET NULL |
| item_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_video_navigation_1 | はい | pk | いいえ | item_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE video_navigation (
    item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK(state IN ('queued','running','ready','failed')), job_id TEXT REFERENCES admin_jobs(id) ON DELETE SET NULL,
    requester_id TEXT REFERENCES users(id) ON DELETE SET NULL, duration_ms INTEGER NOT NULL DEFAULT 0,
    chapters_json TEXT NOT NULL DEFAULT '[]', chapters_manual INTEGER NOT NULL DEFAULT 0,
    captions_json TEXT NOT NULL DEFAULT '[]', storyboard_json TEXT, storyboard BLOB, error TEXT, updated_at INTEGER NOT NULL
  );
```

</details>

## video thumbnail state

テーブル名: `video_thumbnail_state`

| 列 | SQLite型 | NOT NULL | 既定値 | 主キー順 |
| --- | --- | --- | --- | --- |
| asset_id | TEXT | いいえ | — | 1 |
| position_seconds | REAL | はい | — | — |
| preview_position_seconds | REAL | いいえ | — | — |
| preview_version | INTEGER | はい | 0 | — |
| updated_at | INTEGER | はい | — | — |

SQLiteの行IDテーブルでは、`TEXT PRIMARY KEY`だけでは`NOT NULL`属性が付かない定義があります。APIのID検証とは別の制約として上表を読んでください。

| 外部キー列 | 参照先 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- |
| asset_id | items.id | NO ACTION | CASCADE |

| 索引 | 一意 | 作成元 | 部分索引 | 列 |
| --- | --- | --- | --- | --- |
| sqlite_autoindex_video_thumbnail_state_1 | はい | pk | いいえ | asset_id |

<details>
<summary>CREATE TABLE 定義</summary>

```sql
CREATE TABLE video_thumbnail_state(
    asset_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    position_seconds REAL NOT NULL CHECK(position_seconds>=0),
    preview_position_seconds REAL,preview_version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
```

</details>

## 明示的な索引の定義

`origin`の`pk`は主キー、`u`はUNIQUE制約、`c`はCREATE INDEX由来です。部分索引の条件は次のSQLで確認できます。

```sql
CREATE UNIQUE INDEX admin_asset_job ON admin_jobs(asset_id)
      WHERE state IN ('queued','running') AND asset_id IS NOT NULL;
CREATE INDEX ai_batch_queue ON ai_batch_assets(batch_id,state);
CREATE INDEX ai_documents_asset ON ai_documents(asset_id,feature);
CREATE UNIQUE INDEX ai_job_active ON
      ai_jobs(asset_id,feature,input_stamp,profile_hash)
      WHERE state IN ('queued','running','paused','resource-wait','dependency-wait');
CREATE INDEX ai_jobs_queue ON ai_jobs(state,updated_at,created_at);
CREATE INDEX analytics_events_view_arrival ON analytics_events(view_id,row_id);
CREATE INDEX analytics_events_view_time ON analytics_events(view_id, elapsed_ms);
CREATE INDEX analytics_views_asset ON analytics_views(asset_id, context, opened_at);
CREATE INDEX analytics_views_shelf ON analytics_views(shelf_id, context, opened_at);
CREATE INDEX analytics_views_time ON analytics_views(opened_at);
CREATE INDEX analytics_views_user ON analytics_views(user_id, opened_at);
CREATE UNIQUE INDEX asset_tags_key
      ON asset_tags(asset_id,COALESCE(user_id,''),normalized);
CREATE INDEX asset_tags_name ON asset_tags(normalized,asset_id);
CREATE INDEX diagnostic_batches_created ON diagnostic_batches(created_at,id);
CREATE INDEX downloads_user_asset ON encrypted_downloads(user_id,asset_id);
CREATE INDEX items_shelf ON items(shelf_id,created_at);
CREATE INDEX media_tasks_queue ON media_tasks(kind,state,created_at);
CREATE INDEX memberships_user ON memberships(user_id);
CREATE UNIQUE INDEX one_owner_per_shelf ON memberships(shelf_id) WHERE role = 'owner';
CREATE INDEX playlists_user ON playlists(user_id,updated_at);
CREATE INDEX series_parent ON series(parent_id);
CREATE INDEX series_shelf ON series(shelf_id, title);
CREATE INDEX thumbnail_image ON thumbnail_overrides(image_id);
CREATE INDEX upload_queue_user ON upload_queue(user_id,expires_at);
CREATE INDEX uploads_user ON upload_sessions(user_id, state);
```

## トリガー

シリーズの整合性、再試行時の非表示解除、ジョブの開始・終了時計をDB側で補助します。HTTPの認証・権限検査の代わりにはなりません。

### admin jobs timing delete

```sql
CREATE TRIGGER admin_jobs_timing_delete AFTER DELETE ON admin_jobs BEGIN DELETE FROM job_timings WHERE scope='admin' AND id=OLD.id;END;
```

### admin jobs timing insert

```sql
CREATE TRIGGER admin_jobs_timing_insert AFTER INSERT ON admin_jobs BEGIN
      INSERT OR REPLACE INTO job_timings(scope,id,started_at,finished_at) VALUES('admin',NEW.id,CASE WHEN NEW.state='running' THEN CAST(unixepoch('subsec')*1000 AS INTEGER) END,NULL);END;
```

### admin jobs timing state

```sql
CREATE TRIGGER admin_jobs_timing_state AFTER UPDATE OF state ON admin_jobs WHEN NEW.state!=OLD.state BEGIN
      INSERT INTO job_timings(scope,id,started_at,finished_at) VALUES('admin',NEW.id,CASE WHEN NEW.state='running' THEN CAST(unixepoch('subsec')*1000 AS INTEGER) END,CASE WHEN NEW.state IN ('complete','failed','cancelled') THEN CAST(unixepoch('subsec')*1000 AS INTEGER) END)
      ON CONFLICT(scope,id) DO UPDATE SET started_at=CASE WHEN NEW.state='running' THEN COALESCE(job_timings.started_at,excluded.started_at) ELSE job_timings.started_at END,finished_at=excluded.finished_at;END;
```

### ai document delete

```sql
CREATE TRIGGER ai_document_delete AFTER DELETE ON ai_documents BEGIN
      INSERT INTO ai_documents_fts(ai_documents_fts,rowid,normalized)
        VALUES('delete',old.rowid,old.normalized);
    END;
```

### ai document insert

```sql
CREATE TRIGGER ai_document_insert AFTER INSERT ON ai_documents BEGIN
      INSERT INTO ai_documents_fts(rowid,normalized) VALUES(new.rowid,new.normalized);
    END;
```

### ai document update

```sql
CREATE TRIGGER ai_document_update AFTER UPDATE OF normalized ON ai_documents BEGIN
      INSERT INTO ai_documents_fts(ai_documents_fts,rowid,normalized)
        VALUES('delete',old.rowid,old.normalized);
      INSERT INTO ai_documents_fts(rowid,normalized) VALUES(new.rowid,new.normalized);
    END;
```

### media tasks timing delete

```sql
CREATE TRIGGER media_tasks_timing_delete AFTER DELETE ON media_tasks BEGIN DELETE FROM job_timings WHERE scope='media' AND id=OLD.id;END;
```

### media tasks timing insert

```sql
CREATE TRIGGER media_tasks_timing_insert AFTER INSERT ON media_tasks BEGIN
      INSERT OR REPLACE INTO job_timings(scope,id,started_at,finished_at) VALUES('media',NEW.id,CASE WHEN NEW.state='running' THEN CAST(unixepoch('subsec')*1000 AS INTEGER) END,NULL);END;
```

### media tasks timing state

```sql
CREATE TRIGGER media_tasks_timing_state AFTER UPDATE OF state ON media_tasks WHEN NEW.state!=OLD.state BEGIN
      INSERT INTO job_timings(scope,id,started_at,finished_at) VALUES('media',NEW.id,CASE WHEN NEW.state='running' THEN CAST(unixepoch('subsec')*1000 AS INTEGER) END,CASE WHEN NEW.state IN ('complete','failed','cancelled') THEN CAST(unixepoch('subsec')*1000 AS INTEGER) END)
      ON CONFLICT(scope,id) DO UPDATE SET started_at=CASE WHEN NEW.state='running' THEN COALESCE(job_timings.started_at,excluded.started_at) ELSE job_timings.started_at END,finished_at=excluded.finished_at;END;
```

### series asset removed

```sql
CREATE TRIGGER series_asset_removed AFTER DELETE ON series_items
      BEGIN UPDATE series SET revision=revision+1 WHERE id=OLD.series_id; END;
```

### series asset shelf update

```sql
CREATE TRIGGER series_asset_shelf_update BEFORE UPDATE OF shelf_id ON items
      WHEN EXISTS(SELECT 1 FROM series_items si JOIN series s ON s.id=si.series_id WHERE si.asset_id=NEW.id AND s.shelf_id!=NEW.shelf_id)
      BEGIN SELECT RAISE(ABORT, 'Remove series membership before moving asset'); END;
```

### series parent changed

```sql
CREATE TRIGGER series_parent_changed AFTER UPDATE OF parent_id ON series WHEN OLD.parent_id IS NOT NEW.parent_id BEGIN UPDATE series SET revision=revision+1,updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=NEW.id;END;
```

### series parent insert

```sql
CREATE TRIGGER series_parent_insert BEFORE INSERT ON series WHEN NEW.parent_id IS NOT NULL BEGIN
        SELECT CASE WHEN NEW.parent_id=NEW.id OR NOT EXISTS(SELECT 1 FROM series WHERE id=NEW.parent_id AND shelf_id=NEW.shelf_id) THEN RAISE(ABORT,'Invalid series parent') END;
      END;
```

### series parent update

```sql
CREATE TRIGGER series_parent_update BEFORE UPDATE OF parent_id ON series WHEN NEW.parent_id IS NOT NULL BEGIN
        SELECT CASE WHEN NEW.parent_id=NEW.id OR NOT EXISTS(SELECT 1 FROM series WHERE id=NEW.parent_id AND shelf_id=NEW.shelf_id) THEN RAISE(ABORT,'Invalid series parent') END;
        SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id) AS (SELECT NEW.parent_id UNION SELECT s.parent_id FROM series s JOIN ancestors a ON s.id=a.id WHERE s.parent_id IS NOT NULL) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'Series hierarchy cycle') END;
      END;
```

### series same shelf insert

```sql
CREATE TRIGGER series_same_shelf_insert BEFORE INSERT ON series_items
      WHEN (SELECT shelf_id FROM series WHERE id=NEW.series_id) != (SELECT shelf_id FROM items WHERE id=NEW.asset_id)
      BEGIN SELECT RAISE(ABORT, 'Series and asset must share a shelf'); END;
```

### series same shelf update

```sql
CREATE TRIGGER series_same_shelf_update BEFORE UPDATE ON series_items
      WHEN (SELECT shelf_id FROM series WHERE id=NEW.series_id) != (SELECT shelf_id FROM items WHERE id=NEW.asset_id)
      BEGIN SELECT RAISE(ABORT, 'Series and asset must share a shelf'); END;
```

### series shelf update

```sql
CREATE TRIGGER series_shelf_update BEFORE UPDATE OF shelf_id ON series
      WHEN EXISTS(SELECT 1 FROM series_items si JOIN items i ON i.id=si.asset_id WHERE si.series_id=NEW.id AND i.shelf_id!=NEW.shelf_id)
      BEGIN SELECT RAISE(ABORT, 'Remove assets before moving series'); END;
```

### series tree shelf update

```sql
CREATE TRIGGER series_tree_shelf_update BEFORE UPDATE OF shelf_id ON series WHEN EXISTS(SELECT 1 FROM series WHERE id=NEW.parent_id AND shelf_id!=NEW.shelf_id) OR EXISTS(SELECT 1 FROM series WHERE parent_id=NEW.id AND shelf_id!=NEW.shelf_id) BEGIN SELECT RAISE(ABORT,'Detach series hierarchy before moving shelves');END;
```

### series unique path insert

```sql
CREATE TRIGGER series_unique_path_insert BEFORE INSERT ON series
      WHEN EXISTS(SELECT 1 FROM series WHERE shelf_id=NEW.shelf_id AND parent_id IS NEW.parent_id AND title=NEW.title)
      BEGIN SELECT RAISE(ABORT,'Duplicate series path');END;
```

### series unique path update

```sql
CREATE TRIGGER series_unique_path_update BEFORE UPDATE OF title,parent_id,shelf_id ON series
      WHEN (NEW.title!=OLD.title OR NEW.parent_id IS NOT OLD.parent_id OR NEW.shelf_id!=OLD.shelf_id) AND EXISTS(SELECT 1 FROM series WHERE id!=NEW.id AND shelf_id=NEW.shelf_id AND parent_id IS NEW.parent_id AND title=NEW.title)
      BEGIN SELECT RAISE(ABORT,'Duplicate series path');END;
```

### transfer retried

```sql
CREATE TRIGGER transfer_retried AFTER UPDATE OF state ON upload_sessions
    WHEN NEW.state!=OLD.state BEGIN DELETE FROM transfer_hidden WHERE upload_id=NEW.id;END;
```

### upload sessions timing delete

```sql
CREATE TRIGGER upload_sessions_timing_delete AFTER DELETE ON upload_sessions BEGIN DELETE FROM job_timings WHERE scope='upload' AND id=OLD.id;END;
```

### upload sessions timing insert

```sql
CREATE TRIGGER upload_sessions_timing_insert AFTER INSERT ON upload_sessions BEGIN
      INSERT OR REPLACE INTO job_timings(scope,id,started_at,finished_at) VALUES('upload',NEW.id,CASE WHEN NEW.state='uploading' THEN CAST(unixepoch('subsec')*1000 AS INTEGER) END,NULL);END;
```

### upload sessions timing state

```sql
CREATE TRIGGER upload_sessions_timing_state AFTER UPDATE OF state ON upload_sessions WHEN NEW.state!=OLD.state BEGIN
      INSERT INTO job_timings(scope,id,started_at,finished_at) VALUES('upload',NEW.id,CASE WHEN NEW.state='uploading' THEN CAST(unixepoch('subsec')*1000 AS INTEGER) END,CASE WHEN NEW.state IN ('complete','failed','cancelled') THEN CAST(unixepoch('subsec')*1000 AS INTEGER) END)
      ON CONFLICT(scope,id) DO UPDATE SET started_at=CASE WHEN NEW.state='uploading' THEN COALESCE(job_timings.started_at,excluded.started_at) ELSE job_timings.started_at END,finished_at=excluded.finished_at;END;
```
