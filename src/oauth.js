// language: JavaScript, file: oauth.js
const express = require('express');
const { db } = require('./db');

function createOAuthServer(client) {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.get('/', (req, res) => res.send('Member Farm OAuth server online.'));

  app.get('/health', (req, res) => res.json({ ok: true, bot: client?.user?.tag || 'starting' }));

  app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    const err = req.query.error;
    if (err) {
      return res.status(400).send(`<h1>OAuth error from Discord</h1><pre>${err}: ${req.query.error_description || ''}</pre>`);
    }
    if (!code) return res.status(400).send('Missing code');

    const redirectUri = (process.env.REDIRECT_URI || '').trim();
    const clientId = (process.env.CLIENT_ID || '').trim();
    const clientSecret = (process.env.CLIENT_SECRET || '').trim();

    if (!clientId || !clientSecret || !redirectUri) {
      console.error('Missing env', { clientId: !!clientId, clientSecret: !!clientSecret, redirectUri });
      return res.status(500).send('Server misconfigured: CLIENT_ID / CLIENT_SECRET / REDIRECT_URI missing');
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
        console.error('Token exchange failed', {
          status: tokenRes.status,
          body: tokenData,
          redirect_uri_used: redirectUri,
          client_id: clientId,
        });
        return res.status(400).send(
          `<html><body style="font-family:sans-serif;background:#1a1a2e;color:#eee;padding:40px">
          <h1>Failed to obtain token</h1>
          <p>Discord returned:</p>
          <pre style="background:#111;padding:12px;border-radius:8px">${JSON.stringify(tokenData, null, 2)}</pre>
          <p>Check Railway variables:</p>
          <ul>
            <li>REDIRECT_URI must be <b>exactly</b>: <code>${redirectUri}</code></li>
            <li>Same URL must be in Discord Developer Portal → OAuth2 → Redirects</li>
            <li>CLIENT_ID and CLIENT_SECRET must match the application</li>
          </ul>
          <p>Codes are single-use. Generate a fresh authorize link and try again.</p>
          </body></html>`
        );
      }

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const user = await userRes.json();
      if (!user.id) {
        console.error('User fetch failed', user);
        return res.status(400).send('Token ok but failed to fetch user');
      }

      const expiresAt = Math.floor(Date.now() / 1000) + (tokenData.expires_in || 604800);

      db.prepare(`
        INSERT INTO tokens (user_id, access_token, refresh_token, expires_at, scope, valid)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(user.id, tokenData.access_token, tokenData.refresh_token || null, expiresAt, tokenData.scope || 'identify guilds.join');

      const stats = db.prepare('SELECT * FROM auth_stats WHERE id = 1').get();
      const now = Math.floor(Date.now() / 1000);
      if (now - (stats?.last_24h_reset || 0) > 86400) {
        db.prepare('UPDATE auth_stats SET last_24h = 0, last_24h_reset = ? WHERE id = 1').run(now);
      }
      db.prepare('UPDATE auth_stats SET total_all_time = total_all_time + 1, last_24h = last_24h + 1 WHERE id = 1').run();

      res.send(`<html><body style="font-family:sans-serif;background:#1a1a2e;color:#eee;text-align:center;padding:60px"><h1>Authorized</h1><p>Account linked successfully. You can close this window.</p></body></html>`);
    } catch (e) {
      console.error(e);
      res.status(500).send(`Internal error: ${e.message}`);
    }
  });

  // Railway requires 0.0.0.0
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`OAuth server listening on 0.0.0.0:${PORT}`);
  });
  return app;
}

async function joinGuild(accessToken, guildId) {
  const res = await fetch(`https://discord.com/api/guilds/${guildId}/members/@me`, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${process.env.BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: accessToken }),
  });
  return res.status === 201 || res.status === 204;
}

module.exports = { createOAuthServer, joinGuild };
