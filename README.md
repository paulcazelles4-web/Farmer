# Farmer

English-first Discord bot for consent-based community onboarding and server administration. Built with Node.js 20+, discord.js v14, Express, and SQLite.

## Current capabilities

- Prefix commands (default: `!`) and owner-controlled command grants.
- Discord OAuth2 identity verification using the `identify` scope, one-time state values, a 10-minute verification window, and an account-ID match against the Discord user who invoked `!verify`.
- Optional Verified-role assignment when the configured role exists in the server where verification began.
- Persistent SQLite storage for settings, permissions, queue records, profiles, logs, blacklist entries, and verification timestamps.
- Configurable command cooldown, maintenance mode, and maintenance allowlist.
- Queue records with duplicate prevention, capacity limit (10), priority, ordering, inspection, pause/resume, and removal.
- Server checks, blacklist management, basic statistics, user profiles, and four configurable log categories.
- Confirmed announcements to one selected server at a time. Bulk `all` announcements are disabled.
- Health endpoint at `/health`.

## Commands

Run `!help` in a server where the bot is installed. The owner ID configured in `OWNER_ID` controls administrative commands. Grant other users access with `!grant @user <command|all>` and revoke it with `!grant revoke @user <command|all>`.

Useful setup commands:

- `!verifyrole set @role` — configure the role to assign after successful identity verification.
- `!verify` — create a short-lived, account-bound OAuth verification link.
- `!queue`, `!queue info <serverID>`, `!queue priority <serverID> <0-5>`, `!queue move <serverID> <position>`.
- `!announce <single-server-ID> <message>` — previews the message and requires confirmation before sending.
- `!prefix set <prefix>`, `!cooldown <seconds>`, and `!maintenance enable|disable`.

The `!auth`, `!stock`, `!restock`, and `!remove` commands do not manage or store reusable OAuth tokens. Token pooling and automated bulk member joins are not implemented. `!join <serverID>` records an onboarding request in the local queue only; it does not make a member join a destination server.

## Local setup

1. Install Node.js 20 or newer.
2. Create a Discord application and bot in the Discord Developer Portal.
3. Enable **Message Content Intent**. Enable **Server Members Intent** for role assignment after verification.
4. Copy `.env.example` to `.env` and fill in the bot token, application ID, client secret, owner ID, and public OAuth callback URL.
5. In the Discord Developer Portal, add the exact same `OAUTH_REDIRECT_URI` to the OAuth2 redirect URLs.
6. Install and start:
   ```sh
   npm install
   npm start
   ```
7. Invite the bot with only the permissions it needs. For role assignment, give it **Manage Roles** and place its highest role above the Verified role.
8. Start `!verify` in the server where you want to assign the Verified role, then configure the role using `!verifyrole set @role`.

OAuth uses only the `identify` scope. The bot checks that the OAuth account ID matches the Discord account that initiated verification. Verification state is short-lived and stored in memory; users must restart the verification flow if the bot restarts before the callback.

## Railway deployment

1. Create a Railway project from this GitHub repository.
2. Add the variables listed in `.env.example` to the Railway service.
3. Add a persistent volume and point `DATABASE_PATH` to a file on that volume (for example, `/data/farmer.sqlite`).
4. Deploy and check `/health` on the generated public domain.
5. Set `OAUTH_REDIRECT_URI` to `https://YOUR-DOMAIN/oauth/callback` and register that exact URL in the Discord Developer Portal.
6. Keep `DISCORD_TOKEN` and `DISCORD_CLIENT_SECRET` private. Never paste them into chat or commit them to GitHub.

## Security and limitations

- OAuth verification confirms the identity of the Discord account that initiated the flow; it does not collect reusable tokens or grant the bot permission to join accounts to other servers.
- Queue priority and ordering affect only stored queue records. No background worker performs destination-server joins.
- Announcements target one selected server and require a confirmation button; bulk announcements are disabled.
- Test OAuth configuration, role hierarchy, database persistence, and permissions in a private test server before relying on the bot.
