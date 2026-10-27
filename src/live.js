// language: JavaScript, file: live.js — stock, queue, public status panels
const { EmbedBuilder } = require('discord.js');
const { one, many, getSetting, setSetting } = require('./db');
const { getEmbedColor } = require('./embed_util');
const config = require('./config');
const perms = require('./permissions');

const TICK_MS = 5000;
let tickerStarted = false;

function getQueueMod() {
  try {
    return require('./queue');
  } catch {
    return null;
  }
}

async function stockCount() {
  const row = await one(
    'SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1'
  );
  return Number(row?.c) || 0;
}

function clock() {
  return new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm ' + sec + 's';
}

async function buildStockEmbed() {
  const color = await getEmbedColor();
  const count = await stockCount();
  return new EmbedBuilder()
    .setTitle('📦 Live Stock')
    .setColor(color)
    .setDescription('This panel auto-updates every 5 seconds.')
    .addFields({ name: 'In Stock', value: '`' + count + '`' })
    .setFooter({ text: 'Member Farm · live · ' + clock() })
    .setTimestamp();
}

async function resolveUsername(client, userId) {
  if (!userId) return 'unknown';
  try {
    if (client?.users) {
      const u = await client.users.fetch(userId).catch(() => null);
      if (u) return u.username || u.tag || userId;
    }
  } catch {}
  return userId;
}

async function buildQueueEmbed(client) {
  const color = await getEmbedColor();
  const q = getQueueMod();
  let rows = [];
  let paused = false;
  try {
    if (q) {
      rows = await q.getQueue();
      paused = await q.isPaused();
    }
  } catch {}
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = await resolveUsername(client, r.requester_id);
    lines.push(
      '**#' + (i + 1) + '** `' + name + '` → `' + r.guild_id + '` ×' + r.amount
    );
  }
  const desc = lines.length ? lines.join('\n') : '_Queue empty._';
  return new EmbedBuilder()
    .setTitle('📋 Live Queue' + (paused ? ' · PAUSED' : ''))
    .setColor(paused ? 0xfaa61a : color)
    .setDescription(desc.slice(0, 4000))
    .setFooter({ text: 'Member Farm · live · ' + clock() })
    .setTimestamp();
}

async function buildStatusEmbed(client) {
  const color = await getEmbedColor();
  const maint = await perms.isMaintenance();
  const q = getQueueMod();
  let queueLen = 0;
  let paused = false;
  try {
    if (q) {
      const rows = await q.getQueue();
      queueLen = rows.length;
      paused = await q.isPaused();
    }
  } catch {}

  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;

  const joins24 =
    (
      await one(
        `SELECT COUNT(*)::int AS c FROM joins WHERE success = 1 AND created_at >= $1`,
        [dayAgo]
      )
    )?.c || 0;
  const jobsDone24 =
    (
      await one(
        `SELECT COUNT(*)::int AS c FROM queue WHERE status IN ('done','failed','failed_nostock') AND created_at >= $1`,
        [dayAgo]
      )
    )?.c || 0;
  const uniqueUsers24 =
    (
      await one(
        `SELECT COUNT(DISTINCT requester_id)::int AS c FROM joins WHERE created_at >= $1`,
        [dayAgo]
      )
    )?.c || 0;
  const pendingRetries =
    (
      await one(
        `SELECT COUNT(*)::int AS c FROM queue WHERE status = 'pending' AND next_attempt_at IS NOT NULL`
      )
    )?.c || 0;

  const guilds = client.guilds?.cache?.size || 0;
  const ping = client.ws?.ping != null ? Math.round(client.ws.ping) : null;
  const uptime = client.bootAt ? formatUptime(Date.now() - client.bootAt) : formatUptime(process.uptime() * 1000);
  const ready = !!client.user && client.ws?.status === 0;

  // Non-sensitive operational picture only — no tokens, no stock numbers
  return new EmbedBuilder()
    .setTitle('Member Farm · Public Status')
    .setColor(maint ? 0xed4245 : ready ? 0x57f287 : 0xfaa61a)
    .setDescription(
      ready
        ? 'Bot is **online** and accepting the normal command flow (subject to maintenance and permissions).'
        : 'Bot process is starting or reconnecting.'
    )
    .addFields(
      { name: 'Status', value: ready ? '`Online`' : '`Connecting`', inline: true },
      { name: 'Maintenance', value: maint ? '`ENABLED`' : '`Off`', inline: true },
      { name: 'Uptime', value: '`' + uptime + '`', inline: true },
      { name: 'Websocket', value: ping != null ? '`' + ping + ' ms`' : '`—`', inline: true },
      { name: 'Servers (bot in)', value: '`' + guilds + '`', inline: true },
      { name: 'Queue', value: paused ? '`Paused` · `' + queueLen + '`' : '`Running` · `' + queueLen + '`', inline: true },
      { name: 'Retries scheduled', value: '`' + pendingRetries + '`', inline: true },
      { name: 'Successful joins (24h)', value: '`' + joins24 + '`', inline: true },
      { name: 'Jobs closed (24h)', value: '`' + jobsDone24 + '`', inline: true },
      { name: 'Active requesters (24h)', value: '`' + uniqueUsers24 + '`', inline: true },
      {
        name: 'Notes',
        value:
          'Stock size and token data are **not** shown on this public panel.\n' +
          'Delivery reports are sent privately to requesters (no tokens).',
      }
    )
    .setFooter({ text: 'Auto-updates · ' + clock() })
    .setTimestamp();
}

async function resolveChannel(client, name, settingKey) {
  const saved = await getSetting(settingKey, '');
  if (saved) {
    const ch = await client.channels.fetch(saved).catch(() => null);
    if (ch && ch.isTextBased()) return ch;
  }
  const guildId = config.MAIN_GUILD_ID || '1499704751481294878';
  const guild =
    client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) {
    console.error('live: main guild not found', guildId);
    return null;
  }
  try {
    await guild.channels.fetch();
  } catch {}

  const target = String(name).toLowerCase();
  const plain = target.replace(/^・/, '').replace(/^\./, '').trim();

  let found = guild.channels.cache.find((c) => c.isTextBased() && c.name.toLowerCase() === target);
  if (!found) {
    found = guild.channels.cache.find(
      (c) =>
        c.isTextBased() &&
        (c.name.toLowerCase() === plain ||
          c.name.toLowerCase().endsWith(plain) ||
          c.name.toLowerCase().includes(plain))
    );
  }
  return found || null;
}

async function upsertPanel(client, channel, messageIdKey, embed) {
  const mid = await getSetting(messageIdKey, '');
  if (mid) {
    try {
      const msg = await channel.messages.fetch(mid);
      await msg.edit({ embeds: [embed] });
      return msg;
    } catch {
      await setSetting(messageIdKey, '');
    }
  }
  const sent = await channel.send({ embeds: [embed] });
  await setSetting(messageIdKey, sent.id);
  return sent;
}

async function refreshLiveStock(client) {
  if (!client?.user) return;
  try {
    const ch = await resolveChannel(client, '・stock', 'live_stock_channel_id');
    if (!ch) return;
    const embed = await buildStockEmbed();
    await upsertPanel(client, ch, 'live_stock_message_id', embed);
  } catch (e) {
    console.error('refreshLiveStock', e.message);
  }
}

async function refreshLiveQueue(client) {
  if (!client?.user) return;
  try {
    const ch = await resolveChannel(client, '・queue', 'live_queue_channel_id');
    if (!ch) return;
    const embed = await buildQueueEmbed(client);
    await upsertPanel(client, ch, 'live_queue_message_id', embed);
  } catch (e) {
    console.error('refreshLiveQueue', e.message);
  }
}

async function refreshLiveStatus(client) {
  if (!client?.user) return;
  try {
    const ch = await resolveChannel(client, '・status', 'live_status_channel_id');
    if (!ch) return;
    const embed = await buildStatusEmbed(client);
    await upsertPanel(client, ch, 'live_status_message_id', embed);
  } catch (e) {
    console.error('refreshLiveStatus', e.message);
  }
}

async function refreshLiveAll(client) {
  await refreshLiveStock(client);
  await refreshLiveQueue(client);
  await refreshLiveStatus(client);
}

function startLiveTicker(client) {
  if (tickerStarted) return;
  tickerStarted = true;
  console.log('Live panels ticker: every ' + TICK_MS / 1000 + 's');
  setInterval(() => {
    refreshLiveAll(client).catch((e) => console.error('live tick', e.message));
  }, TICK_MS);
  setTimeout(() => refreshLiveAll(client).catch(() => {}), 2500);
}

async function postLiveStock() {}
async function postLiveQueue() {}
async function stopLive(settingKey) {
  if (settingKey === 'live_stock') await setSetting('live_stock_message_id', '');
  else if (settingKey === 'live_queue') await setSetting('live_queue_message_id', '');
  else if (settingKey === 'live_status') await setSetting('live_status_message_id', '');
}

async function setLiveChannel(client, kind, channel) {
  if (!channel || !channel.isTextBased()) throw new Error('Not a text channel');
  if (kind === 'stock') {
    await setSetting('live_stock_channel_id', channel.id);
    await setSetting('live_stock_message_id', '');
    const embed = await buildStockEmbed();
    const sent = await channel.send({ embeds: [embed] });
    await setSetting('live_stock_message_id', sent.id);
    return sent;
  }
  if (kind === 'queue') {
    await setSetting('live_queue_channel_id', channel.id);
    await setSetting('live_queue_message_id', '');
    const embed = await buildQueueEmbed(client);
    const sent = await channel.send({ embeds: [embed] });
    await setSetting('live_queue_message_id', sent.id);
    return sent;
  }
  if (kind === 'status') {
    await setSetting('live_status_channel_id', channel.id);
    await setSetting('live_status_message_id', '');
    const embed = await buildStatusEmbed(client);
    const sent = await channel.send({ embeds: [embed] });
    await setSetting('live_status_message_id', sent.id);
    return sent;
  }
  throw new Error('kind must be stock, queue, or status');
}

module.exports = {
  postLiveStock,
  postLiveQueue,
  refreshLiveStock,
  refreshLiveQueue,
  refreshLiveStatus,
  refreshLiveAll,
  startLiveTicker,
  stopLive,
  buildStockEmbed,
  buildQueueEmbed,
  buildStatusEmbed,
  stockCount,
  setLiveChannel,
};
