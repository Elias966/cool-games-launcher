// SQLite persistence (node:sqlite, built into Electron's Node runtime).
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE consent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    revoked_at TEXT,
    warning_hash TEXT NOT NULL
  );

  CREATE TABLE sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    max_pages INTEGER NOT NULL DEFAULT 5,
    rate_limit_ms INTEGER NOT NULL DEFAULT 4000,
    status TEXT NOT NULL DEFAULT 'idle',
    status_detail TEXT,
    last_crawl_at TEXT,
    cursor_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    page_url TEXT NOT NULL,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL,
    description TEXT,
    author TEXT,
    price_text TEXT,
    platforms_json TEXT NOT NULL DEFAULT '[]',
    tags_json TEXT NOT NULL DEFAULT '[]',
    thumbnail_url TEXT,
    artwork_file TEXT,
    screenshots_json TEXT NOT NULL DEFAULT '[]',
    screenshot_files_json TEXT NOT NULL DEFAULT '[]',
    candidates_json TEXT NOT NULL DEFAULT '[]',
    rating TEXT NOT NULL DEFAULT 'unknown',
    rating_score REAL NOT NULL DEFAULT 0,
    rating_reasons_json TEXT NOT NULL DEFAULT '[]',
    classifier_version TEXT,
    classify_attempts INTEGER NOT NULL DEFAULT 0,
    text_signals_json TEXT NOT NULL DEFAULT '[]',
    discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    detail_fetched_at TEXT,
    UNIQUE (source_id, page_url)
  );
  CREATE INDEX catalog_rating ON catalog(rating);
  CREATE INDEX catalog_title_key ON catalog(source_id, title_key);

  CREATE TABLE downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    catalog_id INTEGER REFERENCES catalog(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    source_host TEXT,
    url TEXT,
    headers_json TEXT NOT NULL DEFAULT '{}',
    file_name TEXT,
    part_path TEXT,
    final_path TEXT,
    total_bytes INTEGER,
    received_bytes INTEGER NOT NULL DEFAULT 0,
    etag TEXT,
    last_modified TEXT,
    resumable INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'queued',
    error_code TEXT,
    error_detail TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    user_prompt_json TEXT,
    resolution_json TEXT,
    install_state TEXT NOT NULL DEFAULT 'none',
    install_detail TEXT,
    game_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at TEXT
  );

  CREATE TABLE games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    catalog_id INTEGER REFERENCES catalog(id) ON DELETE SET NULL,
    download_id INTEGER,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    install_dir TEXT,
    executable TEXT,
    args TEXT NOT NULL DEFAULT '',
    runner TEXT NOT NULL DEFAULT 'native',
    prefix_dir TEXT,
    managed INTEGER NOT NULL DEFAULT 1,
    favorite INTEGER NOT NULL DEFAULT 0,
    artwork_file TEXT,
    source_host TEXT,
    status TEXT NOT NULL DEFAULT 'installed',
    candidates_json TEXT NOT NULL DEFAULT '[]',
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_played_at TEXT,
    playtime_seconds INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE ai_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE image_class (
    url TEXT PRIMARY KEY,
    score REAL,
    classifier_version TEXT NOT NULL,
    failed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,
  `ALTER TABLE catalog ADD COLUMN categories_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE catalog ADD COLUMN download_status TEXT NOT NULL DEFAULT 'pending';
   ALTER TABLE catalog ADD COLUMN detail_attempts INTEGER NOT NULL DEFAULT 0;
   UPDATE catalog SET detail_fetched_at = NULL;
   CREATE INDEX catalog_download_status ON catalog(download_status);
   ALTER TABLE downloads ADD COLUMN compat_json TEXT;`,
  // Older crawls discarded pagination at the batch limit. Revisit enabled
  // sources once after upgrading, preserving all verified games and downloads.
  `UPDATE sources SET last_crawl_at = NULL,
     status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'idle' END,
     status_detail = CASE WHEN status = 'blocked' THEN status_detail ELSE 'Queued for continued indexing' END
     WHERE enabled = 1;
   UPDATE catalog SET detail_attempts = 0 WHERE detail_fetched_at IS NULL;
   UPDATE downloads SET resolution_json = NULL, user_prompt_json = NULL,
     state = 'needs-resolution', error_code = 'interrupted', error_detail = 'Restarting resolution for the selected game after the launcher update.'
     WHERE catalog_id IS NOT NULL AND url IS NULL AND state IN ('resolving', 'needs-resolution', 'needs-user');`,
  `ALTER TABLE downloads ADD COLUMN preparation_json TEXT;`,
  `ALTER TABLE downloads ADD COLUMN model_json TEXT;`,
  // Old Rescan hid verified rows but left their last observed routes intact.
  // Restore that durable evidence; unknown/adult ratings still obey the policy.
  `UPDATE catalog SET download_status = 'available',
     detail_fetched_at = COALESCE(detail_fetched_at, updated_at), detail_attempts = 0
     WHERE download_status = 'pending' AND json_valid(candidates_json)
       AND json_array_length(candidates_json) > 0;`,
  // Indexing now reads pages over HTTP in parallel with an AI-learned site
  // recipe. The old 3–4 s per-request spacing was sized for one serial
  // Firefox window; relax only values that were never customised.
  `ALTER TABLE sources ADD COLUMN recipe_json TEXT;
   UPDATE sources SET rate_limit_ms = 300 WHERE rate_limit_ms IN (3000, 4000);`,
  // Game updates: the build each page offers, the build each game has
  // installed, a pending update, and the previous build kept for rollback.
  `ALTER TABLE catalog ADD COLUMN version_json TEXT;
   ALTER TABLE catalog ADD COLUMN listing_title TEXT;
   ALTER TABLE games ADD COLUMN installed_version_json TEXT;
   ALTER TABLE games ADD COLUMN update_json TEXT;
   ALTER TABLE games ADD COLUMN previous_json TEXT;
   ALTER TABLE games ADD COLUMN update_checked_at TEXT;
   ALTER TABLE downloads ADD COLUMN update_game_id INTEGER;`,
  // Popular / Trending: counters the page publishes, the site's own ranked
  // lists, and precomputed sort scores. Descriptions may come from elsewhere.
  `ALTER TABLE catalog ADD COLUMN popularity_json TEXT;
   ALTER TABLE catalog ADD COLUMN published_at TEXT;
   ALTER TABLE catalog ADD COLUMN rank_popular INTEGER;
   ALTER TABLE catalog ADD COLUMN rank_trending INTEGER;
   ALTER TABLE catalog ADD COLUMN pop_score REAL NOT NULL DEFAULT 0;
   ALTER TABLE catalog ADD COLUMN trend_score REAL NOT NULL DEFAULT 0;
   ALTER TABLE catalog ADD COLUMN description_source TEXT;`,
  // Games split into several files: every part is a download in one group
  // (group_id = the first part's download id).
  `ALTER TABLE downloads ADD COLUMN group_id INTEGER;
   ALTER TABLE downloads ADD COLUMN part_index INTEGER;
   ALTER TABLE downloads ADD COLUMN part_total INTEGER;`,
  `ALTER TABLE games ADD COLUMN archive_kept INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE games ADD COLUMN launch_json TEXT;`,
  `ALTER TABLE catalog ADD COLUMN steam_json TEXT;`,
  // Wishlist: games the user wants — catalog entries, or titles not found yet.
  `CREATE TABLE wishlist (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     catalog_id INTEGER REFERENCES catalog(id) ON DELETE SET NULL,
     title TEXT NOT NULL,
     title_key TEXT NOT NULL,
     version_key TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     notified_at TEXT
   );
   CREATE INDEX wishlist_catalog ON wishlist(catalog_id);`,
  // Runtime installers (Visual C++, DirectX …) already run in a game's prefix.
  `ALTER TABLE games ADD COLUMN redist_json TEXT;`,
  // One row per play session, for play statistics.
  `CREATE TABLE play_sessions (id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL, started_at TEXT NOT NULL, seconds INTEGER NOT NULL);
   CREATE INDEX play_sessions_time ON play_sessions(started_at);`,
  // Cover filter: how likely the cover shows a woman (0..1, from the CLIP image model); NULL = not checked.
  `ALTER TABLE catalog ADD COLUMN cover_score REAL;`,
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version++;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

/** Small statement cache so hot queries are prepared once. */
export class Statements {
  private cache = new Map<string, StatementSync>();
  constructor(private db: Db) {}
  get(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
