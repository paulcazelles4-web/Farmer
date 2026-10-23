// language: JavaScript, file: live.js
const { EmbedBuilder } = require('discord.js');
const { one, many, getSetting, setSetting } = require('./db');
const queue = require('./queue');
const { getEmbedColor } = require('./embed_util');

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
    .setDescription('Auto-updates when stock changes.')
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
    .setDescription(desc)
    .addFields({ name: 'Pending', value: '`' + rows.length + '`', inline: true })
    .setFooter({ text: 'Member Farm · live' })
    .setTimestamp();
}

async function editOrCreate(client, settingKey, channel, embed) {
  const raw = await getSetting(settingKey, '');
  let channelId = null;
  let messageId = null;
  if (raw) {
    try {
      const j = JSON.parse(raw);
      channelId = j.channelId;
      messageId = j.messageId;
    } catch {}
  }

  if (channelId && messageId && String(channelId) === String(channel.id)) {
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ embeds: [embed] });
      return msg;
    } catch {}
  }

  if (channelId && messageId && String(channelId) !== String(channel.id)) {
    try {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      }
    } catch {}
  }

  const sent = await channel.send({ embeds: [embed] });
  await setSetting(settingKey, JSON.stringify({ channelId: channel.id, messageId: sent.id }));
  return sent;
}

async function refreshFromStored(client, settingKey, buildEmbed) {
  const raw = await getSetting(settingKey, '');
  if (!raw) return;
  let channelId, messageId;
  try {
    const j = JSON.parse(raw);
    channelId = j.channelId;
    messageId = j.messageId;
  } catch {
    return;
  }
  if (!channelId || !messageId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch) return;
    const msg = await ch.messages.fetch(messageId);
    const embed = await buildEmbed();
    await msg.edit({ embeds: [embed] });
  } catch (e) {
    if (String(e.message || '').includes('Unknown Message') || e.code === 10008) {
      await setSetting(settingKey, '');
    }
  }
}

async function postLiveStock(message, client) {
  const embed = await buildStockEmbed();
  const msg = await editOrCreate(client, 'live_stock', message.channel, embed);
  await message.reply('Live stock panel is in this channel (auto-updates).').catch(() => {});
  return msg;
}

async function postLiveQueue(message, client) {
  const embed = await buildQueueEmbed();
  const msg = await editOrCreate(client, 'live_queue', message.channel, embed);
  await message.reply('Live queue panel is in this channel (auto-updates).').catch(() => {});
  return msg;
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

module.exports = {
  postLiveStock,
  postLiveQueue,
  refreshLiveStock,
  refreshLiveQueue,
  refreshLiveAll,
  buildStockEmbed,
  buildQueueEmbed,
};
