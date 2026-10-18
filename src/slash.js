// language: JavaScript, file: slash.js — /pingall guild + user-install (external app)
const { REST, Routes, PermissionFlagsBits } = require('discord.js');
const logs = require('./logs');

/**
 * Discord integration_types: 0 = Guild Install, 1 = User Install
 * contexts: 0 = Guild, 1 = Bot DM, 2 = Private channel
 */
function buildCommandBodies() {
  return [
    {
      name: 'pingall',
      description: 'Ping @everyone in this channel',
      type: 1,
      dm_permission: false,
      nsfw: false,
      integration_types: [0, 1],
      contexts: [0, 2],
    },
  ];
}

async function registerSlashCommands(client) {
  const token = process.env.BOT_TOKEN;
  const clientId = client.user?.id || process.env.CLIENT_ID;
  if (!token || !clientId) {
    console.warn('slash: missing token or client id — skip register');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const body = buildCommandBodies();

  try {
    const global = await rest.put(Routes.applicationCommands(clientId), { body });
    console.log(
      `slash: global registered ${Array.isArray(global) ? global.length : '?'} cmd(s)`,
      Array.isArray(global)
        ? global
            .map(
              (c) =>
                `${c.name}[it=${JSON.stringify(c.integration_types)} ctx=${JSON.stringify(c.contexts)}]`
            )
            .join(', ')
        : ''
    );

    const mainGuild = process.env.MAIN_GUILD_ID || '1499704751481294878';
    if (mainGuild) {
      try {
        const guildCmds = await rest.put(Routes.applicationGuildCommands(clientId, mainGuild), {
          body,
        });
        console.log(
          `slash: guild ${mainGuild} registered ${Array.isArray(guildCmds) ? guildCmds.length : '?'} cmd(s)`
        );
      } catch (ge) {
        console.error('slash guild register', ge.message);
        if (ge.rawError) console.error(JSON.stringify(ge.rawError));
      }
    }
  } catch (e) {
    console.error('slash global register failed', e.message);
    if (e.rawError) console.error(JSON.stringify(e.rawError));
    try {
      const fallback = body.map((c) => ({
        ...c,
        integration_types: [0],
        contexts: [0],
      }));
      await rest.put(Routes.applicationCommands(clientId), { body: fallback });
      console.warn(
        'slash: fell back to guild-install-only — enable User Install in Discord Developer Portal'
      );
    } catch (e2) {
      console.error('slash fallback failed', e2.message);
    }
  }
}

async function handleSlash(interaction, client) {
  if (!interaction.isChatInputCommand()) return false;
  if (interaction.commandName !== 'pingall') return false;

  console.log(
    'pingall hit',
    'user=',
    interaction.user?.id,
    'guildId=',
    interaction.guildId,
    'hasGuild=',
    Boolean(interaction.guild),
    'context=',
    interaction.context
  );

  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'Use `/pingall` inside a **server** channel.',
        ephemeral: true,
      });
      return true;
    }

    // Single interaction reply — works for guild install AND user install (external app)
    await interaction.reply({
      content: '@everyone',
      allowedMentions: { parse: ['everyone'] },
    });

    // Soft warning if bot is in guild but lacks Mention Everyone
    if (interaction.guild) {
      const me = interaction.guild.members.me;
      const channel = interaction.channel;
      if (me && channel?.permissionsFor) {
        const canMention = channel
          .permissionsFor(me)
          ?.has(PermissionFlagsBits.MentionEveryone);
        if (!canMention) {
          await interaction
            .followUp({
              content:
                'Message sent, but the bot role lacks **Mention Everyone** here — members may not get notified. Fix role/channel perms.',
              ephemeral: true,
            })
            .catch(() => {});
        }
      }
    }

    try {
      let invite = null;
      if (interaction.guild) invite = await logs.getGuildInviteLink(interaction.guild);
      await logs.cmdLog(client, {
        command: '/pingall',
        userTag: interaction.user.tag,
        userId: interaction.user.id,
        channelName: interaction.channel?.name || 'unknown',
        channelId: interaction.channelId,
        guildName: interaction.guild?.name || 'external',
        guildId: interaction.guildId,
        invite,
        content: '/pingall',
      });
    } catch (e) {
      console.error('pingall cmdlog', e.message);
    }
  } catch (e) {
    console.error('pingall error', e);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'Failed: ' + e.message, ephemeral: true });
      } else {
        await interaction.reply({ content: 'Failed: ' + e.message, ephemeral: true });
      }
    } catch {}
  }

  return true;
}

module.exports = { registerSlashCommands, handleSlash, buildCommandBodies };
