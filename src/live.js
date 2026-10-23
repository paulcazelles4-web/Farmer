// language: JavaScript, file: live.js
const { EmbedBuilder } = require('discord.js');
const { one, getSetting, setSetting } = require('./db');
const queue = require('./queue');
const { getEmbedColor } = require('./embed_util');

const TICK_MS = 10000;

async function stockCount() {
  const row = await one(
    'SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1'
  );
  return row?.c || 0;
}

async function buildStockEmbed() {
  const color = await getEmbedColor();
  const count = await stockCount();
  const valid = (await one('SELECT COUNT(*)::int AS c FROM tokens WHERE valid = 1'))?.c || 0;
  const paused = (await getSetting('queue_paused', '0')) === '1';
  return new EmbedBuilder()
    .setTitle('📦 Live Stock')
    .setColor(color)
    .setDescription('Updates every 10s · delete this message anytime · `?stock stop` to disable')
    .addFields(
      { name: 'In Stock', value: '`' + count + '`', inline: true },
      { name: 'Valid Auths', value: '`' + valid + '`', inline: true },
      { name: 'Queue', value: paused ? '`paused`' : '`running`', inline: true }
    )
    .setFooter({ text: 'Member Farm · live' })
    .setTimestamp();
}

async function buildQueueEmbed() {
  const color = await getEmbedColor();
  const rows = await queue.getQueue();
  const paused = (await getSetting('queue_paused', '0')) === '1';
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
    .setDescription(desc + '\n\n_Updates every 10s · delete anytime · `?queue stop`_')
    .addFields({ name: 'Pending', value: '`' + rows.length + '`', inline: true })
    .setFooter({ text: 'Member Farm · live' })
    .setTimestamp();
}

async function readPointer(settingKey) {
  const raw = await getSetting(settingKey, '');
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j.channelId && j.messageId) return j;
  } catch {}
  return null;
}

async function editOrCreate(client, settingKey, channel, embed) {
  const ptr = await readPointer(settingKey);

  if (ptr && String(ptr.channelId) === String(channel.id)) {
    try {
      const msg = await channel.messages.fetch(ptr.messageId);
      await msg.edit({ embeds: [embed] });
      return msg;
    } catch {}
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
  await setSetting(settingKey, JSON.stringify({ channelId: channel.id, messageId: sent.id }));
  return sent;
}

async function refreshFromStored(client, settingKey, buildEmbed) {
  const ptr = await readPointer(settingKey);
  if (!ptr) return;
  try {
    const ch = await client.channels.fetch(ptr.channelId);
    if (!ch) return;
    const msg = await ch.messages.fetch(ptr.messageId);
    await msg.edit({ embeds: [await buildEmbed()] });
  } catch (e) {
    const code = e.code || e.status;
    if (code === 10008 || code === 10003 || String(e.message || '').includes('Unknown')) {
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
  if (!client) return;
  await refreshFromStored(client, 'live_stock', buildStockEmbed);
}

async function refreshLiveQueue(client) {
  if (!client) return;
  await refreshFromStored(client, 'live_queue', buildQueueEmbed);
}

async function refreshLiveAll(client) {
  await Promise.all([refreshLiveStock(client), refreshLiveQueue(client)]);
}

function startLiveTicker(client) {
  setInterval(() => {
    refreshLiveAll(client).catch((e) => console.error('live tick', e.message));
  }, TICK_MS);
  setTimeout(() => refreshLiveAll(client).catch(() => {}), 3000);
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
