// language: JavaScript, file: extra_commands.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { query, one, many, getSetting, setSetting } = require('./db');
const config = require('./config');
const logs = require('./logs');
const queue = require('./queue');
const { buildHelpEmbed } = require('./help');

function confirmRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm_' + id).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('decline_' + id).setLabel('Decline').setStyle(ButtonStyle.Secondary)
  );
}

async function handleExtra(cmd, message, args, client, perms) {
  if (cmd === 'checkauth') {
    if (!(await perms.canUse(message.author.id, 'checkauth')) && !perms.isOwner(message.author.id)) return true;
    const statusMsg = await message.reply({ embeds: [new EmbedBuilder()
      .setTitle('Auth Pool Check').setDescription('Scanning tokens…').setColor(0xfaa61a)
      .setFooter({ text: 'Member Farm' }).setTimestamp()] });
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
      } catch { errors++; }
    }
    const total = tokens.length;
    const sortedOut = deauth + noToken;
    const health = total === 0 ? 0 : Math.round((valid / total) * 100);
    await setSetting('last_checkauth', String(Date.now()));
    await setSetting('last_checkauth_health', String(health));
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
        { name: 'Auth Pool Health', value: '**' + health + '%** usable (`' + valid + '` good / `' + sortedOut + '` sorted out)' }
      )
      .setFooter({ text: 'Checked by ' + message.author.username + ' • Member Farm' }).setTimestamp()] });
    logs.adminLog(client, 'Auth pool check', 'By <@' + message.author.id + '> valid=' + valid + ' deauth=' + deauth);
    return true;
  }

  if (cmd === 'leave') {
    if (!(await perms.canUse(message.author.id, 'leave')) && !perms.isOwner(message.author.id)) return true;
    const target = (args[0] || '').toLowerCase();
    if (!target) { await message.reply('Usage: leave <serverID> or leave all'); return true; }
    if (target === 'all') {
      const id = 'leaveall_' + Date.now();
      client.pendingConfirms.set(id, { action: 'leave_all', author: message.author.id });
      await message.reply({
        embeds: [new EmbedBuilder().setTitle('Leave All Servers').setColor(0xed4245)
          .setDescription('Confirm leaving **all** except main + antileave.\nCurrently in **' + client.guilds.cache.size + '** servers.')
          .setFooter({ text: 'Member Farm' }).setTimestamp()],
        components: [confirmRow(id)],
      });
      return true;
    }
    if (!/^\d{17,20}$/.test(target)) { await message.reply('Usage: leave <serverID> or leave all'); return true; }
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
      if (!gid || !/^\d{17,20}$/.test(gid)) { await message.reply('Usage: antileave add <serverID>'); return true; }
      await query('INSERT INTO antileave (guild_id, added_by) VALUES ($1, $2) ON CONFLICT (guild_id) DO NOTHING', [gid, message.author.id]);
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Antileave Added').setColor(0x57f287).addFields(
        { name: 'Server ID', value: '`' + gid + '`', inline: true }
      ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
    } else if (sub === 'revoke') {
      const gid = args[1];
      if (!gid) { await message.reply('Usage: antileave revoke <serverID>'); return true; }
      await query('DELETE FROM antileave WHERE guild_id = $1', [gid]);
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Antileave Revoked').setColor(0xfaa61a).addFields(
        { name: 'Server ID', value: '`' + gid + '`', inline: true }
      ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
    } else if (sub === 'list') {
      const rows = await many('SELECT * FROM antileave ORDER BY added_at DESC');
      const main = config.MAIN_GUILD_ID || '1499704751481294878';
      const lines = ['`' + main + '` — **main**'].concat(rows.map(r => '`' + r.guild_id + '`'));
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Antileave List').setColor(0x5865f2).setDescription(lines.join('\n')).setFooter({ text: 'Member Farm' }).setTimestamp()] });
    } else {
      await message.reply('Usage: antileave add|revoke|list <serverID>');
    }
    return true;
  }

  if (cmd === 'token') {
    if (String(message.author.id) !== String(config.OWNER_ID)) return true;
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'export') {
      const tokens = await many('SELECT id, user_id, access_token, refresh_token, expires_at, scope, added_at, valid FROM tokens ORDER BY id');
      if (!tokens.length) { await message.reply('No tokens to export.'); return true; }
      const payload = {
        exported_at: new Date().toISOString(),
        count: tokens.length,
        tokens: tokens.map(t => ({
          user_id: t.user_id, access_token: t.access_token, refresh_token: t.refresh_token,
          expires_at: t.expires_at, scope: t.scope, added_at: t.added_at, valid: t.valid,
        })),
      };
      const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
      const file = new AttachmentBuilder(buf, { name: 'tokens-export-' + Date.now() + '.json' });
      try {
        await message.author.send({ content: 'Token export (`' + tokens.length + '` entries). Keep private.', files: [file] });
        await message.reply('Export sent in DM.');
      } catch {
        await message.reply({ content: 'Could not DM you — sending here (delete after download).', files: [file] });
      }
      logs.adminLog(client, 'Token export', 'By <@' + message.author.id + '> count=' + tokens.length);
      return true;
    }
    if (sub === 'import') {
      let jsonText = null;
      if (message.attachments.size > 0) {
        try {
          const res = await fetch(message.attachments.first().url);
          jsonText = await res.text();
        } catch (e) {
          await message.reply('Failed to download attachment: ' + e.message);
          return true;
        }
      } else {
        const rest = args.slice(1).join(' ');
        if (rest.startsWith('{') || rest.startsWith('[')) jsonText = rest;
      }
      if (!jsonText) {
        await message.reply('Usage: token import — attach a JSON export file, or paste JSON.');
        return true;
      }
      let data;
      try { data = JSON.parse(jsonText); } catch {
        await message.reply('Invalid JSON.');
        return true;
      }
      const list = Array.isArray(data) ? data : (data.tokens || []);
      if (!list.length) { await message.reply('No tokens found in payload.'); return true; }
      let added = 0, skipped = 0;
      for (const t of list) {
        if (!t.access_token || !t.user_id) { skipped++; continue; }
        const exists = await one(
          'SELECT id FROM tokens WHERE access_token = $1 OR (user_id = $2 AND valid = 1)',
          [t.access_token, String(t.user_id)]
        );
        if (exists) { skipped++; continue; }
        await query(
          `INSERT INTO tokens (user_id, access_token, refresh_token, expires_at, scope, valid)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [String(t.user_id), t.access_token, t.refresh_token || null, t.expires_at || null, t.scope || 'identify guilds.join', t.valid === 0 ? 0 : 1]
        );
        added++;
      }
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Token Import').setColor(0x57f287).addFields(
        { name: 'Added', value: '`' + added + '`', inline: true },
        { name: 'Skipped', value: '`' + skipped + '`', inline: true }
      ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
      logs.adminLog(client, 'Token import', 'By <@' + message.author.id + '> added=' + added);
      return true;
    }
    return false;
  }

  if (cmd === 'bio') {
    if (!perms.isOwner(message.author.id) && !(await perms.canUse(message.author.id, 'bio'))) return true;
    const text = args.join(' ').trim();
    if (!text) { await message.reply('Usage: bio <status text>  (or `bio clear`)'); return true; }
    if (text.toLowerCase() === 'clear') {
      await client.user.setPresence({ activities: [], status: 'online' });
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Bio Cleared').setColor(0x5865f2).setFooter({ text: 'Member Farm' }).setTimestamp()] });
      return true;
    }
    try { await client.user.setActivity(text.slice(0, 128), { type: 3 }); } catch {}
    await message.reply({ embeds: [new EmbedBuilder().setTitle('Bio Updated').setColor(0x57f287)
      .setDescription('`' + text.slice(0, 128) + '`').setFooter({ text: 'Member Farm' }).setTimestamp()] });
    logs.adminLog(client, 'Bio changed', 'By <@' + message.author.id + '>');
    return true;
  }

  if (cmd === 'banfarm') {
    if (!(await perms.canUse(message.author.id, 'banfarm')) && !perms.isOwner(message.author.id)) return true;
    const user = message.mentions.users.first() || (args[0] && /^\d{17,20}$/.test(args[0]) ? { id: args[0] } : null);
    if (!user) { await message.reply('Usage: banfarm @user [reason]'); return true; }
    if (String(user.id) === String(config.OWNER_ID)) { await message.reply('Cannot banfarm the owner.'); return true; }
    const reason = args.slice(1).join(' ') || 'No reason provided';
    await query(
      `INSERT INTO user_blacklist (user_id, reason, added_by) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, added_by = EXCLUDED.added_by`,
      [String(user.id), reason, message.author.id]
    );
    await query('DELETE FROM grants WHERE user_id = $1', [String(user.id)]);
    await queue.clearUserQueue(user.id);
    await message.reply({ embeds: [new EmbedBuilder().setTitle('User Banfarmed').setColor(0xed4245).addFields(
      { name: 'User', value: '<@' + user.id + '>', inline: true },
      { name: 'User ID', value: '`' + user.id + '`', inline: true },
      { name: 'Reason', value: reason },
      { name: 'Action by', value: '<@' + message.author.id + '>', inline: true }
    ).setDescription('Grants revoked · queue cleared · blacklisted.')
      .setFooter({ text: 'Member Farm' }).setTimestamp()] });
    logs.adminLog(client, 'Banfarm', '<@' + user.id + '> by <@' + message.author.id + '> — ' + reason, 0xed4245);
    return true;
  }

  if (cmd === 'invites') {
    if (!(await perms.canUse(message.author.id, 'invites')) && !perms.isOwner(message.author.id)) return true;
    const sub = (args[0] || 'list').toLowerCase();
    if (sub === 'list' || !sub) {
      const rows = await many('SELECT * FROM bot_invites ORDER BY created_at DESC LIMIT 25');
      if (!rows.length) { await message.reply('No invite records yet.'); return true; }
      const lines = rows.map(r =>
        '`'+r.guild_id+'` **'+(r.guild_name||'?')+'** — by ' + (r.inviter_id ? '<@'+r.inviter_id+'>' : '`unknown`') + ' · ' + (r.member_count??'?') + ' members'
      );
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Bot Invite Tracker')
        .setDescription(lines.join('\n').slice(0, 4000))
        .setColor(0x5865f2).setFooter({ text: 'Member Farm · last 25' }).setTimestamp()] });
      return true;
    }
    if (sub === 'user') {
      const uid = message.mentions.users.first()?.id || args[1];
      if (!uid) { await message.reply('Usage: invites user @user'); return true; }
      const rows = await many('SELECT * FROM bot_invites WHERE inviter_id = $1 ORDER BY created_at DESC', [String(uid)]);
      await message.reply({ embeds: [new EmbedBuilder().setTitle('Invites by User')
        .setDescription(rows.length ? rows.map(r => '`'+r.guild_id+'` '+(r.guild_name||'')).join('\n') : 'None')
        .setColor(0x5865f2).setFooter({ text: 'Member Farm' }).setTimestamp()] });
      return true;
    }
    await message.reply('Usage: invites · invites user @user');
    return true;
  }

  if (cmd === 'antiraid') {
    if (!(await perms.canUse(message.author.id, 'antiraid')) && !perms.isOwner(message.author.id)) return true;
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'enable') {
      await setSetting('antiraid_enabled', '1');
      await message.reply({ embeds: [new EmbedBuilder().setTitle('AntiRaid Enabled').setColor(0x57f287)
        .setDescription('Queue auto-pauses when rate-limits spike.')
        .setFooter({ text: 'Member Farm' }).setTimestamp()] });
      return true;
    }
    if (sub === 'disable') {
      await setSetting('antiraid_enabled', '0');
      await setSetting('antiraid_triggered', '0');
      await message.reply({ embeds: [new EmbedBuilder().setTitle('AntiRaid Disabled').setColor(0xfaa61a)
        .setFooter({ text: 'Member Farm' }).setTimestamp()] });
      return true;
    }
    if (sub === 'threshold') {
      const n = parseInt(args[1], 10);
      if (!n || n < 1) { await message.reply('Usage: antiraid threshold <number>'); return true; }
      await setSetting('antiraid_threshold', String(n));
      await message.reply('AntiRaid threshold set to **' + n + '** (429s / 5 min).');
      return true;
    }
    if (sub === 'clear') {
      await setSetting('antiraid_hits', '[]');
      await setSetting('antiraid_triggered', '0');
      await queue.resumeQueue();
      await message.reply('AntiRaid counters cleared and queue resumed.');
      return true;
    }
    const enabled = (await getSetting('antiraid_enabled', '0')) === '1';
    const threshold = await getSetting('antiraid_threshold', '8');
    const triggered = (await getSetting('antiraid_triggered', '0')) === '1';
    let hits = [];
    try { hits = JSON.parse(await getSetting('antiraid_hits', '[]')); } catch {}
    const now = Date.now();
    hits = hits.filter(t => now - t < 5 * 60 * 1000);
    await message.reply({ embeds: [new EmbedBuilder().setTitle('AntiRaid Status').setColor(triggered ? 0xed4245 : 0x5865f2).addFields(
      { name: 'Enabled', value: enabled ? '`ON`' : '`OFF`', inline: true },
      { name: 'Threshold', value: '`' + threshold + '` / 5min', inline: true },
      { name: 'Recent 429s', value: '`' + hits.length + '`', inline: true },
      { name: 'Triggered', value: triggered ? '**YES** — queue paused' : '`no`', inline: true },
      { name: 'Queue', value: (await queue.isPaused()) ? '`PAUSED`' : '`running`', inline: true }
    ).setFooter({ text: 'Member Farm' }).setTimestamp()] });
    return true;
  }

  if (cmd === 'panel') {
    if (!(await perms.canUse(message.author.id, 'panel')) && !perms.isOwner(message.author.id)) return true;
    const oauthUrl = await getSetting('oauth_link',
      `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI || '')}&response_type=code&scope=identify%20guilds.join`);
    const botInvite = config.BOT_INVITE || `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=8&scope=bot`;
    const stock = (await one('SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1'))?.c || 0;
    const tokens = (await one('SELECT COUNT(*)::int AS c FROM tokens WHERE valid = 1'))?.c || 0;
    const emb = new EmbedBuilder()
      .setTitle('Member Farm Panel')
      .setColor(0x5865f2)
      .setDescription('Verify your account · Add the bot · Check live stock.')
      .addFields(
        { name: 'Valid Auths', value: '`' + tokens + '`', inline: true },
        { name: 'Stock', value: '`' + stock + '`', inline: true },
        { name: 'Servers', value: '`' + client.guilds.cache.size + '`', inline: true }
      )
      .setFooter({ text: 'Member Farm' })
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('—> Verify').setStyle(ButtonStyle.Link).setURL(oauthUrl),
      new ButtonBuilder().setLabel('Add Bot →').setStyle(ButtonStyle.Link).setURL(botInvite),
      new ButtonBuilder().setCustomId('panel_stock').setLabel('Stock').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_status').setLabel('Status').setStyle(ButtonStyle.Primary)
    );
    await message.channel.send({ embeds: [emb], components: [row] });
    return true;
  }

  if (cmd === 'status') {
    const uptimeMs = client.uptime || 0;
    const h = Math.floor(uptimeMs / 3600000);
    const m = Math.floor((uptimeMs % 3600000) / 60000);
    const s = Math.floor((uptimeMs % 60000) / 1000);
    const stock = (await one('SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1'))?.c || 0;
    const tokens = (await one('SELECT COUNT(*)::int AS c FROM tokens WHERE valid = 1'))?.c || 0;
    const qC = (await one(`SELECT COUNT(*)::int AS c FROM queue WHERE status = 'pending'`))?.c || 0;
    const paused = await queue.isPaused();
    const antiraid = (await getSetting('antiraid_enabled', '0')) === '1';
    const triggered = (await getSetting('antiraid_triggered', '0')) === '1';
    const lastCheck = await getSetting('last_checkauth');
    const health = await getSetting('last_checkauth_health', '—');
    const lastCheckStr = lastCheck ? '<t:' + Math.floor(Number(lastCheck) / 1000) + ':R>' : '`never`';
    await message.reply({ embeds: [new EmbedBuilder()
      .setTitle('Bot Status')
      .setColor(paused || triggered ? 0xed4245 : 0x57f287)
      .addFields(
        { name: 'Uptime', value: '`' + h + 'h ' + m + 'm ' + s + 's`', inline: true },
        { name: 'Ping', value: '`' + Math.round(client.ws.ping) + 'ms`', inline: true },
        { name: 'Guilds', value: '`' + client.guilds.cache.size + '`', inline: true },
        { name: 'Valid Auths', value: '`' + tokens + '`', inline: true },
        { name: 'Stock', value: '`' + stock + '`', inline: true },
        { name: 'Queue', value: '`' + qC + '`' + (paused ? ' **PAUSED**' : ''), inline: true },
        { name: 'AntiRaid', value: antiraid ? (triggered ? '**TRIGGERED**' : '`ON`') : '`OFF`', inline: true },
        { name: 'Last Checkauth', value: lastCheckStr + ' · health `' + health + '%`', inline: true }
      )
      .setFooter({ text: 'Member Farm' })
      .setTimestamp()] });
    return true;
  }

  return false;
}

module.exports = { handleExtra, buildHelpEmbed };
