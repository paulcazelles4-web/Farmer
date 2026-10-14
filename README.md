# Farmer

English-first Discord community-growth bot, designed for Railway deployment.

## Setup
1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable Message Content Intent.
3. Set the environment variables from `.env.example`.
4. Run `npm install` and `npm start`.
5. On Railway, configure the same variables and attach persistent storage for the SQLite database.

OAuth verification is consent-based. This starter does not pool account tokens or automate bulk member joins. The `!join` command creates a transparent queue request only.

See `!help` for available commands. Set `OWNER_ID` before starting.
