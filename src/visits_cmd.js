// language: JavaScript, file: visits_cmd.js — basic Discord + IP visits (no geo/gps)
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { many, one } = require('./db');
const config = require('./config');
const perms = require('./permissions');

function trunc(s, n) {
  if (s == null || s === '') return '—';
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatVisit(v) {
  const who = v.username
    ? '**' + v.username + '**' + (v.global_name ? ' (' + v.global_name + ')' : '')
    : 'unknown';
  const uid = v.user_id ? '`' + v.user_id + '`' : '—';
  const flags = [];
  if (v.mfa_enabled) flags.push('MFA');
  if (v.verified) flags.push('Email verified');
  if (v.status && String(v.status).includes('alt')) flags.push('ALT FLAG');
  if (v.status && String(v.status).includes('new')) flags.push('NEW ACC');

  const lines = [
    '**#' + v.id + '** · `' + (v.status || '—') + '` · <t:' + (v.created_at || 0) + ':R>',
    'User: ' + who + ' · ' + uid,
    'IP: `' + trunc(v.ip, 48) + '`' + (flags.length ? ' · ' + flags.join(' · ') : ''),
    'UA: ' + trunc(v.user_agent, 100),
  ];
  if (v.error) lines.push('Note: ' + trunc(v.error, 120));
  return lines.join('\n');
}

async function handleVisits(message, client, args) {
  if (!perms.isOwner(message.author.id) && String(message.author.id) !== String(config.OWNER_ID)) {
    // also allow explicit grant
    if (!(await perms.canUse(message.author.id, 'visits'))) {
      return message.reply('No permission.');
    }
  }

  const filterUser = args && args[0] && /^\d{17,20}$/.test(args[0]) ? args[0] : null;
  const limit = Math.min(Math.max(parseInt(args?.[1] || args?.[0], 10) || 20, 1), 50);

  let visits;
  if (filterUser) {
    visits = await many(
      'SELECT id, user_id, username, global_name, ip, user_agent, status, error, mfa_enabled, verified, created_at FROM oauth_visits WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
      [filterUser, limit]
    );
  } else {
    visits = await many(
      'SELECT id, user_id, username, global_name, ip, user_agent, status, error, mfa_enabled, verified, created_at FROM oauth_visits ORDER BY id DESC LIMIT $1',
      [limit]
    );
  }

  if (!visits.length) {
    await message.author.send('No verification visits logged yet.').catch(() => {});
    await message.reply('No visits found.').catch(() => {});
    return;
  }

  const total = filterUser
    ? (await one('SELECT COUNT(*)::int AS c FROM oauth_visits WHERE user_id = $1', [filterUser]))?.c ||
      visits.length
    : (await one('SELECT COUNT(*)::int AS c FROM oauth_visits'))?.c || visits.length;

  const perPage = 3;
  const pages = [];
  for (let i = 0; i < visits.length; i += perPage) {
    const chunk = visits.slice(i, i + perPage);
    const desc = chunk.map(formatVisit).join('\n\n—————\n\n');
    pages.push(
      new EmbedBuilder()
        .setTitle(
          'Verification Visits (' +
            (Math.floor(i / perPage) + 1) +
            '/' +
            Math.ceil(visits.length / perPage) +
            ')'
        )
        .setDescription(desc.slice(0, 4000))
        .setColor(0x5865f2)
        .setFooter({
          text:
            'Member Farm · ' +
            total +
            ' total' +
            (filterUser ? ' · user ' + filterUser : '') +
            ' · last ' +
            visits.length,
        })
        .setTimestamp()
    );
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('visits_prev').setLabel('◀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('visits_next').setLabel('▶').setStyle(ButtonStyle.Secondary)
  );

  const dm = await message.author.send({
    embeds: [pages[0]],
    components: pages.length > 1 ? [row] : [],
  });
  if (pages.length > 1) {
    if (!client.visitsPages) client.visitsPages = new Map();
    client.visitsPages.set(dm.id, { pages, index: 0, owner: message.author.id });
  }
  await message.reply('Sent visits in DM.' + (filterUser ? ' (filtered)' : '')).catch(() => {});
}

module.exports = { handleVisits };
