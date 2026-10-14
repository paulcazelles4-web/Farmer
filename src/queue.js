// language: JavaScript, file: queue.js
const { query, one, many } = require('./db');
const config = require('./config');
const { joinGuild } = require('./oauth');

async function getQueue() {
  return many(`SELECT * FROM queue WHERE status = 'pending' ORDER BY priority DESC, position ASC, id ASC`);
}

async function addToQueue(guildId, requesterId, amount) {
  const row = await one(`SELECT COUNT(*)::int AS c FROM queue WHERE status = 'pending'`);
  if (row.c >= config.QUEUE_MAX) return { ok: false, reason: 'queue_full' };
  const pos = row.c + 1;
  const info = await one(
    `INSERT INTO queue (guild_id, requester_id, amount, position) VALUES ($1, $2, $3, $4) RETURNING id`,
    [guildId, requesterId, amount, pos]
  );
  return { ok: true, id: info.id, position: pos };
}

async function clearQueue() {
  await query(`UPDATE queue SET status = 'cleared' WHERE status = 'pending'`);
}

async function removeFromQueue(guildId) {
  await query(`UPDATE queue SET status = 'removed' WHERE guild_id = $1 AND status = 'pending'`, [guildId]);
  await reindex();
}

async function reindex() {
  const rows = await getQueue();
  for (let i = 0; i < rows.length; i++) {
    await query('UPDATE queue SET position = $1 WHERE id = $2', [i + 1, rows[i].id]);
  }
}

async function setPriority(guildId) {
  await query(`UPDATE queue SET priority = 1 WHERE guild_id = $1 AND status = 'pending'`, [guildId]);
  await reindex();
}

async function moveQueue(guildId, newPos) {
  const rows = await getQueue();
  const target = rows.find(r => r.guild_id === guildId);
  if (!target) return false;
  const filtered = rows.filter(r => r.guild_id !== guildId);
  filtered.splice(Math.max(0, newPos - 1), 0, target);
  for (let i = 0; i < filtered.length; i++) {
    await query('UPDATE queue SET position = $1 WHERE id = $2', [i + 1, filtered[i].id]);
  }
  return true;
}

async function pauseQueue() {
  await query(`INSERT INTO settings (key, value) VALUES ('queue_paused', '1') ON CONFLICT (key) DO UPDATE SET value = '1'`);
}
async function resumeQueue() {
  await query(`INSERT INTO settings (key, value) VALUES ('queue_paused', '0') ON CONFLICT (key) DO UPDATE SET value = '0'`);
}
async function isPaused() {
  const row = await one(`SELECT value FROM settings WHERE key = 'queue_paused'`);
  return row?.value === '1';
}

async function processOne(client) {
  if (await isPaused()) return;
  const item = await one(`SELECT * FROM queue WHERE status = 'pending' ORDER BY priority DESC, position ASC LIMIT 1`);
  if (!item) return;

  const stock = await many(
    `SELECT s.token_id, t.access_token, t.user_id FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1`
  );
  if (!stock.length) {
    await query(`UPDATE queue SET status = 'failed_nostock' WHERE id = $1`, [item.id]);
    await reindex();
    return;
  }

  let sent = 0;
  for (const s of stock) {
    if (sent >= item.amount) break;
    try {
      const guild = client.guilds.cache.get(item.guild_id);
      if (guild) {
        const existing = await guild.members.fetch(s.user_id).catch(() => null);
        if (existing) {
          await query('DELETE FROM stock WHERE token_id = $1', [s.token_id]);
          continue;
        }
      }
      const ok = await joinGuild(s.access_token, item.guild_id, s.user_id);
      if (ok) {
        sent++;
        await query(
          `INSERT INTO joins (guild_id, token_id, requester_id, success) VALUES ($1, $2, $3, 1)`,
          [item.guild_id, s.token_id, item.requester_id]
        );
        await query('DELETE FROM stock WHERE token_id = $1', [s.token_id]);
        console.log(`joined user=${s.user_id} -> guild=${item.guild_id}`);
      }
    } catch (e) {
      console.error('join fail', e.message);
    }
  }

  const status = sent > 0 ? 'done' : 'failed';
  await query('UPDATE queue SET status = $1 WHERE id = $2', [status, item.id]);
  await query(
    `UPDATE profiles SET members_received = members_received + $1, last_command_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE user_id = $2`,
    [sent, item.requester_id]
  );
  console.log(`queue item ${item.id} sent=${sent}/${item.amount} status=${status}`);
  await reindex();
}

module.exports = {
  getQueue, addToQueue, clearQueue, removeFromQueue,
  setPriority, moveQueue, pauseQueue, resumeQueue, isPaused, processOne, reindex,
};
