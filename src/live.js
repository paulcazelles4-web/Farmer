// language: JavaScript, file: live.js
const { EmbedBuilder } = require('discord.js');
const { one, getSetting, setSetting } = require('./db');
const { getEmbedColor } = require('./embed_util');
const config = require('./config');

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
      const cached = client.users.cache.get(String(userId));
      if (cached) return cached.username || cached.tag || String(userId);
      const u = await client.users.fetch(String(userId)).catch(() => null);
      if (u) return u.username || u.tag || String(userId);
    }
  } catch {}
  return String(userId);
}

async function buildQueueEmbed(client) {
  const color = await getEmbedColor();
  const q = getQueueMod();
  const rows = q ? await q.getQueue() : [];
  const paused = (await getSetting('queue_paused', '0')) === '1';
  let desc;
  if (!rows.length) {
    desc = paused ? 'Queue empty · **paused**' : 'Queue empty.';
  } else {
    const lines = [];
    for (const r of rows.slice(0, 25)) {
      const pri = Number(r.priority) ? '⚡ ' : '';
      const name = await resolveUsername(client, r.requester_id);
      // name · serverID · amount
      lines.push(
        pri +
          '**#' +
          r.position +
          '** `' +
          name +
          '` → `' +
          r.guild_id +
          '` ×`' +
          r.amount +
          '`'
      );
    }
    if (rows.length > 25) lines.push('_… +' + (rows.length - 25) + ' more_');
    desc = (paused ? '**PAUSED**\n' : '') + lines.join('\n');
  }
  return new EmbedBuilder()
    .setTitle('📋 Live Queue')
    .setColor(paused ? 0xfaa61a : color)
    .setDescription(desc + '\n\n_Auto-updates every 5 seconds._')
    .addFields({ name: 'Pending', value: '`' + rows.length + '`', inline: true })
    .setFooter({ text: 'Member Farm · live · ' + clock() })
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

  let found = guild.channels.cache.find(
    (c) => c.isTextBased() && String(c.name).toLowerCase() === target
  );
  if (!found) {
    found = guild.channels.cache.find((c) => {
      if (!c.isTextBased()) return false;
      const n = String(c.name).toLowerCase();
      return n === plain || n.endsWith(plain) || n.includes(plain);
    });
  }
  if (found) {
    await setSetting(settingKey, found.id);
    console.log('live: bound', name, '→', found.id, found.name);
    return found;
  }
  console.error('live: channel not found for', name);
  return null;
}

async function upsertPanel(client, channel, msgSettingKey, embed) {
  if (!channel) return null;
  const msgId = await getSetting(msgSettingKey, '');
  if (msgId) {
    try {
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ embeds: [embed] });
      return msg;
    } catch (e) {
      console.error('live panel edit fail', msgSettingKey, e.message);
    }
  }
  try {
    const recent = await channel.messages.fetch({ limit: 30 });
    const mine = recent.find(
      (m) =>
        m.author.id === client.user.id &&
        m.embeds[0] &&
        (m.embeds[0].title || '').includes('Live')
    );
    if (mine) {
      await mine.edit({ embeds: [embed] });
      await setSetting(msgSettingKey, mine.id);
      return mine;
    }
  } catch {}

  const sent = await channel.send({ embeds: [embed] });
  await setSetting(msgSettingKey, sent.id);
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

async function refreshLiveAll(client) {
  await refreshLiveStock(client);
  await refreshLiveQueue(client);
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
  throw new Error('kind must be stock or queue');
}

module.exports = {
  postLiveStock,
  postLiveQueue,
  refreshLiveStock,
  refreshLiveQueue,
  refreshLiveAll,
  startLiveTicker,
  stopLive,
  buildStockEmbed,
  buildQueueEmbed,
  stockCount,
  setLiveChannel,
};
