// language: JavaScript, file: db.js — Postgres via DATABASE_URL
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function one(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

async function many(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}

async function init() {
  await query(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at BIGINT,
  scope TEXT,
  added_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT),
  last_used BIGINT,
  valid INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stock (
  token_id INTEGER PRIMARY KEY REFERENCES tokens(id) ON DELETE CASCADE
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
  added_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
);
CREATE TABLE IF NOT EXISTS queue (
  id SERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  position INTEGER,
  priority INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
);
CREATE TABLE IF NOT EXISTS joins (
  id SERIAL PRIMARY KEY,
  guild_id TEXT,
  token_id INTEGER,
  requester_id TEXT,
  success INTEGER,
  created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY,
  members_received INTEGER DEFAULT 0,
  commands_used INTEGER DEFAULT 0,
  last_command_at BIGINT,
  guilds_added TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS maintenance_allowed (
  user_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS cooldowns (
  user_id TEXT PRIMARY KEY,
  last_join BIGINT
);
CREATE TABLE IF NOT EXISTS auth_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_all_time INTEGER DEFAULT 0,
  last_24h INTEGER DEFAULT 0,
  last_24h_reset BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
);
INSERT INTO auth_stats (id, total_all_time, last_24h) VALUES (1, 0, 0)
ON CONFLICT (id) DO NOTHING;
`);
  console.log('Postgres schema ready');
}

async function getSetting(key, fallback = null) {
  const row = await one('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

module.exports = { pool, query, one, many, init, getSetting, setSetting };
