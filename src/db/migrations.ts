import { AppDatabase } from './database';

export function runMigrations(db: AppDatabase): void {
  // Ensure schema_version table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const getCurrentVersion = (): number => {
    const row = db.prepare('SELECT MAX(version) as ver FROM schema_version').get() as { ver: number | null } | undefined;
    return row?.ver || 0;
  };

  let currentVersion = getCurrentVersion();

  if (currentVersion < 1) {
    db.transaction(() => {
      // 1. comments table
      db.exec(`
        CREATE TABLE IF NOT EXISTS comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          steam_comment_id TEXT NOT NULL UNIQUE,
          commenter_steam_id TEXT NOT NULL,
          commenter_name TEXT,
          commenter_profile_url TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT,
          language TEXT,
          classification TEXT,
          classification_confidence REAL,
          reply_source TEXT,
          reply TEXT,
          status TEXT NOT NULL DEFAULT 'detected',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          replied_at TEXT,
          error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
        CREATE INDEX IF NOT EXISTS idx_comments_commenter ON comments(commenter_steam_id);
      `);

      // 2. reply_tasks table
      db.exec(`
        CREATE TABLE IF NOT EXISTS reply_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL UNIQUE,
          steam_comment_id TEXT NOT NULL UNIQUE,
          target_steam_id TEXT NOT NULL,
          target_profile_url TEXT NOT NULL,
          reply_text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'scheduled',
          scheduled_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reply_tasks_status ON reply_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_reply_tasks_sched ON reply_tasks(scheduled_at);
      `);

      // 3. holiday_messages table
      db.exec(`
        CREATE TABLE IF NOT EXISTS holiday_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          holiday_id TEXT NOT NULL,
          steam_id TEXT NOT NULL,
          profile_url TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'scheduled',
          scheduled_at TEXT NOT NULL,
          sent_at TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(holiday_id, steam_id)
        );
        CREATE INDEX IF NOT EXISTS idx_holiday_sched ON holiday_messages(scheduled_at, status);
      `);

      // 4. interaction_users table
      db.exec(`
        CREATE TABLE IF NOT EXISTS interaction_users (
          steam_id TEXT PRIMARY KEY,
          profile_url TEXT NOT NULL,
          display_name TEXT,
          first_seen_at TEXT NOT NULL,
          last_interaction_at TEXT NOT NULL,
          interaction_count INTEGER NOT NULL DEFAULT 1,
          language TEXT,
          spam_count INTEGER NOT NULL DEFAULT 0,
          replied_count INTEGER NOT NULL DEFAULT 0,
          blacklisted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_interaction_last ON interaction_users(last_interaction_at);
      `);

      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        1,
        new Date().toISOString()
      );
    })();
    currentVersion = getCurrentVersion();
  }

  if (currentVersion < 2) {
    db.transaction(() => {
      // 5. nickname_memory table
      db.exec(`
        CREATE TABLE IF NOT EXISTS nickname_memory (
          steam_id TEXT PRIMARY KEY,
          original_name TEXT NOT NULL,
          preferred_name TEXT NOT NULL,
          source TEXT NOT NULL,
          confidence REAL NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_nickname_memory_updated ON nickname_memory(updated_at);
      `);

      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        2,
        new Date().toISOString()
      );
    })();
    currentVersion = getCurrentVersion();
  }

  if (currentVersion < 3) {
    db.transaction(() => {
      // 6. comment_monitor_state table for incremental catch-up cursor persistence
      db.exec(`
        CREATE TABLE IF NOT EXISTS comment_monitor_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_seen_comment_id TEXT,
          updated_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO comment_monitor_state (id, last_seen_comment_id, updated_at) VALUES (1, NULL, CURRENT_TIMESTAMP);
      `);

      // Add network retry and UNCERTAIN verification tracking columns safely
      const tableInfo = db.prepare("PRAGMA table_info(reply_tasks)").all() as Array<{ name: string }>;
      const existingCols = new Set(tableInfo.map(c => c.name));

      if (!existingCols.has('transport_retry_count')) {
        db.exec("ALTER TABLE reply_tasks ADD COLUMN transport_retry_count INTEGER NOT NULL DEFAULT 0;");
      }
      if (!existingCols.has('uncertain_resend_count')) {
        db.exec("ALTER TABLE reply_tasks ADD COLUMN uncertain_resend_count INTEGER NOT NULL DEFAULT 0;");
      }
      if (!existingCols.has('uncertain_verify_count')) {
        db.exec("ALTER TABLE reply_tasks ADD COLUMN uncertain_verify_count INTEGER NOT NULL DEFAULT 0;");
      }
      if (!existingCols.has('uncertain_last_checked_at')) {
        db.exec("ALTER TABLE reply_tasks ADD COLUMN uncertain_last_checked_at TEXT;");
      }
      if (!existingCols.has('reply_fingerprint')) {
        db.exec("ALTER TABLE reply_tasks ADD COLUMN reply_fingerprint TEXT;");
      }

      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        3,
        new Date().toISOString()
      );
    })();
  }
}

