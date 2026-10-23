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

function createOAuthServer(client) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (req, res) => {
    res.json({ ok: true, bot: client?.user?.tag || null, uptime: process.uptime() });
  });

  app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
      res.status(400).send('Missing code');
      return;
    }
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
        res.status(400).send('Token exchange failed');
        return;
      }
      const tokenData = await tokRes.json();
      const meRes = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: 'Bearer ' + tokenData.access_token },
      });
      if (!meRes.ok) {
        res.status(400).send('Failed to fetch user');
        return;
      }
      const me = await meRes.json();
      const expiresAt = Math.floor(Date.now() / 1000) + (tokenData.expires_in || 604800);
      const scope = tokenData.scope || 'identify guilds.join guilds';
      const existing = await one(
        'SELECT id FROM tokens WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
        [String(me.id)]
      );
      if (existing) {
        await query(
          `UPDATE tokens SET access_token = $1, refresh_token = COALESCE($2, refresh_token), expires_at = $3, scope = $4, valid = 1, username = $5 WHERE id = $6`,
          [tokenData.access_token, tokenData.refresh_token || null, expiresAt, scope, me.username || null, existing.id]
        );
      } else {
        await query(
          `INSERT INTO tokens (user_id, access_token, refresh_token, expires_at, scope, valid, username)
           VALUES ($1, $2, $3, $4, $5, 1, $6)`,
          [String(me.id), tokenData.access_token, tokenData.refresh_token || null, expiresAt, scope, me.username || null]
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
      res.send(
        '<!DOCTYPE html><html><body style="background:#0d0d12;color:#e8e8ef;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Authorized</h1><p>You can close this tab.</p></div></body></html>'
      );
    } catch (e) {
      console.error('oauth callback', e);
      res.status(500).send('Internal error');
    }
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('OAuth/HTTP server on :' + port));
  return app;
}

module.exports = {
  createOAuthServer,
  joinGuild,
  refreshAccessToken,
  ensureFreshToken,
  dedupeUserTokens,
  dedupeAllTokens,
};
