// language: JavaScript, file: color_cmd.js
const { EmbedBuilder } = require('discord.js');
const { getEmbedColor, getEmbedHex, setEmbedColor } = require('./embed_util');
const logs = require('./logs');

async function handleColor(message, args, client, perms) {
  if (!(await perms.canUse(message.author.id, 'color')) && !perms.isOwner(message.author.id)) return true;
  const arg = (args[0] || '').trim();
  if (!arg) {
    const hex = await getEmbedHex();
    const col = await getEmbedColor();
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Embed Color')
          .setColor(col)
          .addFields(
            { name: 'Current', value: '`#' + hex + '`', inline: true },
            { name: 'Usage', value: '`color #128383` · `color reset`', inline: true }
          )
          .setFooter({ text: 'Member Farm' })
          .setTimestamp(),
      ],
    });
    return true;
  }
  const hex = await setEmbedColor(arg);
  if (!hex) {
    await message.reply('Invalid color. Use a hex like `#128383` or `color reset`.');
    return true;
  }
  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Embed Color Updated')
        .setColor(parseInt(hex, 16))
        .setDescription('Primary embed color set to `#' + hex + '`.')
        .setFooter({ text: 'Member Farm' })
        .setTimestamp(),
    ],
  });
  logs.adminLog(client, 'Embed color', 'By <@' + message.author.id + '> → `#' + hex + '`');
  return true;
}

module.exports = { handleColor };
