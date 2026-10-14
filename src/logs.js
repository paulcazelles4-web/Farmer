// language: JavaScript, file: logs.js
const { EmbedBuilder } = require('discord.js');
const { getSetting } = require('./db');

async function sendLog(client, type, embed) {
  const enabled = getSetting(`log_${type}_enabled`, '0') === '1';
  if (!enabled) return;
  const channelId = getSetting(`log_${type}_channel`);
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error('Log send failed', type, e.message);
  }
}

function farmLog(client, title, desc, color = 0x57f287) {
  return sendLog(client, 'farm', new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp());
}
function serverLog(client, title, desc, color = 0x5865f2) {
  return sendLog(client, 'server', new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp());
}
function errorLog(client, title, desc) {
  return sendLog(client, 'errors', new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xed4245).setTimestamp());
}
function adminLog(client, title, desc, color = 0xfaa61a) {
  return sendLog(client, 'admin', new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp());
}

module.exports = { farmLog, serverLog, errorLog, adminLog, sendLog };
