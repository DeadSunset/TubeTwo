const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..', '..');
const dataDir = path.join(ROOT, 'data');
const dbPath = path.join(dataDir, 'mytube.db');

function ensureDataFolders() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'thumbnails'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source_path TEXT NOT NULL UNIQUE,
      source_type TEXT NOT NULL CHECK(source_type IN ('channel', 'common')),
      is_available INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER,
      title TEXT NOT NULL,
      slug TEXT,
      avatar_path TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      channel_id INTEGER NOT NULL,
      playlist_path TEXT,
      duration_sec INTEGER,
      video_type TEXT NOT NULL CHECK(video_type IN ('video', 'shorts')),
      thumb_path TEXT,
      source_url TEXT,
      source_type TEXT CHECK(source_type IN ('youtube_url', 'html_video', 'html_channel')),
      views_online INTEGER,
      likes_online INTEGER,
      views_local INTEGER NOT NULL DEFAULT 0,
      liked_by_me INTEGER NOT NULL DEFAULT 0,
      last_time_sec INTEGER NOT NULL DEFAULT 0,
      is_finished INTEGER NOT NULL DEFAULT 0,
      last_watched_at TEXT,
      is_available INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      external_id TEXT,
      author_name TEXT NOT NULL,
      text_content TEXT NOT NULL,
      likes_count INTEGER DEFAULT 0,
      parent_external_id TEXT,
      comment_type TEXT NOT NULL CHECK(comment_type IN ('imported', 'local')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS error_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      error_type TEXT NOT NULL,
      error_code TEXT,
      message TEXT NOT NULL,
      payload_json TEXT,
      is_resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);
    CREATE INDEX IF NOT EXISTS idx_videos_title ON videos(title);
    CREATE INDEX IF NOT EXISTS idx_comments_video_id ON comments(video_id);
  `);

  const systemChannel = db.prepare('SELECT id FROM channels WHERE is_system = 1').get();
  if (!systemChannel) {
    db.prepare(`
      INSERT INTO channels (title, slug, is_system)
      VALUES (?, ?, 1)
    `).run('Общий канал', 'common-channel');
  }
}

function initDb() {
  ensureDataFolders();
  const db = new Database(dbPath);
  createSchema(db);
  return db;
}

module.exports = {
  dbPath,
  initDb,
};
