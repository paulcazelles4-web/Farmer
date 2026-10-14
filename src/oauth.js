// language: JavaScript, file: oauth.js
const express = require('express');
const { query, one } = require('./db');

function createOAuthServer(client) {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.get('/', (req, res) => res.send('Member Farm OAuth server online.'));
  app.get('/health', (req, res) => res.json({ ok: true, bot: client?.user?.tag || 'starting' }));

  app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    const err = req.query.error;
    if (err) return res.status(400).send(`<h1>OAuth error</h1><pre>${err}</pre>`);
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
        code,
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
        return res.status(400).send(`<pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
      }

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const user = await userRes.json();
      if (!user.id) return res.status(400).send('Failed to fetch user');

      const expiresAt = Math.floor(Date.now() / 1000) + (tokenData.expires_in || 604800);

      await query(
        `INSERT INTO tokens (user_id, access_token, refresh_token, expires_at, scope, valid)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [user.id, tokenData.access_token, tokenData.refresh_token || null, expiresAt, tokenData.scope || 'identify guilds.join']
      );

      const stats = await one('SELECT * FROM auth_stats WHERE id = 1');
      const now = Math.floor(Date.now() / 1000);
      if (now - (Number(stats?.last_24h_reset) || 0) > 86400) {
        await query('UPDATE auth_stats SET last_24h = 0, last_24h_reset = $1 WHERE id = 1', [now]);
      }
      await query('UPDATE auth_stats SET total_all_time = total_all_time + 1, last_24h = last_24h + 1 WHERE id = 1');

      res.send('<html><body style="font-family:sans-serif;background:#1a1a2e;color:#eee;text-align:center;padding:60px"><h1>Authorized</h1><p>Account linked. You can close this window.</p></body></html>');
    } catch (e) {
      console.error(e);
      res.status(500).send(`Internal error: ${e.message}`);
    }
  });

  app.listen(PORT, '0.0.0.0', () => console.log(`OAuth server on 0.0.0.0:${PORT}`));
  return app;
}

async function joinGuild(accessToken, guildId, userId) {
  if (!userId) return false;
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${process.env.BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (res.status === 201 || res.status === 204) return true;
  let body = '';
  try { body = await res.text(); } catch {}
  console.error(`joinGuild fail guild=${guildId} user=${userId} status=${res.status} body=${body}`);
  return false;
}

module.exports = { createOAuthServer, joinGuild };
