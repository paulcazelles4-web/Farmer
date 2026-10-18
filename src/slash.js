// language: JavaScript, file: slash.js — /ping & /pingall: individual mentions, never mass @everyone
const { REST, Routes, PermissionFlagsBits, ChannelType } = require('discord.js');
const logs = require('./logs');

function buildCommandBodies() {
  return [
    {
      name: 'ping',
      description: 'Ping members of a role one by one (no @everyone mass mention)',
      type: 1,
      dm_permission: false,
      nsfw: false,
      integration_types: [0, 1],
      contexts: [0, 2],
      options: [
        {
          type: 8, // ROLE
          name: 'role',
          description: 'Role to expand (default: @everyone → every non-bot member)',
          required: false,
        },
      ],
    },
    {
      name: 'pingall',
      description: 'Ping every non-bot member one by one (same as /ping with @everyone)',
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
      Array.isArray(global) ? global.map((c) => c.name).join(', ') : ''
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

/**
 * Expand a role to individual user mentions — never sends @everyone / @here.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').Client} client
 * @param {string|null} roleId - null or guild id / everyone → all non-bot members
 */
async function pingRoleOneByOne(interaction, client, roleId) {
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'Use this command inside a **server** channel.',
      ephemeral: true,
    });
    return;
  }

  const { guild, channel, me } = await resolveGuildChannel(interaction, client);

  if (!guild || !channel || !channel.isTextBased?.()) {
    await interaction.reply({
      content:
        'Bot must be **in this server** to list members and ping them one by one.\n' +
        'Add the bot to the server, then run the command again.',
      ephemeral: true,
    });
    return;
  }

  if (me) {
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.SendMessages)) {
      await interaction.reply({
        content: 'Bot cannot **Send Messages** in this channel.',
        ephemeral: true,
      });
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });

  let members;
  try {
    members = await guild.members.fetch();
  } catch (e) {
    console.error('ping members.fetch', e.message);
    await interaction.editReply({
      content:
        'Cannot fetch members. Enable **Server Members Intent** in the Developer Portal.',
    });
    return;
  }

  const everyoneId = guild.id;
  const targetRoleId = roleId || everyoneId;
  const isEveryone = targetRoleId === everyoneId;

  let targets;
  if (isEveryone) {
    targets = [...members.values()].filter((m) => !m.user.bot && m.id !== client.user.id);
  } else {
    targets = [...members.values()].filter(
      (m) => !m.user.bot && m.id !== client.user.id && m.roles.cache.has(targetRoleId)
    );
  }

  if (!targets.length) {
    await interaction.editReply({ content: 'No members to ping for that target.' });
    return;
  }

  const label = isEveryone ? '@everyone (expanded)' : `role \`${targetRoleId}\``;
  await interaction.editReply({
    content: `Pinging **${targets.length}** members one by one (${label}) — **no mass mention**.`,
  });

  let ok = 0;
  let fail = 0;

  for (const m of targets) {
    try {
      // Individual user mention only — never @everyone / @here
      await channel.send({
        content: `<@${m.id}>`,
        allowedMentions: { users: [m.id], parse: [] },
      });
      ok++;
    } catch (e) {
      fail++;
      console.error('ping send', m.id, e.message);
      if (e.status === 429 || e.httpStatus === 429) {
        const wait = (e.retryAfter || 2) * 1000;
        await sleep(wait);
        try {
          await channel.send({
            content: `<@${m.id}>`,
            allowedMentions: { users: [m.id], parse: [] },
          });
          ok++;
          fail--;
        } catch {}
      }
    }
    await sleep(1200);
  }

  await interaction.editReply({
    content:
      `Done. Pinged **${ok}** members individually` +
      (fail ? ` (${fail} failed)` : '') +
      `. No @everyone was used.`,
  });

  try {
    const invite = await logs.getGuildInviteLink(guild);
    await logs.cmdLog(client, {
      command: isEveryone ? '/ping @everyone→1by1' : `/ping role:${targetRoleId}`,
      userTag: interaction.user.tag,
      userId: interaction.user.id,
      channelName: channel.name || 'unknown',
      channelId: channel.id,
      guildName: guild.name,
      guildId: guild.id,
      invite,
      content: `ok=${ok}/${targets.length}`,
    });
  } catch {}
}

async function handleSlash(interaction, client) {
  if (!interaction.isChatInputCommand()) return false;

  const name = interaction.commandName;
  if (name !== 'ping' && name !== 'pingall') return false;

  console.log(
    name,
    'hit user=',
    interaction.user?.id,
    'guildId=',
    interaction.guildId,
    'inCache=',
    interaction.guildId ? client.guilds.cache.has(interaction.guildId) : false
  );

  try {
    if (name === 'pingall') {
      await pingRoleOneByOne(interaction, client, null);
      return true;
    }

    // /ping [role]
    const role = interaction.options.getRole('role');
    const roleId = role ? role.id : null; // null → treat as @everyone expanded
    await pingRoleOneByOne(interaction, client, roleId);
    return true;
  } catch (e) {
    console.error('ping error', e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Failed: ' + e.message }).catch(() => {});
      } else {
        await interaction.reply({ content: 'Failed: ' + e.message, ephemeral: true });
      }
    } catch {}
    return true;
  }
}

module.exports = { registerSlashCommands, handleSlash, buildCommandBodies };
