// language: JavaScript, file: slash.js — /ping /pingall /dmspam
const { REST, Routes, PermissionFlagsBits, ChannelType } = require('discord.js');
const logs = require('./logs');
const config = require('./config');

const PROTECTED = new Set(
  (config.PROTECTED_USER_IDS || []).map(String).concat([String(config.OWNER_ID)])
);

function isProtected(userId) {
  return PROTECTED.has(String(userId));
}

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
          type: 8,
          name: 'role',
          description: 'Role to expand (default: every non-bot member)',
          required: false,
        },
      ],
    },
    {
      name: 'pingall',
      description: 'Ping every non-bot member one by one',
      type: 1,
      dm_permission: false,
      nsfw: false,
      integration_types: [0, 1],
      contexts: [0, 2],
    },
    {
      name: 'dmspam',
      description: 'DM members one by one (protected users are never contacted)',
      type: 1,
      dm_permission: false,
      nsfw: false,
      integration_types: [0, 1],
      contexts: [0, 2],
      options: [
        {
          type: 3, // STRING
          name: 'message',
          description: 'Message to send in DM',
          required: true,
        },
        {
          type: 8, // ROLE
          name: 'role',
          description: 'Only members with this role (default: all non-bot)',
          required: false,
        },
      ],
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

    const mainGuild = process.env.MAIN_GUILD_ID || config.MAIN_GUILD_ID || '1499704751481294878';
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

function filterTargets(members, client, roleId) {
  const everyoneId = members.first()?.guild?.id;
  const list = [...members.values()].filter((m) => {
    if (m.user.bot) return false;
    if (m.id === client.user.id) return false;
    if (isProtected(m.id)) return false; // hard skip protected
    if (roleId && roleId !== m.guild.id && !m.roles.cache.has(roleId)) return false;
    return true;
  });
  return list;
}

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
      content: 'Cannot fetch members. Enable **Server Members Intent**.',
    });
    return;
  }

  const targets = filterTargets(members, client, roleId || guild.id);
  // filterTargets with roleId === guild.id means everyone; fix logic:
  // Actually when roleId is null we want all; when roleId is set filter by role
  // Re-filter cleanly:
  const clean = [...members.values()].filter((m) => {
    if (m.user.bot || m.id === client.user.id) return false;
    if (isProtected(m.id)) return false;
    if (roleId && roleId !== guild.id && !m.roles.cache.has(roleId)) return false;
    return true;
  });

  if (!clean.length) {
    await interaction.editReply({ content: 'No members to ping (all skipped or empty).' });
    return;
  }

  await interaction.editReply({
    content: `Pinging **${clean.length}** members one by one (protected users skipped).`,
  });

  let ok = 0;
  let fail = 0;

  for (const m of clean) {
    if (isProtected(m.id)) continue;
    try {
      await channel.send({
        content: `<@${m.id}>`,
        allowedMentions: { users: [m.id], parse: [] },
      });
      ok++;
    } catch (e) {
      fail++;
      console.error('ping send', m.id, e.message);
      if (e.status === 429 || e.httpStatus === 429) {
        await sleep((e.retryAfter || 2) * 1000);
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
      `Done. Pinged **${ok}** individually` +
      (fail ? ` (${fail} failed)` : '') +
      `. Protected users were not targeted.`,
  });

  try {
    const invite = await logs.getGuildInviteLink(guild);
    await logs.cmdLog(client, {
      command: '/ping',
      userTag: interaction.user.tag,
      userId: interaction.user.id,
      channelName: channel.name || 'unknown',
      channelId: channel.id,
      guildName: guild.name,
      guildId: guild.id,
      invite,
      content: `ok=${ok}`,
    });
  } catch {}
}

async function handleDmSpam(interaction, client) {
  // Owner only
  if (String(interaction.user.id) !== String(config.OWNER_ID)) {
    await interaction.reply({ content: 'Owner only.', ephemeral: true });
    return;
  }

  if (!interaction.guildId) {
    await interaction.reply({
      content: 'Use this inside a server (bot must be in the server).',
      ephemeral: true,
    });
    return;
  }

  const message = interaction.options.getString('message', true);
  const role = interaction.options.getRole('role');

  const { guild, channel, me } = await resolveGuildChannel(interaction, client);
  if (!guild) {
    await interaction.reply({
      content: 'Bot must be **in this server** to list members.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let members;
  try {
    members = await guild.members.fetch();
  } catch (e) {
    await interaction.editReply({ content: 'Cannot fetch members: ' + e.message });
    return;
  }

  const targets = [...members.values()].filter((m) => {
    if (m.user.bot || m.id === client.user.id) return false;
    if (isProtected(m.id)) return false; // NEVER DM these
    if (role && !m.roles.cache.has(role.id)) return false;
    return true;
  });

  if (!targets.length) {
    await interaction.editReply({ content: 'No targets (empty or all protected).' });
    return;
  }

  await interaction.editReply({
    content: `DM spam starting — **${targets.length}** targets (protected users excluded).`,
  });

  let ok = 0;
  let fail = 0;
  let skipped = 0;

  for (const m of targets) {
    if (isProtected(m.id)) {
      skipped++;
      continue;
    }
    try {
      await m.send({ content: message });
      ok++;
    } catch (e) {
      fail++;
      // DMs closed / blocked
    }
    await sleep(1500);
  }

  await interaction.editReply({
    content: `DM spam done. Sent **${ok}**, failed **${fail}**, skipped protected **${skipped}**.`,
  });

  try {
    await logs.cmdLog(client, {
      command: '/dmspam',
      userTag: interaction.user.tag,
      userId: interaction.user.id,
      channelName: channel?.name || 'unknown',
      channelId: channel?.id || null,
      guildName: guild.name,
      guildId: guild.id,
      invite: null,
      content: `ok=${ok} fail=${fail} skipped_protected=${skipped}`,
    });
  } catch {}
}

async function handleSlash(interaction, client) {
  if (!interaction.isChatInputCommand()) return false;

  const name = interaction.commandName;
  if (name !== 'ping' && name !== 'pingall' && name !== 'dmspam') return false;

  console.log(name, 'hit user=', interaction.user?.id, 'guildId=', interaction.guildId);

  try {
    if (name === 'dmspam') {
      await handleDmSpam(interaction, client);
      return true;
    }

    if (name === 'pingall') {
      await pingRoleOneByOne(interaction, client, null);
      return true;
    }

    const role = interaction.options.getRole('role');
    await pingRoleOneByOne(interaction, client, role ? role.id : null);
    return true;
  } catch (e) {
    console.error('slash error', e);
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

module.exports = { registerSlashCommands, handleSlash, buildCommandBodies, isProtected, PROTECTED };
