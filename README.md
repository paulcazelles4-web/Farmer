# Farmer

English-first Discord bot for consent-based community onboarding and server administration. Built with Node.js 20+, discord.js v14, Express, and SQLite.

## Current capabilities

- Prefix commands (default: `!`) and owner-controlled command grants.
- Configurable maintenance mode and per-command cooldown.
- Queue records for explicit onboarding requests, duplicate-request prevention, queue pause/resume, and blacklist management.
- Server checks, basic statistics, user profiles, role settings, and four configurable log categories.
- Health endpoint at `/health`.
- OAuth2 start endpoint is present, but the callback still needs implementation before OAuth verification can be considered complete.

## Commands

Run `!help` in a server where the bot is installed. The owner ID configured in `OWNER_ID` controls administrative commands. Grant other users access with `!grant @user <command|all>` and revoke it with `!grant revoke @user <command|all>`.

## Local setup

1. Install Node.js 20 or newer.
2. Create a Discord application and bot in the Discord Developer Portal.
3. Enable **Message Content Intent**. Enable Server Members Intent only if your verification-role workflow requires it.
4. Copy `.env.example` to `.env` and fill in the bot token, application ID, owner ID, and OAuth redirect URL.
5. Install and start:
   ```sh
   npm install
   npm start
   ```
6. Invite the bot with only the permissions it needs. For role assignment, give it Manage Roles and place its highest role above the role it assigns.

## Railway deployment

1. Create a Railway project from this GitHub repository.
2. Add the variables listed in `.env.example` to the Railway service.
3. Add a persistent volume and point `DATABASE_PATH` to a file on that volume (for example, `/data/farmer.sqlite`).
4. Deploy and check `/health` on the generated public domain.
5. Set the OAuth redirect URL in both Railway and the Discord Developer Portal to the exact callback URL.

## Important limitations

The current `!join` command only creates a queue record; it does not add people to destination servers. OAuth verification is not complete until the callback is implemented and tested. The bot intentionally does not collect reusable OAuth access tokens or automate bulk member joins. Do not paste bot tokens or client secrets into chat or commit them to GitHub.

