// language: JavaScript, file: slash.js — /pingall mentions each member one by one
const { REST, Routes, PermissionFlagsBits, ChannelType } = require('discord.js');
const logs = require('./logs');

function buildCommandBodies() {
  return [
    {
      name: 'pingall',
      description: 'Ping every member one by one in this channel',
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveGuildChannel(interaction, client) {
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

  let channel = interaction.channel;
  if ((!channel || !channel.isTextBased?.()) && interaction.channelId) {
    try {
      channel = await client.channels.fetch(interaction.channelId);
    } catch {
      channel = null;
    }
  }
  if ((!channel || !channel.isTextBased?.()) && guild) {
    try {
      channel = await guild.channels.fetch(interaction.channelId);
    } catch {
      channel = null;
    }
  }

  const me =
    guild?.members?.me ||
    (guild ? await guild.members.fetch(client.user.id).catch(() => null) : null);

  return { guild, channel, me };
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
    'inCache=',
    interaction.guildId ? client.guilds.cache.has(interaction.guildId) : false
  );

  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'Use `/pingall` inside a **server** channel.',
        ephemeral: true,
      });
      return true;
    }

    const { guild, channel, me } = await resolveGuildChannel(interaction, client);

    if (!guild || !channel || !channel.isTextBased?.()) {
      await interaction.reply({
        content:
          'Bot must be **in this server** to list members and ping them one by one.\n' +
          'Add the bot to the server, then run `/pingall` again.',
        ephemeral: true,
      });
      return true;
    }

    if (me) {
      const perms = channel.permissionsFor(me);
      if (!perms?.has(PermissionFlagsBits.SendMessages)) {
        await interaction.reply({
          content: 'Bot cannot **Send Messages** in this channel.',
          ephemeral: true,
        });
        return true;
      }
    }

    await interaction.deferReply({ ephemeral: true });

    // Fetch full member list (needs Guild Members intent — already enabled)
    let members;
    try {
      members = await guild.members.fetch();
    } catch (e) {
      console.error('pingall members.fetch', e.message);
      await interaction.editReply({
        content:
          'Cannot fetch members. Enable **Server Members Intent** in the Developer Portal and make sure the bot is in the server.',
      });
      return true;
    }

    const targets = [...members.values()].filter(
      (m) => !m.user.bot && m.id !== client.user.id
    );

    if (!targets.length) {
      await interaction.editReply({ content: 'No members to ping.' });
      return true;
    }

    await interaction.editReply({
      content: `Pinging **${targets.length}** members one by one…`,
    });

    let ok = 0;
    let fail = 0;

    // One mention per message — avoids mass-mention blocks; slow enough for rate limits
    for (const m of targets) {
      try {
        await channel.send({
          content: `<@${m.id}>`,
          allowedMentions: { users: [m.id] },
        });
        ok++;
      } catch (e) {
        fail++;
        console.error('pingall send', m.id, e.message);
        // If rate limited, wait and retry once
        if (e.status === 429 || e.httpStatus === 429) {
          const wait = (e.retryAfter || 2) * 1000;
          await sleep(wait);
          try {
            await channel.send({
              content: `<@${m.id}>`,
              allowedMentions: { users: [m.id] },
            });
            ok++;
            fail--;
          } catch {}
        }
      }
      // ~1.2s between messages keeps us under channel rate limits on large servers
      await sleep(1200);
    }

    await interaction.editReply({
      content: `Done. Pinged **${ok}** members one by one.` + (fail ? ` (${fail} failed)` : ''),
    });

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
        content: `/pingall → ${ok}/${targets.length}`,
      });
    } catch {}
  } catch (e) {
    console.error('pingall error', e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Failed: ' + e.message }).catch(() => {});
      } else {
        await interaction.reply({ content: 'Failed: ' + e.message, ephemeral: true });
      }
    } catch {}
  }

  return true;
}

module.exports = { registerSlashCommands, handleSlash, buildCommandBodies };
