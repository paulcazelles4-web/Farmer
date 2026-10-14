// language: JavaScript, file: config.js, runtime: Node 20+
module.exports = {
  OWNER_ID: process.env.OWNER_ID || '1264183250243420211',
  MAIN_GUILD_ID: process.env.MAIN_GUILD_ID || '1499704751481294878',
  BOT_INVITE:
    process.env.BOT_INVITE ||
    'https://discord.com/oauth2/authorize?client_id=1559903456469196810&permissions=8&integration_type=0&scope=bot',
  DEFAULT_PREFIX: '!',
  BASE_SEND: 2,
  QUEUE_MAX: 10,
  VERIFIED_ROLE_ID: process.env.VERIFIED_ROLE_ID || '',
  SPECIAL_CHANNEL_ID: process.env.SPECIAL_CHANNEL_ID || '',
  SPECIAL_CHANNEL_NAME: process.env.SPECIAL_CHANNEL_NAME || 'join',
  PAYOUT_CENTRAL_GUILD_ID: process.env.PAYOUT_CENTRAL_GUILD_ID || '',
  COOLDOWN_MS: 0,
};
