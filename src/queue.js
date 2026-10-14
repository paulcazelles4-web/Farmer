// language: JavaScript, file: queue.js
const { db } = require('./db');
const config = require('./config');
const { joinGuild } = require('./oauth');

function getQueue() {
  return db.prepare('SELECT * FROM queue WHERE status = ? ORDER BY priority DESC, position ASC, id ASC').all('pending');
}

function addToQueue(guildId, requesterId, amount) {
  const count = db.prepare('SELECT COUNT(*) as c FROM queue WHERE status = ?').get('pending').c;
  if (count >= config.QUEUE_MAX) return { ok: false, reason: 'queue_full' };
  const pos = count + 1;
  const info = db.prepare('INSERT INTO queue (guild_id, requester_id, amount, position) VALUES (?, ?, ?, ?)').run(guildId, requesterId, amount, pos);
  return { ok: true, id: info.lastInsertRowid, position: pos };
}

function clearQueue() {
  db.prepare('UPDATE queue SET status = ? WHERE status = ?').run('cleared', 'pending');
}

function removeFromQueue(guildId) {
  db.prepare('UPDATE queue SET status = ? WHERE guild_id = ? AND status = ?').run('removed', guildId, 'pending');
  reindex();
}

function reindex() {
  const rows = getQueue();
  const upd = db.prepare('UPDATE queue SET position = ? WHERE id = ?');
  rows.forEach((r, i) => upd.run(i + 1, r.id));
}

function setPriority(guildId) {
  db.prepare('UPDATE queue SET priority = 1 WHERE guild_id = ? AND status = ?').run(guildId, 'pending');
  reindex();
}

function moveQueue(guildId, newPos) {
  const rows = getQueue();
  const target = rows.find(r => r.guild_id === guildId);
  if (!target) return false;
  const filtered = rows.filter(r => r.guild_id !== guildId);
  filtered.splice(Math.max(0, newPos - 1), 0, target);
  const upd = db.prepare('UPDATE queue SET position = ? WHERE id = ?');
  filtered.forEach((r, i) => upd.run(i + 1, r.id));
  return true;
}

function pauseQueue() {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('queue_paused', '1');
}
function resumeQueue() {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('queue_paused', '0');
}
function isPaused() {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get('queue_paused')?.value === '1';
}

async function processOne(client) {
  if (isPaused()) return;
  const item = db.prepare('SELECT * FROM queue WHERE status = ? ORDER BY priority DESC, position ASC LIMIT 1').get('pending');
  if (!item) return;

  const stock = db.prepare(
    'SELECT s.token_id, t.access_token, t.user_id FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1'
  ).all();

  if (!stock.length) {
    console.log('queue: no stock for', item.guild_id);
    db.prepare('UPDATE queue SET status = ? WHERE id = ?').run('failed_nostock', item.id);
    reindex();
    return;
  }

  let sent = 0;
  for (const s of stock) {
    if (sent >= item.amount) break;
    try {
      // skip if already in guild (bot cache)
      const guild = client.guilds.cache.get(item.guild_id);
      if (guild) {
        const existing = await guild.members.fetch(s.user_id).catch(() => null);
        if (existing) {
          console.log(`skip already in guild user=${s.user_id}`);
          db.prepare('DELETE FROM stock WHERE token_id = ?').run(s.token_id);
          continue;
        }
      }

      const ok = await joinGuild(s.access_token, item.guild_id, s.user_id);
      if (ok) {
        sent++;
        db.prepare('INSERT INTO joins (guild_id, token_id, requester_id, success) VALUES (?, ?, ?, 1)').run(
          item.guild_id, s.token_id, item.requester_id
        );
        db.prepare('DELETE FROM stock WHERE token_id = ?').run(s.token_id);
        console.log(`joined user=${s.user_id} -> guild=${item.guild_id}`);
      }
    } catch (e) {
      console.error('join fail', e.message);
    }
  }

  const status = sent > 0 ? 'done' : 'failed';
  db.prepare('UPDATE queue SET status = ? WHERE id = ?').run(status, item.id);
  db.prepare(
    `UPDATE profiles SET members_received = members_received + ?, last_command_at = strftime('%s','now') WHERE user_id = ?`
  ).run(sent, item.requester_id);
  console.log(`queue item ${item.id} guild=${item.guild_id} sent=${sent}/${item.amount} status=${status}`);
  reindex();
}

module.exports = {
  getQueue, addToQueue, clearQueue, removeFromQueue,
  setPriority, moveQueue, pauseQueue, resumeQueue, isPaused, processOne, reindex,
};
