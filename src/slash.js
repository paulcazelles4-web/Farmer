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
      type: 1, // CHAT_INPUT
      // No default_member_permissions — must work without Administrator
      dm_permission: false,
      nsfw: false,
      integration_types: [0, 1],
      contexts: [0, 2],
    },
  ];
}

async function registerSlashCommands(client) {
  const token = process.env.BOT_TOKEN;
  // Always prefer the live application id from the gateway session
  const clientId = client.user?.id || process.env.CLIENT_ID;
  if (!token || !clientId) {
    console.warn('slash: missing token or client id — skip register');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const body = buildCommandBodies();

  try {
    // 1) Global commands (propagation up to ~1h, usually minutes)
    const global = await rest.put(Routes.applicationCommands(clientId), { body });
    console.log(
      `slash: global registered ${Array.isArray(global) ? global.length : '?'} cmd(s)`,
      Array.isArray(global)
        ? global.map((c) => `${c.name}[it=${JSON.stringify(c.integration_types)} ctx=${JSON.stringify(c.contexts)}]`).join(', ')
        : ''
    );

    // 2) Also push to main guild for instant availability while testing
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
    // Common: portal User Install not enabled → Discord rejects integration_types: [1]
    // Retry guild-only so at least in-server install works
    try {
      const fallback = body.map((c) => ({
        ...c,
        integration_types: [0],
        contexts: [0],
      }));
      await rest.put(Routes.applicationCommands(clientId), { body: fallback });
      console.warn('slash: fell back to guild-install-only registration');
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
    interaction.context,
    'authorizing=',
    interaction.authorizingIntegrationOwners
      ? JSON.stringify(interaction.authorizingIntegrationOwners)
      : 'n/a'
  );

  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'Use `/pingall` inside a **server** channel.',
        ephemeral: true,
      });
      return true;
    }

    // Path A — bot is a member of the guild: send with full mention perms if possible
    if (interaction.guild) {
      const me = interaction.guild.members.me;
      const channel = interaction.channel;

      let canMention = true;
      let canSend = true;
      if (me && channel && channel.permissionsFor) {
        const perms = channel.permissionsFor(me);
        canMention = perms?.has(PermissionFlagsBits.MentionEveryone) ?? false;
        canSend = perms?.has(PermissionFlagsBits.SendMessages) ?? false;
      }

      // Always answer the interaction first (required within 3s)
      await interaction.reply({
        content: '@everyone',
        allowedMentions: { parse: ['everyone'] },
      });

      // Backup channel send if interaction reply is muted by Discord for user-apps
      // and bot has Send + Mention in the channel
      if (canSend && canMention && channel?.isTextBased?.()) {
        try {
          await channel.send({
            content: '@everyone',
            allowedMentions: { parse: ['everyone'] },
          });
        } catch (sendErr) {
          console.error('pingall channel.send', sendErr.message);
        }
      } else if (!canMention) {
        try {
          await interaction.followUp({
            content:
              'Posted, but the bot lacks **Mention Everyone** in this channel — notifications may not fire. Give the bot role that permission.',
            ephemeral: true,
          });
        } catch {}
      }
    } else {
      // Path B — pure User Install / external app: no guild object on the client
      // Interaction response is the only reliable way to post into the channel.
      await interaction.reply({
        content: '@everyone',
        allowedMentions: { parse: ['everyone'] },
      });
    }

    // cmd log
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
