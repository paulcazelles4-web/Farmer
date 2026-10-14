// language: JavaScript, file: oauth.js
const express = require('express');
const { db, getSetting, setSetting } = require('./db');

function createOAuthServer(client) {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.get('/', (req, res) => res.send('Member Farm OAuth server online.'));

  app.get('/oauth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');

    try {
      const params = new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI,
      });

      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        console.error('Token error', tokenData);
        return res.status(400).send('Failed to obtain token');
      }

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const user = await userRes.json();

      const expiresAt = Math.floor(Date.now() / 1000) + (tokenData.expires_in || 604800);

      db.prepare(`
        INSERT INTO tokens (user_id, access_token, refresh_token, expires_at, scope, valid)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(user.id, tokenData.access_token, tokenData.refresh_token || null, expiresAt, tokenData.scope || 'identify guilds.join');

      // update auth stats
      const stats = db.prepare('SELECT * FROM auth_stats WHERE id = 1').get();
      const now = Math.floor(Date.now() / 1000);
      let last24 = stats.last_24h;
      if (now - stats.last_24h_reset > 86400) {
        last24 = 0;
        db.prepare('UPDATE auth_stats SET last_24h = 0, last_24h_reset = ? WHERE id = 1').run(now);
      }
      db.prepare('UPDATE auth_stats SET total_all_time = total_all_time + 1, last_24h = last_24h + 1 WHERE id = 1').run();

      res.send(`<html><body style="font-family:sans-serif;background:#1a1a2e;color:#eee;text-align:center;padding:60px"><h1>Authorized</h1><p>Account linked successfully. You can close this window.</p></body></html>`);
    } catch (e) {
      console.error(e);
      res.status(500).send('Internal error');
    }
  });

  app.listen(PORT, () => console.log(`OAuth server on :${PORT}`));
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
