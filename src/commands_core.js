// language: JavaScript, file: commands_core.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { query, one, many, getSetting, setSetting } = require('./db');
const config = require('./config');
const perms = require('./permissions');
const logs = require('./logs');
const queue = require('./queue');
const { handleExtra } = require('./extra_commands');
const { buildHelpPayload } = require('./help');
const { getEmbedColor } = require('./embed_util');
const { handleTokenList } = require('./token_cmd');
const { handleVisits } = require('./visits_cmd');
const live = require('./live');

async function getPrefix() {
  return (await getSetting('prefix', config.DEFAULT_PREFIX)) || config.DEFAULT_PREFIX;
}

function confirmRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm_' + id).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('decline_' + id).setLabel('Decline').setStyle(ButtonStyle.Secondary)
  );
}

async function handleCommand(message, client) {
  const prefix = await getPrefix();
  if (message.author.bot || !message.content || !message.content.startsWith(prefix)) return;
  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();
  if (!cmd) return;
  console.log('cmd', cmd, 'from', message.author.id, 'guild', message.guild?.id);

  const mainGuild = config.MAIN_GUILD_ID || '1499704751481294878';
  if (cmd !== 'verify') {
    if (!message.guild) return message.reply('Use commands in the server, not in DMs.').catch(() => {});
    if (message.guild.id !== mainGuild) {
      return message.reply('Commands only work in the main server (`' + mainGuild + '`). This server is `' + message.guild.id + '`.').catch(() => {});
    }
  }
  if (message.guild) {
    const bl = await one('SELECT reason FROM blacklist WHERE guild_id = $1', [message.guild.id]);
    if (bl) return message.reply('This server is blacklisted. Reason: ' + bl.reason);
  }
  if ((await perms.isMaintenance()) && !(await perms.isMaintenanceAllowed(message.author.id)) && !perms.isOwner(message.author.id)) {
    return message.reply('Bot is currently under maintenance.');
  }

  const publicCmds = ['verify', 'bot', 'checkserver', 'help', 'join', 'status'];
  const uid = message.author.id;
  let allowed = publicCmds.includes(cmd) || perms.isOwner(uid) || (await perms.canUse(uid, cmd));
  if (!allowed && cmd === 'set') {
    allowed = (await perms.canUse(uid, 'stock')) || (await perms.canUse(uid, 'queue')) || (await perms.canUse(uid, 'set'));
  }
  if (!allowed) return message.reply('No permission for `' + prefix + cmd + '`. Ask the owner to `?grant` you.').catch(() => {});

  if (cmd === 'token' && args[0] && ['export', 'import'].includes(String(args[0]).toLowerCase())) {
    return handleExtra('token', message, args, client, perms);
  }
  if (cmd === 'token') return handleTokenList(message, client);
  if (cmd === 'visits') return handleVisits(message, client, args);
  if (cmd === 'aiprompt' || cmd === 'prompt') {
    const sp = require('./server_prompt');
    return sp.handleAiprompt(message, args, client);
  }

  const brandColor = await getEmbedColor();
  try {
    if (cmd === 'help') return void (await message.reply(await buildHelpPayload(prefix, brandColor, 'core', message.author.id)));
    if (cmd === 'prefix' && args[0] === 'set' && args[1]) {
      if (!(await perms.canUse(uid, 'prefix')) && !perms.isOwner(uid)) return;
      await setSetting('prefix', args[1]);
      return void (await message.reply('Prefix set to `' + args[1] + '`'));
    }
    if (cmd === 'auth') {
      const total = (await one('SELECT COUNT(*)::int AS c FROM tokens WHERE valid = 1')).c;
      const stats = await one('SELECT * FROM auth_stats WHERE id = 1');
      return void (await message.reply({ embeds: [new EmbedBuilder().setTitle('Auth Status').setColor(brandColor).addFields(
        { name: 'Current Valid', value: '`' + total + '`', inline: true },
        { name: 'All-Time', value: '`' + (stats?.total_all_time || 0) + '`', inline: true }
      ).setTimestamp()] }));
    }
    if (cmd === 'stock') {
      const count = (await one('SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1')).c;
      return void (await message.reply({ embeds: [new EmbedBuilder().setTitle('Stock').setColor(brandColor).addFields(
        { name: 'In Stock', value: '`' + count + '`', inline: true }
      ).setFooter({ text: 'Member Farm · live: ?set stock #channel' }).setTimestamp()] }));
    }
    if (cmd === 'restock') {
      const n = parseInt(args[0], 10);
      if (!n || n < 1) return message.reply('Usage: ' + prefix + 'restock <number>');
      const available = await many('SELECT id FROM tokens WHERE valid = 1 AND id NOT IN (SELECT token_id FROM stock)');
      if (n > available.length) return message.reply('Only ' + available.length + ' tokens available for restock.');
      for (let i = available.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [available[i], available[j]] = [available[j], available[i]]; }
      for (const t of available.slice(0, n)) await query('INSERT INTO stock (token_id) VALUES ($1) ON CONFLICT DO NOTHING', [t.id]);
      await live.refreshLiveStock(client).catch(() => {});
      return void (await message.reply('Restocked `' + n + '`.'));
    }
    if (cmd === 'remove') {
      const n = parseInt(args[0], 10);
      if (!n || n < 1) return message.reply('Usage: ' + prefix + 'remove <number>');
      const rows = await many('SELECT token_id FROM stock LIMIT $1', [n]);
      for (const r of rows) await query('DELETE FROM stock WHERE token_id = $1', [r.token_id]);
      await live.refreshLiveStock(client).catch(() => {});
      return void (await message.reply('Removed `' + rows.length + '` from stock.'));
    }
    if (cmd === 'bot') {
      const invite = config.BOT_INVITE || 'https://discord.com/oauth2/authorize?client_id=1559903456469196810&permissions=8&integration_type=0&scope=bot';
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Add Bot →').setStyle(ButtonStyle.Link).setURL(invite));
      return void (await message.reply({ embeds: [new EmbedBuilder().setTitle('Add the Bot').setColor(brandColor).setDescription('Click below.')], components: [row] }));
    }
    if (cmd === 'verify') {
      const url = await getSetting('oauth_link', 'https://discord.com/api/oauth2/authorize?client_id=' + process.env.CLIENT_ID + '&redirect_uri=' + encodeURIComponent(process.env.REDIRECT_URI || '') + '&response_type=code&scope=identify%20guilds.join%20guilds');
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('—> Verify').setStyle(ButtonStyle.Link).setURL(url));
      return void (await message.channel.send({ embeds: [new EmbedBuilder().setTitle('Account Verification').setColor(0x57f287).setDescription('Authorize the bot.')], components: [row] }));
    }
    if (cmd === 'join') {
      const specialId = await getSetting('special_channel', config.SPECIAL_CHANNEL_ID);
      const specialName = await getSetting('special_channel_name', config.SPECIAL_CHANNEL_NAME);
      if (message.channel.id !== specialId && message.channel.name !== specialName) return message.reply('This command can only be used in the designated join channel.');
      const verifiedRole = await getSetting('verified_role', config.VERIFIED_ROLE_ID);
      if (verifiedRole && !message.member.roles.cache.has(verifiedRole)) return message.reply('You need the verified role.');
      const targetId = args[0];
      if (!targetId || !/^\d{17,20}$/.test(targetId)) return message.reply('Usage: ' + prefix + 'join <serverID>');
      if (!client.guilds.cache.get(targetId)) return message.reply('Bot is not in that server.');
      let amount = parseInt(await getSetting('base_send', String(config.BASE_SEND)), 10) || 2;
      const userSend = await one('SELECT amount FROM user_send WHERE user_id = $1', [message.author.id]);
      if (userSend && userSend.amount != null) amount = parseInt(userSend.amount, 10) || amount;
      else {
        for (const b of await many('SELECT role_id, bonus FROM role_bonus')) {
          if (message.member.roles.cache.has(b.role_id)) amount += b.bonus;
        }
      }
      const stockCount = (await one('SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1')).c;
      if (stockCount === 0) return message.reply('Error. All stock account are alredy in ' + targetId);
      const q = await queue.addToQueue(targetId, message.author.id, amount);
      if (!q.ok) return message.reply('Queue is full (max 10). Try later.');
      await live.refreshLiveQueue(client).catch(() => {});
      await query('INSERT INTO cooldowns (user_id, last_join) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET last_join = EXCLUDED.last_join', [message.author.id, Date.now()]);
      return void (await message.reply({ embeds: [new EmbedBuilder().setTitle('Join Queued').setColor(0x57f287).addFields(
        { name: 'Server', value: '`' + targetId + '`', inline: true },
        { name: 'Amount', value: '`' + amount + '`', inline: true },
        { name: 'Position', value: '`' + q.position + '`', inline: true }
      ).setTimestamp()] }));
    }
    if (cmd === 'channel' && args[0] === 'set' && message.mentions.channels.first()) {
      const ch = message.mentions.channels.first();
      await setSetting('special_channel', ch.id);
      await setSetting('special_channel_name', ch.name);
      let purged = 0;
      try {
        for (let round = 0; round < 50; round++) {
          const batch = await ch.messages.fetch({ limit: 100 });
          if (!batch.size) break;
          const young = batch.filter((m) => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
          if (young.size >= 2) {
            const res = await ch.bulkDelete(young, true).catch(() => null);
            purged += res ? res.size : 0;
          }
          for (const m of batch.values()) {
            if (young.has(m.id)) continue;
            await m.delete().catch(() => {});
            purged++;
          }
          if (batch.size < 100) break;
        }
      } catch (e) { console.error('purge', e.message); }
      return void (await message.channel.send('Join channel set to <#' + ch.id + '>. Purged **' + purged + '**. Auto-clean 10s.').then((m) => setTimeout(() => m.delete().catch(() => {}), 10000)));
    }
    if (cmd === 'send') {
      const target = message.mentions.users.first();
      let user = target;
      const amountRaw = args.find((a) => /^-?\d+$/.test(a));
      if (!user && args[0] && /^\d{17,20}$/.test(args[0])) {
        try { user = await client.users.fetch(args[0]); } catch {}
      }
      if (!user || amountRaw === undefined) {
        return message.reply('Usage: `' + prefix + 'send @user <n>` — members per join. `' + prefix + 'send @user 0` resets.');
      }
      const amount = parseInt(amountRaw, 10);
      if (amount === 0) {
        await query('DELETE FROM user_send WHERE user_id = $1', [user.id]);
        return message.reply('Custom send for **' + (user.username || user.id) + '** reset to base_send.');
      }
      if (amount < 1 || amount > 100) return message.reply('Amount must be 1–100 (or 0 to reset).');
      await query(`INSERT INTO user_send (user_id, amount) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET amount = EXCLUDED.amount`, [user.id, amount]);
      await message.reply({ embeds: [new EmbedBuilder().setTitle('User Send Set').setColor(0x57f287).addFields(
        { name: 'User', value: '<@' + user.id + '>', inline: true },
        { name: 'Per join', value: '`' + amount + '`', inline: true }
      ).setTimestamp()] });
      return void logs.adminLog(client, 'User send set', '<@' + message.author.id + '> → <@' + user.id + '> = `' + amount + '`');
    }
    if (cmd === 'set') {
      const kind = (args[0] || '').toLowerCase();
      const ch = message.mentions.channels.first();
      if (!kind || !ch || !['stock', 'queue'].includes(kind)) {
        return message.reply('Usage: `' + prefix + 'set stock #channel` or `' + prefix + 'set queue #channel`');
      }
      try {
        await live.setLiveChannel(client, kind, ch);
        return void (await message.reply('Live **' + kind + '** panel set to <#' + ch.id + '> and posted.'));
      } catch (e) {
        return message.reply('Failed: ' + (e.message || e));
      }
    }
    if (cmd === 'queue') {
      const sub = (args[0] || '').toLowerCase();
      if (!sub) {
        const rows = await queue.getQueue();
        const desc = rows.length ? rows.map((r) => '**#' + r.position + '** `' + r.guild_id + '` ×' + r.amount).join('\n') : 'Queue empty.';
        await message.reply({ embeds: [new EmbedBuilder().setTitle('Queue').setColor(brandColor).setDescription(desc).setTimestamp()] });
        return void (await live.refreshLiveQueue(client).catch(() => {}));
      }
      if (sub === 'clear') {
        const id = 'clearq_' + Date.now();
        client.pendingConfirms.set(id, { action: 'queue_clear', author: message.author.id });
        return void (await message.reply({ content: 'Confirm clear entire queue?', components: [confirmRow(id)] }));
      }
      if (sub === 'remove') { await queue.removeFromQueue(args[1]); await live.refreshLiveQueue(client).catch(() => {}); return void (await message.reply('Removed ' + args[1])); }
      if (sub === 'pause') { await queue.pauseQueue(); await live.refreshLiveQueue(client).catch(() => {}); return void (await message.reply('Queue paused')); }
      if (sub === 'resume') { await queue.resumeQueue(); await live.refreshLiveQueue(client).catch(() => {}); return void (await message.reply('Queue resumed')); }
      if (sub === 'priority') { await queue.setPriority(args[1]); await live.refreshLiveQueue(client).catch(() => {}); return void (await message.reply('Priority set')); }
      return;
    }
    if (cmd === 'stats') {
      const tokens = (await one('SELECT COUNT(*)::int AS c FROM tokens WHERE valid = 1')).c;
      const stockC = (await one('SELECT COUNT(*)::int AS c FROM stock')).c;
      return void (await message.reply({ embeds: [new EmbedBuilder().setTitle('Stats').setColor(brandColor).addFields(
        { name: 'Valid Auths', value: '`' + tokens + '`', inline: true },
        { name: 'Stock', value: '`' + stockC + '`', inline: true }
      ).setTimestamp()] }));
    }
    if (cmd === 'link') {
      if (args[0] === 'define') {
        const url = args.slice(1).join(' ');
        if (!url) return message.reply('Usage: ' + prefix + 'link define <url>');
        await setSetting('oauth_link', url);
        return void (await message.reply('OAuth link defined.'));
      }
      const url = await getSetting('oauth_link', process.env.REDIRECT_URI
        ? 'https://discord.com/api/oauth2/authorize?client_id=' + process.env.CLIENT_ID + '&redirect_uri=' + encodeURIComponent(process.env.REDIRECT_URI) + '&response_type=code&scope=identify%20guilds.join%20guilds'
        : 'Not configured');
      return void (await message.reply({ embeds: [new EmbedBuilder().setTitle('OAuth Authorize Link').setDescription(url).setColor(brandColor)] }));
    }
    await handleExtra(cmd, message, args, client, perms);
  } catch (err) {
    console.error(err);
    logs.errorLog(client, {
      botName: client.user?.username || 'Member Farm',
      command: cmd,
      userTag: message.author?.tag || 'unknown',
      userId: message.author?.id || '-',
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
