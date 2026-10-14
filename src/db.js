// language: JavaScript, file: db.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'farm.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  scope TEXT,
  added_at INTEGER DEFAULT (strftime('%s','now')),
  last_used INTEGER,
  valid INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stock (
  token_id INTEGER PRIMARY KEY,
  FOREIGN KEY(token_id) REFERENCES tokens(id)
);
CREATE TABLE IF NOT EXISTS grants (
  user_id TEXT NOT NULL,
  command TEXT NOT NULL,
  PRIMARY KEY(user_id, command)
);
CREATE TABLE IF NOT EXISTS role_bonus (
  role_id TEXT PRIMARY KEY,
  bonus INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blacklist (
  guild_id TEXT PRIMARY KEY,
  reason TEXT,
  added_by TEXT,
  added_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  position INTEGER,
  priority INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS joins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  token_id INTEGER,
  requester_id TEXT,
  success INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY,
  members_received INTEGER DEFAULT 0,
  commands_used INTEGER DEFAULT 0,
  last_command_at INTEGER,
  guilds_added TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS maintenance_allowed (
  user_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS cooldowns (
  user_id TEXT PRIMARY KEY,
  last_join INTEGER
);
CREATE TABLE IF NOT EXISTS auth_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_all_time INTEGER DEFAULT 0,
  last_24h INTEGER DEFAULT 0,
  last_24h_reset INTEGER DEFAULT (strftime('%s','now'))
);
INSERT OR IGNORE INTO auth_stats (id, total_all_time, last_24h) VALUES (1, 0, 0);
`);

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

module.exports = { db, getSetting, setSetting };
