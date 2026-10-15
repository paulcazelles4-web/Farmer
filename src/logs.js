// language: JavaScript, file: logs.js
const { EmbedBuilder } = require('discord.js');
const { getSetting } = require('./db');

async function sendLog(client, type, embed) {
  const enabled = (await getSetting(`log_${type}_enabled`, '0')) === '1';
  if (!enabled) return { ok: false, reason: 'disabled' };
  const channelId = await getSetting(`log_${type}_channel`);
  if (!channelId) return { ok: false, reason: 'no_channel' };
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return { ok: false, reason: 'channel_not_found' };
    await ch.send({ embeds: [embed] });
    return { ok: true, channelId };
  } catch (e) {
    console.error('Log send failed', type, e.message);
    return { ok: false, reason: 'send_failed', error: e.message };
  }
}

function farmLog(client, title, desc, color = 0x57f287) {
  return sendLog(
    client,
    'farm',
    new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setFooter({ text: 'Member Farm' }).setTimestamp()
  );
}

function djoinLog(client, data) {
  const {
    userTag,
    userId,
    guildId,
    joined = 0,
    alreadyIn = 0,
    maxed = 0,
    phoneLocked = 0,
    deauthorized = 0,
    terminated = 0,
    banned = 0,
    transient = 0,
    stockLeft = 0,
    tier = 'Standard',
  } = data;
  const emb = new EmbedBuilder()
    .setTitle('DJoin Log')
    .setColor(joined > 0 ? 0x57f287 : 0xfaa61a)
    .addFields(
      { name: 'User', value: `${userTag || 'unknown'} (\`${userId}\`)`, inline: true },
      { name: 'Server ID', value: `\`${guildId}\``, inline: true },
      { name: 'Tier', value: String(tier), inline: true },
      { name: 'Joined', value: `\`${joined}\``, inline: true },
      { name: 'Already In', value: `\`${alreadyIn}\``, inline: true },
      { name: 'Maxed Out', value: `\`${maxed}\``, inline: true },
      { name: 'Phone Locked', value: `\`${phoneLocked}\``, inline: true },
      { name: 'Deauthorized', value: `\`${deauthorized}\``, inline: true },
      { name: 'Terminated', value: `\`${terminated}\``, inline: true },
      { name: 'Banned', value: `\`${banned}\``, inline: true },
      { name: 'Transient Errors', value: `\`${transient}\``, inline: true },
      { name: 'Stock Left', value: `\`${stockLeft}\``, inline: true }
    )
    .setFooter({ text: 'Member Farm' })
    .setTimestamp();
  return sendLog(client, 'farm', emb);
}

function serverLog(client, title, desc, color = 0x5865f2) {
  return sendLog(
    client,
    'server',
    new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setFooter({ text: 'Member Farm' }).setTimestamp()
  );
}

function botAddedLog(client, data) {
  const emb = new EmbedBuilder()
    .setTitle('Bot Added to Server')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Server Name', value: data.name || 'unknown', inline: true },
      { name: 'Server ID', value: `\`${data.id}\``, inline: true },
      { name: 'Member Count', value: `\`${data.memberCount ?? '?'}\``, inline: true },
      { name: 'Added by', value: data.inviterTag ? `<@${data.inviterId}>` : '`unknown`', inline: true },
      { name: 'User ID', value: data.inviterId ? `\`${data.inviterId}\`` : '`—`', inline: true },
      { name: 'Username', value: data.inviterTag || '`—`', inline: true },
      { name: 'Bot now in', value: `**${data.botGuilds}** servers`, inline: true }
    )
    .setFooter({ text: 'Member Farm' })
    .setTimestamp();
  if (data.icon) emb.setThumbnail(data.icon);
  return sendLog(client, 'server', emb);
}

/**
 * GrowBase-style unhandled error panel
 * @param {object} opts
 * @param {string} [opts.botName]
 * @param {string} [opts.command]
 * @param {string} [opts.userTag]
 * @param {string} [opts.userId]
 * @param {string} [opts.channelName]
 * @param {string} [opts.guildName]
 * @param {string} [opts.errorType]
 * @param {string} [opts.errorMessage]
 * @param {string} [opts.traceback]
 */
function errorLog(client, opts = {}) {
  // backward compat: errorLog(client, title, desc)
  if (typeof opts === 'string') {
    const title = opts;
    const desc = arguments[2] || '';
    opts = { errorType: title, errorMessage: desc, traceback: desc };
  }

  const botName = opts.botName || client?.user?.username || 'Member Farm';
  const command = opts.command || 'unknown';
  const userTag = opts.userTag || 'unknown';
  const userId = opts.userId || '—';
  const channelName = opts.channelName || 'unknown';
  const guildName = opts.guildName || 'unknown';
  const errorType = opts.errorType || 'Error';
  const errorMessage = opts.errorMessage || 'No message';
  let traceback = opts.traceback || errorMessage;
  if (traceback.length > 900) traceback = traceback.slice(0, 900) + '\n…';

  const emb = new EmbedBuilder()
    .setTitle('Unhandled Bot Error')
    .setColor(0xed4245)
    .addFields(
      { name: 'Bot', value: botName, inline: true },
      { name: 'Command', value: '`' + command + '`', inline: true },
      { name: 'User', value: userTag + '\n(`' + userId + '`)', inline: true },
      { name: 'Channel', value: '#' + channelName + ' in ' + guildName, inline: true },
      { name: 'Error Type', value: errorType, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Error Message', value: '```\n' + String(errorMessage).slice(0, 500) + '\n```' },
      { name: 'Traceback', value: '```js\n' + traceback + '\n```' }
    )
    .setFooter({ text: 'Member Farm' })
    .setTimestamp();

  return sendLog(client, 'errors', emb);
}

function adminLog(client, title, desc, color = 0xfaa61a) {
  return sendLog(
    client,
    'admin',
    new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setFooter({ text: 'Member Farm' }).setTimestamp()
  );
}

module.exports = { farmLog, djoinLog, serverLog, botAddedLog, errorLog, adminLog, sendLog };
