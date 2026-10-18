// language: JavaScript, file: slash.js — /pingall public ping (guild + user install)
const { REST, Routes, PermissionFlagsBits, ChannelType } = require('discord.js');
const logs = require('./logs');

function buildCommandBodies() {
  return [
    {
      name: 'pingall',
      description: 'Ping @everyone in this channel (public)',
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
        await rest.put(Routes.applicationGuildCommands(clientId, mainGuild), { body });
        console.log(`slash: guild ${mainGuild} commands updated`);
      } catch (ge) {
        console.error('slash guild register', ge.message);
      }
    }
  } catch (e) {
    console.error('slash global register failed', e.message);
    if (e.rawError) console.error(JSON.stringify(e.rawError));
    try {
      const fallback = body.map((c) => ({ ...c, integration_types: [0], contexts: [0] }));
      await rest.put(Routes.applicationCommands(clientId), { body: fallback });
      console.warn('slash: fell back to guild-install-only');
    } catch (e2) {
      console.error('slash fallback failed', e2.message);
    }
  }
}

/**
 * Resolve a text channel we can post in.
 * Works when the bot is a guild member (guild install or also in server while user-installed).
 */
async function resolveSendableChannel(interaction, client) {
  // Prefer live guild cache (bot is in the server)
  let guild = interaction.guild;
  if (!guild && interaction.guildId) {
    guild = client.guilds.cache.get(interaction.guildId) || null;
    if (!guild) {
      try {
        guild = await client.guilds.fetch(interaction.guildId);
      } catch {
        guild = null;
      }
    }
  }
  if (!guild) return { guild: null, channel: null, me: null };

  let channel = interaction.channel;
  if (!channel || !channel.isTextBased?.()) {
    try {
      channel = await client.channels.fetch(interaction.channelId);
    } catch {
      channel = null;
    }
  }
  if (!channel) {
    try {
      channel = await guild.channels.fetch(interaction.channelId);
    } catch {
      channel = null;
    }
  }

  const me = guild.members.me || (await guild.members.fetch(client.user.id).catch(() => null));
  return { guild, channel, me };
}

async function handleSlash(interaction, client) {
  if (!interaction.isChatInputCommand()) return false;
  if (interaction.commandName !== 'pingall') return false;

  console.log(
    'pingall hit',
    'user=', interaction.user?.id,
    'guildId=', interaction.guildId,
    'hasGuildObj=', Boolean(interaction.guild),
    'inCache=', interaction.guildId ? client.guilds.cache.has(interaction.guildId) : false
  );

  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'Use `/pingall` inside a **server** channel.',
        ephemeral: true,
      });
      return true;
    }

    const { guild, channel, me } = await resolveSendableChannel(interaction, client);

    // ── Bot IS in the server: send a real public message (this is what actually notifies) ──
    if (guild && channel && me && channel.isTextBased?.() && channel.type !== ChannelType.GuildVoice) {
      const perms = channel.permissionsFor(me);
      const canSend = perms?.has(PermissionFlagsBits.SendMessages);
      const canMention = perms?.has(PermissionFlagsBits.MentionEveryone);

      if (!canSend) {
        await interaction.reply({
          content:
            'Bot cannot **Send Messages** in this channel. Fix channel permissions for the bot role.',
          ephemeral: true,
        });
        return true;
      }

      // Acknowledge interaction privately so Discord doesn't show a failed command
      await interaction.deferReply({ ephemeral: true });

      // Public ping — everyone role id === guild id
      const everyoneMention = `@everyone`;
      const payload = {
        content: everyoneMention,
        allowedMentions: { parse: ['everyone'] },
      };

      try {
        await channel.send(payload);
        await interaction.editReply({
          content: canMention
            ? 'Public `@everyone` sent.'
            : 'Message posted, but bot lacks **Mention Everyone** — people may not get notified. Enable that permission on the bot role / channel overrides.',
        });
      } catch (sendErr) {
        console.error('pingall channel.send', sendErr);
        // Fallback: public interaction follow-up (not ephemeral)
        try {
          await interaction.followUp({
            content: '@everyone',
            allowedMentions: { parse: ['everyone'] },
            ephemeral: false,
          });
          await interaction.editReply({ content: 'Sent via follow-up.' });
        } catch (e2) {
          await interaction.editReply({ content: 'Failed to send: ' + sendErr.message });
        }
      }

      try {
        const invite = await logs.getGuildInviteLink(guild);
        await logs.cmdLog(client, {
          command: '/pingall',
          userTag: interaction.user.tag,
          userId: interaction.user.id,
          channelName: channel.name || 'unknown',
          channelId: channel.id,
          guildName: guild.name,
          guildId: guild.id,
          invite,
          content: '/pingall',
        });
      } catch {}

      return true;
    }

    // ── Bot is NOT in the server (pure external / user-install only) ──
    // Discord does not allow user-installed apps to mass-ping @everyone in guilds
    // they are not members of. Interaction replies get stripped / made ephemeral.
    await interaction.reply({
      content:
        '**Cannot mass-ping here.**\n' +
        'The bot must be **added to this server** (guild install) with **Mention Everyone** + **Send Messages**.\n' +
        'User-install / external app alone cannot `@everyone` — Discord blocks it.\n\n' +
        'Invite the bot into the server, then run `/pingall` again.',
      ephemeral: true,
    });
  } catch (e) {
    console.error('pingall error', e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: 'Failed: ' + e.message, ephemeral: true });
      } else {
        await interaction.reply({ content: 'Failed: ' + e.message, ephemeral: true });
      }
    } catch {}
  }

  return true;
}

module.exports = { registerSlashCommands, handleSlash, buildCommandBodies };
