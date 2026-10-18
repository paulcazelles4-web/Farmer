// language: JavaScript, file: slash.js — global slash cmds + user-install (external app)
const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const logs = require('./logs');

/**
 * integration_types:
 *   0 = Guild Install
 *   1 = User Install (external app)
 * contexts:
 *   0 = Guild
 *   1 = Bot DM
 *   2 = Private channel
 */
function buildCommands() {
  const pingall = new SlashCommandBuilder()
    .setName('pingall')
    .setDescription('Ping @everyone in this channel')
    .setDMPermission(false);

  // discord.js v14: set these on toJSON payload
  const json = pingall.toJSON();
  json.integration_types = [0, 1]; // guild + user install
  json.contexts = [0, 2]; // guild + private channel (not bot DM)
  // Do NOT require administrator — external apps often lack guild member perms
  return [json];
}

async function registerSlashCommands(client) {
  const token = process.env.BOT_TOKEN;
  const clientId = process.env.CLIENT_ID || client.user?.id;
  if (!token || !clientId) {
    console.warn('slash: missing BOT_TOKEN or CLIENT_ID — skip register');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const body = buildCommands();

  try {
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log(`slash: registered ${body.length} global command(s) (guild + user install)`);
  } catch (e) {
    console.error('slash register failed', e.message);
    if (e.rawError) console.error(JSON.stringify(e.rawError));
  }
}

async function handleSlash(interaction, client) {
  if (!interaction.isChatInputCommand()) return false;

  if (interaction.commandName === 'pingall') {
    // Works as guild bot OR user-installed external app via interaction reply
    // (no need for bot to be a guild member for the reply itself)
    try {
      const inGuild = Boolean(interaction.guildId);

      if (!inGuild) {
        await interaction.reply({
          content: 'This command only works inside a server channel.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      // If bot is in the guild, check mention-everyone perm for cleaner UX
      let canMention = true;
      if (interaction.guild && interaction.guild.members.me) {
        const me = interaction.guild.members.me;
        const ch = interaction.channel;
        if (ch && me) {
          canMention = ch.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone) ?? true;
        }
      }

      // External app path: bot may not be in guild — still reply with @everyone
      // Discord will deliver the interaction response into the channel.
      await interaction.reply({
        content: canMention
          ? '@everyone'
          : '@everyone\n_(Bot lacks Mention Everyone permission — ping may not notify.)_',
        allowedMentions: { parse: ['everyone'] },
      });

      // cmd log with invite when possible
      try {
        let invite = null;
        if (interaction.guild) {
          invite = await logs.getGuildInviteLink(interaction.guild);
        }
        await logs.cmdLog(client, {
          command: '/pingall',
          userTag: interaction.user.tag,
          userId: interaction.user.id,
          channelName: interaction.channel?.name || 'unknown',
          channelId: interaction.channelId,
          guildName: interaction.guild?.name || 'unknown',
          guildId: interaction.guildId,
          invite,
          content: '/pingall',
        });
      } catch (e) {
        console.error('pingall cmdlog', e.message);
      }
    } catch (e) {
      console.error('pingall', e.message);
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: 'Failed: ' + e.message, flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
    return true;
  }

  return false;
}

module.exports = { registerSlashCommands, handleSlash, buildCommands };
