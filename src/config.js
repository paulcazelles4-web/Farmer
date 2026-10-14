// language: JavaScript, file: config.js, runtime: Node 20+
module.exports = {
  OWNER_ID: process.env.OWNER_ID || '1264183250243420211',
  DEFAULT_PREFIX: '!',
  BASE_SEND: 2,
  QUEUE_MAX: 10,
  // Fill these after deploy or via commands where possible
  VERIFIED_ROLE_ID: process.env.VERIFIED_ROLE_ID || '',
  SPECIAL_CHANNEL_ID: process.env.SPECIAL_CHANNEL_ID || '',
  SPECIAL_CHANNEL_NAME: process.env.SPECIAL_CHANNEL_NAME || 'join',
  PAYOUT_CENTRAL_GUILD_ID: process.env.PAYOUT_CENTRAL_GUILD_ID || '',
  COOLDOWN_MS: 0,
};
