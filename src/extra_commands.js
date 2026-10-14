// language: JavaScript, file: extra_commands.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { query, one, many } = require('./db');
const config = require('./config');
const logs = require('./logs');

function confirmRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm_${id}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`decline_${id}`).setLabel('Decline').setStyle(ButtonStyle.Secondary)
  );
}

async function handleExtra(cmd, message, args, client, perms) {
  if (cmd === 'checkauth') {
    if (!(await perms.canUse(message.author.id, 'checkauth')) && !perms.isOwner(message.author.id)) return true;
    const statusMsg = await message.reply({ embeds: [new EmbedBuilder()
      .setTitle('Auth Pool Check')
      .setDescription('Scanning tokens…')
      .setColor(0xfaa61a)
      .setFooter({ text: 'Member Farm' })
      .setTimestamp()] });

    const tokens = await many('SELECT id, user_id, access_token FROM tokens WHERE valid = 1 ORDER BY id');
    let valid = 0, deauth = 0, errors = 0, noToken = 0;

    for (const tok of tokens) {
      if (!tok.access_token) {
        noToken++;
        await query('UPDATE tokens SET valid = 0 WHERE id = $1', [tok.id]);
        continue;
      }
      try {
        const res = await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: 'Bearer ' + tok.access_token },
        });
        if (res.status === 200) valid++;
        else if (res.status === 401 || res.status === 403) {
          deauth++;
          await query('UPDATE tokens SET valid = 0 WHERE id = $1', [tok.id]);
          await query('DELETE FROM stock WHERE token_id = $1', [tok.id]);
        } else errors++;
        await new Promise(r => setTimeout(r, 150));
      } catch {
        errors++;
      }
    }

    const total = tokens.length;
    const sortedOut = deauth + noToken;
    const health = total === 0 ? 0 : Math.round((valid / total) * 100);

    await statusMsg.edit({ embeds: [new EmbedBuilder()
      .setTitle('Auth Pool Check Report')
      .setColor(health >= 80 ? 0x57f287 : health >= 50 ? 0xfaa61a : 0xed4245)
      .addFields(
        { name: 'Total Checked', value: '`' + total + '`', inline: true },
        { name: 'Valid', value: '`' + valid + '`', inline: true },
        { name: 'Deauthorized', value: '`' + deauth + '`', inline: true },
        { name: 'No Token', value: '`' + noToken + '`', inline: true },
        { name: 'Errors (kept)', value: '`' + errors + '`', inline: true },
        { name: 'Removed from stock', value: '`' + deauth + '`', inline: true },
        {
          name: 'Auth Pool Health',
          value: '**' + health + '%** usable (`' + valid + '` good / `' + sortedOut + '` sorted out)' +
            (errors ? '\n⚠️ `' + errors + '` token(s) could not be verified (rate-limit/network). Re-run later.' : ''),
        }
      )
      .setFooter({ text: 'Checked by ' + message.author.username + ' • Member Farm' })
      .setTimestamp()] });
    logs.adminLog(client, 'Auth pool check', 'By <@' + message.author.id + '> total=' + total + ' valid=' + valid + ' deauth=' + deauth);
    return true;
  }

  if (cmd === 'leave') {
    if (!(await perms.canUse(message.author.id, 'leave')) && !perms.isOwner(message.author.id)) return true;
    const target = (args[0] || '').toLowerCase();
    if (!target) { await message.reply('Usage: `!leave <serverID>` or `!leave all`'); return true; }

    if (target === 'all') {
      const id = 'leaveall_' + Date.now();
      client.pendingConfirms.set(id, { action: 'leave_all', author: message.author.id });
      await message.reply({
        embeds: [new EmbedBuilder()
          .setTitle('Leave All Servers')
          .setColor(0xed4245)
          .setDescription('Confirm leaving **all** servers except main + antileave list.\nCurrently in **' + client.guilds.cache.size + '** servers.')
          .setFooter({ text: 'Member Farm' })
          .setTimestamp()],
        components: [confirmRow(id)],
      });
      return true;
    }

    if (!/^\d{17,20}$/.test(target)) { await message.reply('Usage: `!leave <serverID>` or `!leave all`'); return true; }
    const main = config.MAIN_GUILD_ID || '1499704751481294878';
    if (target === String(main)) {
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Protected').setDescription('Cannot leave the main server.').setColor(0xed4245).setFooter({ text: 'Member Farm' }).setTimestamp()] });
      return true;
    }
    const protectedRow = await one('SELECT 1 FROM antileave WHERE guild_id = $1', [target]);
    if (protectedRow) {
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Protected').setDescription('Server `' + target + '` is on the antileave list.').setColor(0xed4245).setFooter({ text: 'Member Farm' }).setTimestamp()] });
      return true;
    }
    const g = client.guilds.cache.get(target);
    if (!g) { await message.reply('Bot is not in that server.'); return true; }
    const id = 'leave_' + target + '_' + Date.now();
    client.pendingConfirms.set(id, { action: 'leave', guildId: target, author: message.author.id });
    await message.reply({
      embeds: [new EmbedBuilder().setTitle('Leave Server').setColor(0xed4245).addFields(
        { name: 'Server Name', value: g.name, inline: true },
        { name: 'Server ID', value: '`' + target + '`', inline: true },
        { name: 'Members', value: '`' + String(g.memberCount) + '`', inline: true }
      ).setDescription('Confirm leave?').setFooter({ text: 'Member Farm' }).setTimestamp()],
      components: [confirmRow(id)],
    });
    return true;
  }

  if (cmd === 'antileave') {
    if (!(await perms.canUse(message.author.id, 'antileave')) && !perms.isOwner(message.author.id)) return true;
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'add') {
      const gid = args[1];
      if (!gid || !/^\d{17,20}$/.test(gid)) { await message.reply('Usage: `!antileave add <serverID>`'); return true; }
      await query('INSERT INTO antileave (guild_id, added_by) VALUES ($1, $2) ON CONFLICT (guild_id) DO NOTHING', [gid, message.author.id]);
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Antileave Added').setColor(0x57f287).addFields(
        { name: 'Server ID', value: '`' + gid + '`', inline: true },
        { name: 'Action by', value: '<@' + message.author.id + '>', inline: true }
      ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
    } else if (sub === 'revoke') {
      const gid = args[1];
      if (!gid || !/^\d{17,20}$/.test(gid)) { await message.reply('Usage: `!antileave revoke <serverID>`'); return true; }
      await query('DELETE FROM antileave WHERE guild_id = $1', [gid]);
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Antileave Revoked').setColor(0xfaa61a).addFields(
        { name: 'Server ID', value: '`' + gid + '`', inline: true },
        { name: 'Action by', value: '<@' + message.author.id + '>', inline: true }
      ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
    } else if (sub === 'list') {
      const rows = await many('SELECT * FROM antileave ORDER BY added_at DESC');
      const main = config.MAIN_GUILD_ID || '1499704751481294878';
      const lines = ['`' + main + '` — **main** (always protected)'].concat(rows.map(r => '`' + r.guild_id + '`'));
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Antileave List').setColor(0x5865f2).setDescription(lines.join('\n')).setFooter({ text: 'Member Farm' }).setTimestamp()] });
    } else {
      await message.reply('Usage: `!antileave add|revoke|list <serverID>`');
    }
    return true;
  }

  return false;
}

module.exports = { handleExtra };
