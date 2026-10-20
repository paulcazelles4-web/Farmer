// language: JavaScript, file: oauth.js
const express = require('express');
const { query, one, many } = require('./db');

/**
 * Keep exactly one valid token per Discord user_id.
 * Prefer the newest row (highest id). Invalidate the rest and drop them from stock.
 * @returns {{ kept: number, dropped: number }}
 */
async function dedupeUserTokens(userId) {
  const uid = String(userId);
  const rows = await many(
    'SELECT id FROM tokens WHERE user_id = $1 AND valid = 1 ORDER BY id DESC',
    [uid]
  );
  if (rows.length <= 1) return { kept: rows.length, dropped: 0 };

  const keepId = rows[0].id;
  const dropIds = rows.slice(1).map((r) => r.id);

  await query(
    `UPDATE tokens SET valid = 0 WHERE user_id = $1 AND valid = 1 AND id != $2`,
    [uid, keepId]
  );
  for (const id of dropIds) {
    await query('DELETE FROM stock WHERE token_id = $1', [id]);
  }

  console.log(`dedupe user=${uid} kept=#${keepId} dropped=${dropIds.length}`);
  return { kept: 1, dropped: dropIds.length };
}

/**
 * Global pass: one valid token per user across the whole table.
 */
async function dedupeAllTokens() {
  const dupes = await many(
    `SELECT user_id, COUNT(*)::int AS c
     FROM tokens WHERE valid = 1
     GROUP BY user_id HAVING COUNT(*) > 1`
  );
  let dropped = 0;
  for (const d of dupes) {
    const r = await dedupeUserTokens(d.user_id);
    dropped += r.dropped;
  }
  if (dupes.length) {
    console.log(`dedupeAll: ${dupes.length} users cleaned, ${dropped} tokens invalidated`);
  }
  return { users: dupes.length, dropped };
}

function createOAuthServer(client) {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.get('/', (req, res) => res.send('Member Farm OAuth server online.'));
  app.get('/health', (req, res) =>
    res.json({ ok: true, bot: client?.user?.tag || 'starting', guilds: client?.guilds?.cache?.size ?? 0 })
  );

  app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    const err = req.query.error;
    if (err) return res.status(400).send('<h1>OAuth error</h1><pre>' + err + '</pre>');
    if (!code) return res.status(400).send('Missing code');

    const redirectUri = (process.env.REDIRECT_URI || '').trim();
    const clientId = (process.env.CLIENT_ID || '').trim();
    const clientSecret = (process.env.CLIENT_SECRET || '').trim();
    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).send('Missing CLIENT_ID / CLIENT_SECRET / REDIRECT_URI');
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
        return res.status(400).send('<pre>' + JSON.stringify(tokenData, null, 2) + '</pre>');
      }

      const scope = String(tokenData.scope || '');
      if (!scope.includes('guilds.join')) {
        console.warn('OAuth token missing guilds.join scope:', scope);
      }

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: 'Bearer ' + tokenData.access_token },
      });
      const user = await userRes.json();
      if (!user.id) return res.status(400).send('Failed to fetch user');

      const expiresAt = Math.floor(Date.now() / 1000) + (tokenData.expires_in || 604800);
      const uid = String(user.id);

      // Upsert: update newest row for this user, or insert
      const existing = await one(
        'SELECT id FROM tokens WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
        [uid]
      );
      if (existing) {
        await query(
          'UPDATE tokens SET access_token = $1, refresh_token = COALESCE($2, refresh_token), expires_at = $3, scope = $4, valid = 1 WHERE id = $5',
          [
            tokenData.access_token,
            tokenData.refresh_token || null,
            expiresAt,
            scope || 'identify guilds.join',
            existing.id,
          ]
        );
      } else {
        await query(
          'INSERT INTO tokens (user_id, access_token, refresh_token, expires_at, scope, valid) VALUES ($1, $2, $3, $4, $5, 1)',
          [
            uid,
            tokenData.access_token,
            tokenData.refresh_token || null,
            expiresAt,
            scope || 'identify guilds.join',
          ]
        );
      }

      // Enforce 1 valid token per user (drop older duplicates)
      await dedupeUserTokens(uid);

      const stats = await one('SELECT * FROM auth_stats WHERE id = 1');
      const now = Math.floor(Date.now() / 1000);
      if (now - (Number(stats?.last_24h_reset) || 0) > 86400) {
        await query('UPDATE auth_stats SET last_24h = 0, last_24h_reset = $1 WHERE id = 1', [now]);
      }
      await query(
        'UPDATE auth_stats SET total_all_time = total_all_time + 1, last_24h = last_24h + 1 WHERE id = 1'
      );

      res.send(
        '<html><body style="font-family:sans-serif;background:#1a1a2e;color:#eee;text-align:center;padding:60px">' +
          '<h1>Authorized</h1><p>Account linked. You can close this window.</p></body></html>'
      );
    } catch (e) {
      console.error(e);
      res.status(500).send('Internal error: ' + e.message);
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
    if (!data.access_token) {
      console.error('refresh fail', tokenRow.id, data);
      return null;
    }
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
  const refreshed = await refreshAccessToken(tokenRow);
  return refreshed || tokenRow.access_token;
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
    const lower = body.toLowerCase();
    if (lower.includes('banned') || lower.includes('ban')) {
      return { ok: false, code: 'banned', status: res.status, body };
    }
    return { ok: false, code: 'deauth', status: res.status, body };
  }
  if (res.status === 400) {
    const lower = body.toLowerCase();
    if (lower.includes('max') || lower.includes('100 guilds')) {
      return { ok: false, code: 'maxed', status: 400, body };
    }
    if (lower.includes('phone') || lower.includes('verified')) {
      return { ok: false, code: 'phone', status: 400, body };
    }
    return { ok: false, code: 'error', status: 400, body };
  }
  console.error('joinGuild fail guild=' + guildId + ' user=' + userId + ' status=' + res.status + ' body=' + body);
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
