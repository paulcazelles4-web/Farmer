// language: JavaScript, file: log_cmd.js — configure log channels from Discord
const { EmbedBuilder } = require('discord.js');
const { getSetting, setSetting } = require('./db');
const perms = require('./permissions');
const logs = require('./logs');
const { getEmbedColor } = require('./embed_util');

const LOG_TYPES = ['farm', 'server', 'errors', 'admin', 'verify'];

function typeFromCmd(cmd, args) {
  // logfarm / logserver / logerrors / logadmin / logverify
  if (cmd.startsWith('log') && cmd !== 'log' && cmd !== 'logs' && cmd !== 'logtest') {
    const t = cmd.slice(3); // farm, server, errors, admin, verify
    if (LOG_TYPES.includes(t)) return t;
  }
  // ?log <type> ...
  if ((cmd === 'log' || cmd === 'logs') && args[0] && LOG_TYPES.includes(args[0].toLowerCase())) {
    return args[0].toLowerCase();
  }
  return null;
}

async function handleLogCommand(message, args, client, cmd) {
  const prefix = (await getSetting('prefix', '?')) || '?';
  const uid = message.author.id;
  if (!perms.isOwner(uid) && !(await perms.canUse(uid, 'logs')) && !(await perms.canUse(uid, cmd))) {
    return message.reply('No permission.');
  }

  const color = await getEmbedColor();

  // ?logs status  OR  ?log status
  if ((cmd === 'logs' || cmd === 'log') && (!args[0] || args[0].toLowerCase() === 'status')) {
    const lines = [];
    for (const t of LOG_TYPES) {
      const en = (await getSetting('log_' + t + '_enabled', '0')) === '1';
      const ch = await getSetting('log_' + t + '_channel', '');
      lines.push(
        '**' +
          t +
          '** · ' +
          (en ? '`ON`' : '`OFF`') +
          ' · ' +
          (ch ? '<#' + ch + '>' : '_no channel_')
      );
    }
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Log channels')
          .setColor(color)
          .setDescription(lines.join('\n'))
          .setFooter({
            text:
              prefix +
              'logfarm|logserver|logerrors|logadmin|logverify set #ch · enable · disable',
          })
          .setTimestamp(),
      ],
    });
  }

  // ?log test handled elsewhere (extra_commands)
  if ((cmd === 'log' || cmd === 'logs') && (args[0] || '').toLowerCase() === 'test') {
    return false; // let extra_commands handle
  }

  let type = typeFromCmd(cmd, args);
  let rest = args;
  if (cmd === 'log' || cmd === 'logs') {
    // ?log farm set #ch → type=farm, rest after type
    if (type) rest = args.slice(1);
  }

  if (!type) {
    return message.reply(
      'Usage:\n' +
        '`' +
        prefix +
        'logfarm|logserver|logerrors|logadmin|logverify set #channel`\n' +
        '`' +
        prefix +
        'logfarm enable` · `disable`\n' +
        '`' +
        prefix +
        'logs status`\n' +
        '`' +
        prefix +
        'log test`'
    );
  }

  const sub = (rest[0] || '').toLowerCase();

  if (sub === 'set') {
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply('Usage: `' + prefix + 'log' + type + ' set #channel`');
    await setSetting('log_' + type + '_channel', ch.id);
    await setSetting('log_' + type + '_enabled', '1');
    try {
      await logs.adminLog(
        client,
        'Log channel set',
        '**' + type + '** → <#' + ch.id + '> by <@' + uid + '>'
      );
    } catch {}
    return message.reply('**' + type + '** logs → <#' + ch.id + '> (enabled).');
  }

  if (sub === 'enable' || sub === 'on') {
    const ch = await getSetting('log_' + type + '_channel', '');
    if (!ch) {
      return message.reply(
        'No channel for **' + type + '**. Set one first: `' + prefix + 'log' + type + ' set #channel`'
      );
    }
    await setSetting('log_' + type + '_enabled', '1');
    return message.reply('**' + type + '** logs **enabled** → <#' + ch + '>.');
  }

  if (sub === 'disable' || sub === 'off') {
    await setSetting('log_' + type + '_enabled', '0');
    return message.reply('**' + type + '** logs **disabled**.');
  }

  // show one type
  const en = (await getSetting('log_' + type + '_enabled', '0')) === '1';
  const ch = await getSetting('log_' + type + '_channel', '');
  return message.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Log · ' + type)
        .setColor(color)
        .addFields(
          { name: 'Status', value: en ? '`ON`' : '`OFF`', inline: true },
          { name: 'Channel', value: ch ? '<#' + ch + '>' : '`none`', inline: true }
        )
        .setFooter({ text: prefix + 'log' + type + ' set #ch · enable · disable' })
        .setTimestamp(),
    ],
  });
}

module.exports = { handleLogCommand, LOG_TYPES };
