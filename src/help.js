// language: JavaScript, file: help.js
const { EmbedBuilder } = require('discord.js');

function buildHelpEmbed(prefix) {
  const p = prefix;
  return new EmbedBuilder()
    .setTitle('Member Farm — Command Panel')
    .setColor(0x5865f2)
    .setDescription('Current prefix: `' + p + '` — change with `' + p + 'prefix set <prefix>`')
    .addFields(
      {
        name: 'Core',
        value: [
          '`' + p + 'auth` — auth counts',
          '`' + p + 'stock` — current stock',
          '`' + p + 'restock <n>` — restock tokens',
          '`' + p + 'remove <n>` — remove from stock',
          '`' + p + 'link` / `' + p + 'link define <url>`',
          '`' + p + 'verify` — OAuth verify button',
          '`' + p + 'bot` — add-bot invite button',
          '`' + p + 'join <serverID>` — request members',
          '`' + p + 'channel set #channel` — join channel',
          '`' + p + 'checkauth` — scan auth pool',
          '`' + p + 'status` — bot status',
          '`' + p + 'panel` — persistent panel',
        ].join('\n'),
      },
      {
        name: 'Permissions',
        value: [
          '`' + p + 'grant @user <cmd|all>`',
          '`' + p + 'grant revoke @user <cmd|all>`',
          '`' + p + 'permission @user`',
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Queue',
        value: [
          '`' + p + 'queue` · clear',
          '`' + p + 'queue remove|info|priority <id>`',
          '`' + p + 'queue move <id> <pos>`',
          '`' + p + 'queue pause` · resume',
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Server',
        value: [
          '`' + p + 'checkserver <id>`',
          '`' + p + 'blacklist <id> <reason>`',
          '`' + p + 'blacklist list` / revoke',
          '`' + p + 'leave <id|all>`',
          '`' + p + 'antileave add|revoke|list`',
          '`' + p + 'announce <id|all> <msg>`',
          '`' + p + 'invites` · `' + p + 'invites user @u`',
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Config',
        value: [
          '`' + p + 'prefix set <prefix>`',
          '`' + p + 'basesend set <n>`',
          '`' + p + 'send @role <n>`',
          '`' + p + 'verifyrole set @role`',
          '`' + p + 'cooldown <seconds>`',
          '`' + p + 'bio <text>` · clear',
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Logs',
        value: [
          '`' + p + 'logfarm|logserver|logerrors|logadmin`',
          'enable · disable · set #ch',
          '`' + p + 'logs status` · `' + p + 'log test`',
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Admin / Abuse',
        value: [
          '`' + p + 'stats` · `' + p + 'profile @user`',
          '`' + p + 'maintenance enable|disable`',
          '`' + p + 'banfarm @user [reason]`',
          '`' + p + 'antiraid enable|disable|status`',
          '`' + p + 'antiraid threshold <n>` · clear',
          '`' + p + 'token` · export · import',
        ].join('\n'),
        inline: true,
      }
    )
    .setFooter({ text: 'Member Farm · prefix ' + p })
    .setTimestamp();
}

module.exports = { buildHelpEmbed };
