// language: JavaScript, file: queue.js
const { query, one, many, getSetting, setSetting } = require('./db');
const config = require('./config');
const { joinGuild, ensureFreshToken, refreshAccessToken } = require('./oauth');
const logs = require('./logs');
const live = require('./live');

async function getQueue() {
  return many(
    `SELECT * FROM queue WHERE status = 'pending' ORDER BY priority DESC, position ASC, id ASC`
  );
}

async function addToQueue(guildId, requesterId, amount) {
  const row = await one(`SELECT COUNT(*)::int AS c FROM queue WHERE status = 'pending'`);
  if (row.c >= config.QUEUE_MAX) return { ok: false, reason: 'queue_full' };
  const pos = row.c + 1;
  const info = await one(
    `INSERT INTO queue (guild_id, requester_id, amount, position) VALUES ($1, $2, $3, $4) RETURNING id`,
    [String(guildId), String(requesterId), amount, pos]
  );
  return { ok: true, id: info.id, position: pos };
}

async function clearQueue() {
  await query(`UPDATE queue SET status = 'cleared' WHERE status = 'pending'`);
}

async function removeFromQueue(guildId) {
  await query(`UPDATE queue SET status = 'removed' WHERE guild_id = $1 AND status = 'pending'`, [
    String(guildId),
  ]);
  await reindex();
}

async function clearUserQueue(userId) {
  await query(`UPDATE queue SET status = 'banfarm' WHERE requester_id = $1 AND status = 'pending'`, [
    String(userId),
  ]);
  await reindex();
}

async function reindex() {
  const rows = await getQueue();
  for (let i = 0; i < rows.length; i++) {
    await query('UPDATE queue SET position = $1 WHERE id = $2', [i + 1, rows[i].id]);
  }
}

async function setPriority(guildId) {
  await query(`UPDATE queue SET priority = 1 WHERE guild_id = $1 AND status = 'pending'`, [
    String(guildId),
  ]);
  await reindex();
}

async function moveQueue(guildId, newPos) {
  const rows = await getQueue();
  const target = rows.find((r) => r.guild_id === guildId);
  if (!target) return false;
  const filtered = rows.filter((r) => r.guild_id !== guildId);
  filtered.splice(Math.max(0, newPos - 1), 0, target);
  for (let i = 0; i < filtered.length; i++) {
    await query('UPDATE queue SET position = $1 WHERE id = $2', [i + 1, filtered[i].id]);
  }
  return true;
}

async function pauseQueue() {
  await setSetting('queue_paused', '1');
}
async function resumeQueue() {
  await setSetting('queue_paused', '0');
}
async function isPaused() {
  return (await getSetting('queue_paused', '0')) === '1';
}

async function bumpRateLimit() {
  const now = Date.now();
  const windowMs = 60_000;
  const key = 'rate_limit_hits';
  const raw = await getSetting(key, '[]');
  let hits = [];
  try { hits = JSON.parse(raw) || []; } catch { hits = []; }
  hits = hits.filter((t) => now - t < windowMs);
  hits.push(now);
  await setSetting(key, JSON.stringify(hits));
  if (hits.length >= 5) {
    await pauseQueue();
    return true;
  }
  return false;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function processOne(client) {
  if (await isPaused()) return;
  const item = await one(
    `SELECT * FROM queue WHERE status = 'pending' ORDER BY priority DESC, position ASC LIMIT 1`
  );
  if (!item) return;

  let stock = await many(
    `SELECT s.token_id, t.id AS tid, t.access_token, t.refresh_token, t.expires_at, t.user_id
     FROM stock s
     JOIN tokens t ON t.id = s.token_id
     WHERE t.valid = 1`
  );

  if (!stock.length) {
    await query(`UPDATE queue SET status = 'failed_nostock' WHERE id = $1`, [item.id]);
    if (client) {
      logs.farmLog(
        client,
        'Queue failed — no stock',
        `Guild \`${item.guild_id}\` · requester <@${item.requester_id}>`,
        0xed4245
      );
    }
    await reindex();
    try { await live.refreshLiveAll(client); } catch (e) {}
    return;
  }

  stock = shuffle(stock);

  let joined = 0,
    alreadyIn = 0,
    maxed = 0,
    phoneLocked = 0,
    deauthorized = 0;
  let terminated = 0,
    banned = 0,
    transient = 0;

  for (const s of stock) {
    if (joined >= item.amount) break;

    try {
      const guild = client.guilds.cache.get(item.guild_id);
      if (guild) {
        const existing = await guild.members.fetch(s.user_id).catch(() => null);
        if (existing) {
          alreadyIn++;
          await query(
            `INSERT INTO joins (guild_id, token_id, requester_id, success, detail) VALUES ($1, $2, $3, 0, 'already')`,
            [item.guild_id, s.token_id, item.requester_id]
          );
          continue;
        }
      }

      let access = await ensureFreshToken({
        id: s.tid || s.token_id,
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at,
      });

      try {
        const gr = await fetch('https://discord.com/api/v10/users/@me/guilds', {
          headers: { Authorization: 'Bearer ' + access },
        });
        if (gr.status === 200) {
          const glist = await gr.json();
          if (Array.isArray(glist) && glist.length >= 100) {
            maxed++;
            await query('DELETE FROM stock WHERE token_id = $1', [s.token_id]);
            await query(
              `INSERT INTO joins (guild_id, token_id, requester_id, success, detail) VALUES ($1, $2, $3, 0, 'maxed_guilds')`,
              [item.guild_id, s.token_id, item.requester_id]
            );
            continue;
          }
          if (Array.isArray(glist) && glist.some((g) => String(g.id) === String(item.guild_id))) {
            alreadyIn++;
            await query(
              `INSERT INTO joins (guild_id, token_id, requester_id, success, detail) VALUES ($1, $2, $3, 0, 'already')`,
              [item.guild_id, s.token_id, item.requester_id]
            );
            continue;
          }
        }
      } catch (e) {}

      let result = await joinGuild(access, item.guild_id, s.user_id);

      if (!result.ok && result.code === 'deauth' && s.refresh_token) {
        const forced = await refreshAccessToken({
          id: s.tid || s.token_id,
          refresh_token: s.refresh_token,
        });
        if (forced) {
          access = forced;
          result = await joinGuild(access, item.guild_id, s.user_id);
        }
      }

      if (result.ok && result.code === 'joined') {
        joined++;
        await query(
          `INSERT INTO joins (guild_id, token_id, requester_id, success, detail) VALUES ($1, $2, $3, 1, 'joined')`,
          [item.guild_id, s.token_id, item.requester_id]
        );
        console.log(`joined user=${s.user_id} -> guild=${item.guild_id} (stock kept)`);
      } else if (result.ok && result.code === 'already') {
        alreadyIn++;
        await query(
          `INSERT INTO joins (guild_id, token_id, requester_id, success, detail) VALUES ($1, $2, $3, 0, 'already')`,
          [item.guild_id, s.token_id, item.requester_id]
        );
      } else {
        const code = result.code;
        if (code === 'rate_limit') {
          transient++;
          const triggered = await bumpRateLimit();
          if (triggered && client) {
            logs.adminLog(client, 'AntiRaid Triggered', 'Queue paused after repeated 429s.');
          }
          break;
        } else if (code === 'deauth') {
          deauthorized++;
          await query('UPDATE tokens SET valid = 0 WHERE id = $1', [s.token_id]);
          await query('DELETE FROM stock WHERE token_id = $1', [s.token_id]);
        } else if (code === 'maxed') {
          maxed++;
          await query('DELETE FROM stock WHERE token_id = $1', [s.token_id]);
        } else if (code === 'phone') {
          phoneLocked++;
          await query('DELETE FROM stock WHERE token_id = $1', [s.token_id]);
        } else if (code === 'banned') {
          banned++;
        } else {
          transient++;
        }
        await query(
          `INSERT INTO joins (guild_id, token_id, requester_id, success, detail) VALUES ($1, $2, $3, 0, $4)`,
          [item.guild_id, s.token_id, item.requester_id, code]
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      transient++;
      console.error('join fail', e.message);
    }
  }

  const stockLeft = (
    await one(
      'SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1'
    )
  ).c;

  let status;
  if (joined > 0) status = 'done';
  else if (transient > 0 && joined === 0 && alreadyIn === 0) status = 'pending';
  else status = 'failed';

  if (status !== 'pending') {
    await query('UPDATE queue SET status = $1 WHERE id = $2', [status, item.id]);
  }

  if (joined > 0) {
    await query(
      `INSERT INTO profiles (user_id, members_received, commands_used, last_command_at)
       VALUES ($2, $1, 0, EXTRACT(EPOCH FROM NOW())::BIGINT)
       ON CONFLICT (user_id) DO UPDATE SET
         members_received = profiles.members_received + $1,
         last_command_at = EXTRACT(EPOCH FROM NOW())::BIGINT`,
      [joined, item.requester_id]
    );
  }

  try {
    const user = await client.users.fetch(item.requester_id).catch(() => null);
    logs.djoinLog(client, {
      userTag: user?.tag || item.requester_id,
      userId: item.requester_id,
      guildId: item.guild_id,
      joined,
      alreadyIn,
      maxed,
      phoneLocked,
      deauthorized,
      terminated,
      banned,
      transient,
      stockLeft,
      tier: `x${item.amount}`,
    });
  } catch (e) {
    console.error('djoin log', e.message);
  }

  console.log(`queue item ${item.id} joined=${joined}/${item.amount} status=${status}`);
  await reindex();
  try { await live.refreshLiveAll(client); } catch (e) { console.error('live refresh', e.message); }
}

module.exports = {
  getQueue,
  addToQueue,
  clearQueue,
  removeFromQueue,
  clearUserQueue,
  setPriority,
  moveQueue,
  pauseQueue,
  resumeQueue,
  isPaused,
  processOne,
  reindex,
};
