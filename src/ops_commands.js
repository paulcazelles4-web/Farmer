// language: JavaScript, file: ops_commands.js — maintenance + audit helpers
const { EmbedBuilder } = require('discord.js');
const { query, one, many, getSetting, setSetting } = require('./db');
const perms = require('./permissions');
const { getEmbedColor } = require('./embed_util');
const logs = require('./logs');
const { audit } = require('./audit');
const live = require('./live');

async function handleMaintenance(message, args, client) {
  const prefix = (await getSetting('prefix', '?')) || '?';
  const sub = (args[0] || '').toLowerCase();
  const color = await getEmbedColor();

  if (!perms.isOwner(message.author.id) && !(await perms.canUse(message.author.id, 'maintenance'))) {
    return message.reply('No permission.');
  }

  if (sub === 'enable' || sub === 'on') {
    await setSetting('maintenance', '1');
    await audit(message.author.id, 'maintenance_enable');
    logs.adminLog(client, 'Maintenance enabled', 'By <@' + message.author.id + '>');
    try {
      await live.refreshLiveStatus(client);
    } catch {}
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Maintenance')
          .setColor(0xed4245)
          .setDescription('Maintenance mode is **enabled**. Only the owner and allow-listed users can use commands.')
          .setTimestamp(),
      ],
    });
  }

  if (sub === 'disable' || sub === 'off') {
    await setSetting('maintenance', '0');
    await audit(message.author.id, 'maintenance_disable');
    logs.adminLog(client, 'Maintenance disabled', 'By <@' + message.author.id + '>');
    try {
      await live.refreshLiveStatus(client);
    } catch {}
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Maintenance')
          .setColor(0x57f287)
          .setDescription('Maintenance mode is **disabled**. Normal permission rules apply.')
          .setTimestamp(),
      ],
    });
  }

  if (sub === 'allow') {
    const user = message.mentions.users.first() || (args[1] && /^\d{17,20}$/.test(args[1]) ? { id: args[1] } : null);
    if (!user) return message.reply('Usage: `' + prefix + 'maintenance allow @user`');
    await query(`INSERT INTO maintenance_allowed (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [user.id]);
    await audit(message.author.id, 'maintenance_allow', user.id);
    return message.reply('`<@' + user.id + '>` may use the bot during maintenance.');
  }

  if (sub === 'deny' || sub === 'revoke') {
    const user = message.mentions.users.first() || (args[1] && /^\d{17,20}$/.test(args[1]) ? { id: args[1] } : null);
    if (!user) return message.reply('Usage: `' + prefix + 'maintenance deny @user`');
    await query(`DELETE FROM maintenance_allowed WHERE user_id = $1`, [user.id]);
    await audit(message.author.id, 'maintenance_deny', user.id);
    return message.reply('`<@' + user.id + '>` removed from maintenance allow-list.');
  }

  if (sub === 'list') {
    const rows = await many(`SELECT user_id FROM maintenance_allowed`);
    const desc = rows.length ? rows.map((r) => '• <@' + r.user_id + '>').join('\n') : '_Empty allow-list (owner only)._';
    return message.reply({
      embeds: [new EmbedBuilder().setTitle('Maintenance allow-list').setColor(color).setDescription(desc).setTimestamp()],
    });
  }

  const on = await perms.isMaintenance();
  const rows = await many(`SELECT user_id FROM maintenance_allowed`);
  return message.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Maintenance status')
        .setColor(on ? 0xed4245 : 0x57f287)
        .addFields(
          { name: 'Mode', value: on ? '`ENABLED`' : '`Off`', inline: true },
          { name: 'Allow-list size', value: '`' + rows.length + '`', inline: true }
        )
        .setDescription(
          '`' +
            prefix +
            'maintenance enable|disable`\n`' +
            prefix +
            'maintenance allow|deny @user`\n`' +
            prefix +
            'maintenance list|status`'
        )
        .setTimestamp(),
    ],
  });
}

module.exports = { handleMaintenance };
