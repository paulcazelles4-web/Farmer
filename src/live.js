// language: JavaScript, file: live.js
const { EmbedBuilder } = require('discord.js');
const { one, getSetting, setSetting } = require('./db');
const { getEmbedColor } = require('./embed_util');

const TICK_MS = 5000;
let tickCount = 0;
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

async function buildStockEmbed() {
  const color = await getEmbedColor();
  const count = await stockCount();
  const valid = Number((await one('SELECT COUNT(*)::int AS c FROM tokens WHERE valid = 1'))?.c) || 0;
  const paused = (await getSetting('queue_paused', '0')) === '1';
  const now = new Date();
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return new EmbedBuilder()
    .setTitle('📦 Live Stock')
    .setColor(color)
    .setDescription('Auto-refresh · `?stock stop` to disable · you can delete this message')
    .addFields(
      { name: 'In Stock', value: '`' + count + '`', inline: true },
      { name: 'Valid Auths', value: '`' + valid + '`', inline: true },
      { name: 'Queue', value: paused ? '`paused`' : '`running`', inline: true }
    )
    .setFooter({ text: 'Member Farm · live · ' + time })
    .setTimestamp();
}

async function buildQueueEmbed() {
  const color = await getEmbedColor();
  const q = getQueueMod();
  const rows = q ? await q.getQueue() : [];
  const paused = (await getSetting('queue_paused', '0')) === '1';
  const now = new Date();
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let desc;
  if (!rows.length) {
    desc = paused ? 'Queue empty · **paused**' : 'Queue empty.';
  } else {
    const lines = rows.slice(0, 25).map((r) => {
      const pri = Number(r.priority) ? '⚡ ' : '';
      return pri + '**#' + r.position + '** `' + r.guild_id + '` ×`' + r.amount + '` · <@' + r.requester_id + '>';
    });
    if (rows.length > 25) lines.push('_… +' + (rows.length - 25) + ' more_');
    desc = (paused ? '**PAUSED**\n' : '') + lines.join('\n');
  }
  return new EmbedBuilder()
    .setTitle('📋 Live Queue')
    .setColor(paused ? 0xfaa61a : color)
    .setDescription(desc + '\n\n_Auto-refresh · `?queue stop`_')
    .addFields({ name: 'Pending', value: '`' + rows.length + '`', inline: true })
    .setFooter({ text: 'Member Farm · live · ' + time })
    .setTimestamp();
}

async function readPointer(settingKey) {
  const raw = await getSetting(settingKey, '');
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j && j.channelId && j.messageId) return { channelId: String(j.channelId), messageId: String(j.messageId) };
  } catch (e) {
    console.error('live pointer parse', settingKey, e.message);
  }
  return null;
}

async function savePointer(settingKey, channelId, messageId) {
  await setSetting(settingKey, JSON.stringify({ channelId: String(channelId), messageId: String(messageId) }));
}

async function editOrCreate(client, settingKey, channel, embed) {
  const ptr = await readPointer(settingKey);

  if (ptr && String(ptr.channelId) === String(channel.id)) {
    try {
      const msg = await channel.messages.fetch(ptr.messageId);
      await msg.edit({ embeds: [embed] });
      return msg;
    } catch (e) {
      console.error('live editOrCreate edit fail', e.message);
    }
  }

  if (ptr && String(ptr.channelId) !== String(channel.id)) {
    try {
      const ch = await client.channels.fetch(ptr.channelId).catch(() => null);
      if (ch) {
        const old = await ch.messages.fetch(ptr.messageId).catch(() => null);
        if (old) await old.delete().catch(() => {});
      }
    } catch {}
  }

  const sent = await channel.send({ embeds: [embed] });
  await savePointer(settingKey, channel.id, sent.id);
  return sent;
}

async function refreshFromStored(client, settingKey, buildEmbed) {
  if (!client) return;
  const ptr = await readPointer(settingKey);
  if (!ptr) return;
  try {
    const ch = await client.channels.fetch(ptr.channelId);
    if (!ch) return;
    const msg = await ch.messages.fetch(ptr.messageId);
    const embed = await buildEmbed();
    await msg.edit({ embeds: [embed] });
  } catch (e) {
    const code = e.code || e.status;
    console.error('live refresh', settingKey, code || '', e.message);
    if (code === 10008 || code === 10003 || String(e.message || '').toLowerCase().includes('unknown')) {
      await setSetting(settingKey, '');
    }
  }
}

async function stopLive(settingKey, client) {
  const ptr = await readPointer(settingKey);
  await setSetting(settingKey, '');
  if (!ptr || !client) return false;
  try {
    const ch = await client.channels.fetch(ptr.channelId).catch(() => null);
    if (!ch) return true;
    const msg = await ch.messages.fetch(ptr.messageId).catch(() => null);
    if (msg) await msg.delete().catch(() => {});
    return true;
  } catch {
    return true;
  }
}

async function postLiveStock(message, client) {
  const embed = await buildStockEmbed();
  await editOrCreate(client, 'live_stock', message.channel, embed);
  await message.delete().catch(() => {});
}

async function postLiveQueue(message, client) {
  const embed = await buildQueueEmbed();
  await editOrCreate(client, 'live_queue', message.channel, embed);
  await message.delete().catch(() => {});
}

async function refreshLiveStock(client) {
  await refreshFromStored(client, 'live_stock', buildStockEmbed);
}

async function refreshLiveQueue(client) {
  await refreshFromStored(client, 'live_queue', buildQueueEmbed);
}

async function refreshLiveAll(client) {
  tickCount++;
  await refreshLiveStock(client);
  await refreshLiveQueue(client);
}

function startLiveTicker(client) {
  if (tickerStarted) return;
  tickerStarted = true;
  console.log('Live ticker started (every ' + TICK_MS / 1000 + 's)');
  setInterval(() => {
    refreshLiveAll(client).catch((e) => console.error('live tick', e.message));
  }, TICK_MS);
  setTimeout(() => refreshLiveAll(client).catch(() => {}), 2000);
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
};
