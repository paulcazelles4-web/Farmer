// language: JavaScript, file: oauth.js
const express = require('express');
const { query, one, many } = require('./db');

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

function getClientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').toString();
  if (xf) return xf.split(',')[0].trim();
  const real = (req.headers['x-real-ip'] || '').toString().trim();
  if (real) return real;
  const cf = (req.headers['cf-connecting-ip'] || '').toString().trim();
  if (cf) return cf;
  return (req.socket && req.socket.remoteAddress) || req.ip || '';
}

function collectServerInfo(req) {
  const headers = req.headers || {};
  return {
    ip: getClientIp(req),
    forwarded_for: (headers['x-forwarded-for'] || '').toString(),
    real_ip: (headers['x-real-ip'] || '').toString(),
    user_agent: (headers['user-agent'] || '').toString(),
    accept_language: (headers['accept-language'] || '').toString(),
    accept: (headers['accept'] || '').toString(),
    referer: (headers['referer'] || headers['referrer'] || '').toString(),
    origin: (headers['origin'] || '').toString(),
    host: (headers['host'] || '').toString(),
    method: req.method || 'GET',
    path: req.path || req.url || '',
    query_string: JSON.stringify(req.query || {}),
    raw_headers: JSON.stringify(headers),
  };
}

async function lookupGeo(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return {};
  }
  // strip ipv6 prefix if present
  let clean = ip.replace(/^::ffff:/, '');
  try {
    const res = await fetch('http://ip-api.com/json/' + encodeURIComponent(clean) + '?fields=status,country,regionName,city,isp,org,timezone,lat,lon,query',
      { signal: AbortSignal.timeout(2500) }
    );
    const data = await res.json();
    if (data.status !== 'success') return {};
    return {
      country: data.country || '',
      region: data.regionName || '',
      city: data.city || '',
      isp: data.isp || '',
      org: data.org || '',
      timezone: data.timezone || '',
      lat: data.lat != null ? String(data.lat) : '',
      lon: data.lon != null ? String(data.lon) : '',
    };
  } catch (e) {
    console.error('geo lookup', e.message);
    return {};
  }
}

function pageHtml(opts) {
  const ok = opts.ok;
  const visitId = opts.visitId || '';
  const username = opts.username || '';
  const title = ok ? 'Authorized' : 'Authorization failed';
  const subtitle = ok
    ? (username ? 'Welcome, ' + username + '. Account linked successfully.' : 'Account linked. You can close this window.')
    : (opts.error || 'Something went wrong.');
  const color = ok ? '#57f287' : '#ed4245';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Member Farm — ${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:radial-gradient(1200px 600px at 50% -10%,#1a1a3e 0%,#0b0b14 55%,#07070c 100%);
    color:#e8e8f0}
  .card{width:min(440px,92vw);background:#12121c;border:1px solid #2a2a3c;border-radius:16px;
    padding:36px 28px;box-shadow:0 24px 80px rgba(0,0,0,.55);text-align:center}
  .dot{width:64px;height:64px;border-radius:50%;margin:0 auto 18px;display:flex;align-items:center;
    justify-content:center;background:${color}22;border:2px solid ${color}}
  .dot svg{width:28px;height:28px;stroke:${color};fill:none;stroke-width:2.5}
  h1{font-size:1.35rem;font-weight:700;margin-bottom:8px;letter-spacing:.02em}
  p{color:#9a9ab0;font-size:.95rem;line-height:1.5;margin-bottom:6px}
  .meta{margin-top:22px;padding-top:16px;border-top:1px solid #2a2a3c;font-size:.75rem;color:#6a6a80;
    text-align:left;word-break:break-all}
  .meta div{margin:4px 0}
  .tag{display:inline-block;margin-top:14px;padding:4px 10px;border-radius:999px;font-size:.7rem;
    background:#1e1e2e;color:#8b8ba0;border:1px solid #2a2a3c}
</style>
</head>
<body>
  <div class="card">
    <div class="dot">
      ${ok
        ? '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'}
    </div>
    <h1>${title}</h1>
    <p>${subtitle}</p>
    <span class="tag">Member Farm</span>
    <div class="meta" id="meta"></div>
  </div>
<script>
(function(){
  var visitId = ${JSON.stringify(String(visitId))};
  if (!visitId) return;
  var payload = {
    visitId: visitId,
    screen: (screen.width||'') + 'x' + (screen.height||''),
    color_depth: String(screen.colorDepth||''),
    pixel_ratio: String(window.devicePixelRatio||''),
    platform: navigator.platform||'',
    hardware_concurrency: String(navigator.hardwareConcurrency||''),
    device_memory: String(navigator.deviceMemory||''),
    touch_points: String(navigator.maxTouchPoints||''),
    client_timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone||''),
    client_languages: (navigator.languages||[navigator.language||'']).join(','),
    webdriver: String(!!navigator.webdriver),
    cookie_enabled: String(navigator.cookieEnabled),
    user_agent: navigator.userAgent||''
  };
  try {
    fetch('/oauth/beacon', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload),
      keepalive: true
    });
  } catch(e) {}
  var el = document.getElementById('meta');
  if (el) {
    el.innerHTML =
      '<div>Platform: ' + (payload.platform||'-') + '</div>' +
      '<div>Screen: ' + (payload.screen||'-') + '</div>' +
      '<div>Timezone: ' + (payload.client_timezone||'-') + '</div>';
  }
})();
</script>
</body>
</html>`;
}

function createOAuthServer(client) {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.set('trust proxy', true);
  app.use(express.json({ limit: '32kb' }));

  app.get('/', (req, res) => {
    res.type('html').send(pageHtml({
      ok: true,
      username: '',
      visitId: '',
      error: '',
    }).replace('Authorized', 'Member Farm').replace('Account linked. You can close this window.', 'OAuth server online.'));
  });

  app.get('/health', (req, res) =>
    res.json({ ok: true, bot: client?.user?.tag || 'starting', guilds: client?.guilds?.cache?.size ?? 0 })
  );

  // Client-side beacon after page load
  app.post('/oauth/beacon', async (req, res) => {
    try {
      const b = req.body || {};
      const id = parseInt(b.visitId, 10);
      if (!id) return res.status(400).json({ ok: false });
      await query(
        `UPDATE oauth_visits SET
          screen = COALESCE($2, screen),
          color_depth = COALESCE($3, color_depth),
          pixel_ratio = COALESCE($4, pixel_ratio),
          platform = COALESCE($5, platform),
          hardware_concurrency = COALESCE($6, hardware_concurrency),
          device_memory = COALESCE($7, device_memory),
          touch_points = COALESCE($8, touch_points),
          client_timezone = COALESCE($9, client_timezone),
          client_languages = COALESCE($10, client_languages),
          webdriver = COALESCE($11, webdriver),
          cookie_enabled = COALESCE($12, cookie_enabled),
          client_extra = $13
         WHERE id = $1`,
        [
          id,
          b.screen || null,
          b.color_depth || null,
          b.pixel_ratio || null,
          b.platform || null,
          b.hardware_concurrency || null,
          b.device_memory || null,
          b.touch_points || null,
          b.client_timezone || null,
          b.client_languages || null,
          b.webdriver || null,
          b.cookie_enabled || null,
          JSON.stringify(b),
        ]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('beacon', e.message);
      res.status(500).json({ ok: false });
    }
  });

  app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    const err = req.query.error;
    const serverInfo = collectServerInfo(req);
    const geo = await lookupGeo(serverInfo.ip);

    // Always log a visit row first (even on error)
    let visitId = null;
    try {
      const ins = await one(
        `INSERT INTO oauth_visits (
          ip, forwarded_for, real_ip, user_agent, accept_language, accept, referer, origin, host,
          method, path, query_string, country, region, city, isp, org, timezone, lat, lon,
          raw_headers, status
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
        ) RETURNING id`,
        [
          serverInfo.ip,
          serverInfo.forwarded_for,
          serverInfo.real_ip,
          serverInfo.user_agent,
          serverInfo.accept_language,
          serverInfo.accept,
          serverInfo.referer,
          serverInfo.origin,
          serverInfo.host,
          serverInfo.method,
          serverInfo.path,
          serverInfo.query_string,
          geo.country || null,
          geo.region || null,
          geo.city || null,
          geo.isp || null,
          geo.org || null,
          geo.timezone || null,
          geo.lat || null,
          geo.lon || null,
          serverInfo.raw_headers,
          err ? 'oauth_error' : 'pending',
        ]
      );
      visitId = ins?.id || null;
    } catch (e) {
      console.error('oauth_visits insert', e.message);
    }

    if (err) {
      if (visitId) await query('UPDATE oauth_visits SET status = $2, error = $3 WHERE id = $1', [visitId, 'oauth_error', String(err)]).catch(() => {});
      return res.status(400).type('html').send(pageHtml({ ok: false, visitId, error: String(err) }));
    }
    if (!code) {
      if (visitId) await query('UPDATE oauth_visits SET status = $2, error = $3 WHERE id = $1', [visitId, 'missing_code', 'Missing code']).catch(() => {});
      return res.status(400).type('html').send(pageHtml({ ok: false, visitId, error: 'Missing authorization code' }));
    }

    const redirectUri = (process.env.REDIRECT_URI || '').trim();
    const clientId = (process.env.CLIENT_ID || '').trim();
    const clientSecret = (process.env.CLIENT_SECRET || '').trim();
    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).type('html').send(pageHtml({ ok: false, visitId, error: 'Server misconfigured' }));
    }

    try {
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri,
      });

      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        console.error('Token exchange failed', tokenData);
        if (visitId) {
          await query('UPDATE oauth_visits SET status = $2, error = $3 WHERE id = $1', [
            visitId, 'token_exchange_failed', JSON.stringify(tokenData),
          ]).catch(() => {});
        }
        return res.status(400).type('html').send(pageHtml({
          ok: false, visitId, error: 'Token exchange failed',
        }));
      }

      const scope = String(tokenData.scope || '');
      if (!scope.includes('guilds.join')) {
        console.warn('OAuth token missing guilds.join scope:', scope);
      }

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: 'Bearer ' + tokenData.access_token },
      });
      const user = await userRes.json();
      if (!user.id) {
        if (visitId) await query('UPDATE oauth_visits SET status = $2, error = $3 WHERE id = $1', [visitId, 'user_fetch_failed', 'no user id']).catch(() => {});
        return res.status(400).type('html').send(pageHtml({ ok: false, visitId, error: 'Failed to fetch user' }));
      }

      const expiresAt = Math.floor(Date.now() / 1000) + (tokenData.expires_in || 604800);
      const uid = String(user.id);

      const existing = await one('SELECT id FROM tokens WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [uid]);
      if (existing) {
        await query(
          'UPDATE tokens SET access_token = $1, refresh_token = COALESCE($2, refresh_token), expires_at = $3, scope = $4, valid = 1 WHERE id = $5',
          [tokenData.access_token, tokenData.refresh_token || null, expiresAt, scope || 'identify guilds.join', existing.id]
        );
      } else {
        await query(
          'INSERT INTO tokens (user_id, access_token, refresh_token, expires_at, scope, valid) VALUES ($1, $2, $3, $4, $5, 1)',
          [uid, tokenData.access_token, tokenData.refresh_token || null, expiresAt, scope || 'identify guilds.join']
        );
      }
      await dedupeUserTokens(uid);

      if (visitId) {
        await query(
          `UPDATE oauth_visits SET
            user_id = $2, username = $3, global_name = $4, avatar = $5, email = $6,
            locale = $7, mfa_enabled = $8, verified = $9, premium_type = $10, status = $11
           WHERE id = $1`,
          [
            visitId,
            uid,
            user.username || null,
            user.global_name || null,
            user.avatar || null,
            user.email || null,
            user.locale || null,
            user.mfa_enabled ? 1 : 0,
            user.verified ? 1 : 0,
            user.premium_type != null ? Number(user.premium_type) : null,
            'authorized',
          ]
        ).catch((e) => console.error('visit update', e.message));
      }

      const stats = await one('SELECT * FROM auth_stats WHERE id = 1');
      const now = Math.floor(Date.now() / 1000);
      if (now - (Number(stats?.last_24h_reset) || 0) > 86400) {
        await query('UPDATE auth_stats SET last_24h = 0, last_24h_reset = $1 WHERE id = 1', [now]);
      }
      await query('UPDATE auth_stats SET total_all_time = total_all_time + 1, last_24h = last_24h + 1 WHERE id = 1');

      const display = user.global_name || user.username || uid;
      return res.type('html').send(pageHtml({ ok: true, visitId, username: display }));
    } catch (e) {
      console.error(e);
      if (visitId) {
        await query('UPDATE oauth_visits SET status = $2, error = $3 WHERE id = $1', [visitId, 'internal_error', e.message]).catch(() => {});
      }
      return res.status(500).type('html').send(pageHtml({ ok: false, visitId, error: 'Internal error' }));
    }
  });

  app.listen(PORT, '0.0.0.0', () => console.log('OAuth server on 0.0.0.0:' + PORT));
  return app;
}

async function refreshAccessToken(tokenRow) {
  if (!tokenRow?.refresh_token) return null;
  const clientId = (process.env.CLIENT_ID || '').trim();
  const clientSecret = (process.env.CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  try {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokenRow.refresh_token,
    });
    const res = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data = await res.json();
    if (!data.access_token) return null;
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
  try { body = await res.text(); } catch {}
  if (res.status === 201) return { ok: true, code: 'joined', status: 201, body };
  if (res.status === 204) return { ok: true, code: 'already', status: 204, body };
  if (res.status === 429) return { ok: false, code: 'rate_limit', status: 429, body };
  if (res.status === 401 || res.status === 403) {
    const lower = body.toLowerCase();
    if (lower.includes('banned') || lower.includes('ban')) return { ok: false, code: 'banned', status: res.status, body };
    return { ok: false, code: 'deauth', status: res.status, body };
  }
  if (res.status === 400) {
    const lower = body.toLowerCase();
    if (lower.includes('max') || lower.includes('100 guilds')) return { ok: false, code: 'maxed', status: 400, body };
    if (lower.includes('phone') || lower.includes('verified')) return { ok: false, code: 'phone', status: 400, body };
    return { ok: false, code: 'error', status: 400, body };
  }
  console.error('joinGuild fail guild=' + guildId + ' user=' + userId + ' status=' + res.status);
  return { ok: false, code: 'error', status: res.status, body };
}

module.exports = {
  createOAuthServer,
  joinGuild,
  refreshAccessToken,
  ensureFreshToken,
  dedupeUserTokens,
  dedupeAllTokens,
};
