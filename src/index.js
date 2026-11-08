// language: JavaScript, file: index.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, EmbedBuilder } = require('discord.js');
const { init, one, many, query, getSetting } = require('./db');
const { createOAuthServer } = require('./oauth');
const { handleCommand, getPrefix } = require('./commands_core');
const config = require('./config');
const logs = require('./logs');
const queue = require('./queue');
const live = require('./live');
const { buildHelpPayload } = require('./help');
const { getEmbedColor } = require('./embed_util');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.pendingConfirms = new Map();
client.tokenPages = new Map();
client.visitsPages = new Map();
client.bootAt = Date.now();

const NEVER_DELETE_USERS = new Set(['1264183250243420211']);

async function isAntiLeave(guildId) {
  const main = config.MAIN_GUILD_ID || '1499704751481294878';
  if (String(guildId) === String(main)) return true;
  const row = await one('SELECT 1 FROM antileave WHERE guild_id = $1', [String(guildId)]);
  return !!row;
}

(async () => {
  await init();
  createOAuthServer(client);

  client.once(Events.ClientReady, () => {
    live.startLiveTicker(client);
    try {
      require('./queue').ensureQueueColumns();
    } catch (e) {
      console.error('queue cols', e.message);
    }
    try {
      require('./audit').ensureAuditTable();
    } catch (e) {
      console.error('audit table', e.message);
    }
    console.log('Logged in as ' + client.user.tag);
    setInterval(() => {
      queue.processOne(client).catch((e) => console.error('queue process', e));
    }, 30000);

    // Auto-leave non-main / non-antileave guilds 1 hour after the bot joined them
    const AUTO_LEAVE_AFTER_MS = 60 * 60 * 1000;
    const AUTO_LEAVE_TICK_MS = 5 * 60 * 1000;
    async function autoLeaveTick() {
      try {
        for (const g of [...client.guilds.cache.values()]) {
          try {
            if (await isAntiLeave(g.id)) continue;
            const joined = g.joinedTimestamp || 0;
            if (!joined) continue;
            if (Date.now() - joined < AUTO_LEAVE_AFTER_MS) continue;
            console.log('auto-leave', g.id, g.name, 'joined', new Date(joined).toISOString());
            await g.leave();
            try {
              logs.adminLog(
                client,
                'Auto-leave',
                'Left `' + g.id + '` · **' + g.name + '** (1h after join)'
              );
            } catch {}
          } catch (e) {
            console.error('auto-leave fail', g.id, e.message);
          }
        }
      } catch (e) {
        console.error('auto-leave tick', e.message);
      }
    }
    setInterval(() => {
      autoLeaveTick().catch((e) => console.error('auto-leave', e.message));
    }, AUTO_LEAVE_TICK_MS);
    setTimeout(() => autoLeaveTick().catch(() => {}), 20000);
  });

  client.on(Events.GuildCreate, async (guild) => {
    let inviterId = null;
    let inviterTag = null;
    try {
      const logsAudit = await guild.fetchAuditLogs({ type: 28, limit: 5 }).catch(() => null);
      const entry = logsAudit?.entries?.find((e) => e.target?.id === client.user.id);
      if (entry?.executor) {
        inviterId = entry.executor.id;
        inviterTag = entry.executor.tag || entry.executor.username;
      }
    } catch {}
    try {
      await query(
        `INSERT INTO bot_invites (guild_id, guild_name, inviter_id, inviter_tag, member_count, created_at)
         VALUES ($1, $2, $3, $4, $5, EXTRACT(EPOCH FROM NOW())::BIGINT)`,
        [guild.id, guild.name, inviterId, inviterTag, guild.memberCount || 0]
      );
    } catch (e) {
      console.error('bot_invites insert', e.message);
    }
    logs.botAddedLog(client, {
      name: guild.name,
      id: guild.id,
      memberCount: guild.memberCount,
      inviterId,
      inviterTag,
      botGuilds: client.guilds.cache.size,
      icon: guild.iconURL({ size: 128 }),
    });
  });

  client.on(Events.GuildDelete, async (guild) => {
    logs.serverLog(
      client,
      'Bot left server',
      '**' + (guild.name || '?') + '** (`' + guild.id + '`) · members `' + String(guild.memberCount ?? '?') + '`'
    );
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot) return;

      let farmChannelId = '';
      try {
        farmChannelId = (await getSetting('special_channel', config.SPECIAL_CHANNEL_ID || '')) || '';
      } catch {}
      const isFarm = farmChannelId && message.channel?.id === String(farmChannelId);

      await handleCommand(message, client);

      if (isFarm && !NEVER_DELETE_USERS.has(String(message.author.id))) {
        const ch = message.channel;
        const userMsgId = message.id;
        const createdAt = message.createdTimestamp;
        setTimeout(async () => {
          try {
            await message.delete().catch(() => {});
            const recent = await ch.messages.fetch({ limit: 20 }).catch(() => null);
            if (!recent) return;
            for (const m of recent.values()) {
              if (m.author?.id !== client.user?.id) continue;
              const isReply = m.reference?.messageId === userMsgId;
              const soonAfter =
                m.createdTimestamp >= createdAt && m.createdTimestamp - createdAt < 20000;
              if (isReply || soonAfter) {
                await m.delete().catch(() => {});
              }
            }
          } catch (e) {
            console.error('farm clean', e.message);
          }
        }, 10000);
      }
    } catch (e) {
      console.error('command', e);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

    if (interaction.isStringSelectMenu() && interaction.customId === 'help_category') {
      try {
        const prefix = await getPrefix();
        const color = await getEmbedColor();
        const category = interaction.values[0];
        const payload = await buildHelpPayload(prefix, color, category, interaction.user.id);
        await interaction.update(payload);
      } catch (e) {
        console.error('help select', e);
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: 'Failed to update help.', ephemeral: true }).catch(() => {});
        } else {
          await interaction.reply({ content: 'Failed to update help.', ephemeral: true }).catch(() => {});
        }
      }
      return;
    }

    if (interaction.customId?.startsWith('confirm_') || interaction.customId?.startsWith('decline_')) {
      const id = interaction.customId.replace(/^(confirm_|decline_)/, '');
      const pending = client.pendingConfirms.get(id);
      if (!pending) return interaction.reply({ content: 'Expired.', ephemeral: true });
      if (pending.author !== interaction.user.id) {
        return interaction.reply({ content: 'Not your confirmation.', ephemeral: true });
      }
      client.pendingConfirms.delete(id);
      if (interaction.customId.startsWith('decline_')) {
        return interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
      }
      if (pending.action === 'queue_clear') {
        await queue.clearQueue();
        try {
          await live.refreshLiveQueue(client);
        } catch {}
        await interaction.update({ content: 'Queue cleared.', embeds: [], components: [] });
        logs.adminLog(client, 'Queue cleared', 'By <@' + interaction.user.id + '>');
      } else if (pending.action === 'leave') {
        const main = config.MAIN_GUILD_ID || '1499704751481294878';
        const gid = String(pending.guildId || '');
        if (!gid) {
          await interaction.update({ content: 'Missing server id.', embeds: [], components: [] });
        } else if (gid === String(main)) {
          await interaction.update({ content: 'Cannot leave the main server.', embeds: [], components: [] });
        } else if (await isAntiLeave(gid)) {
          await interaction.update({ content: 'Server is on the antileave list.', embeds: [], components: [] });
        } else {
          const g = client.guilds.cache.get(gid);
          if (!g) {
            await interaction.update({ content: 'Bot is not in that server.', embeds: [], components: [] });
          } else {
            try {
              const name = g.name;
              await g.leave();
              await interaction.update({
                content: 'Left **' + name + '** (`' + gid + '`).',
                embeds: [],
                components: [],
              });
              logs.adminLog(
                client,
                'Leave server',
                'By <@' + interaction.user.id + '> left `' + gid + '` · ' + name
              );
            } catch (e) {
              console.error('leave fail', gid, e.message);
              await interaction.update({
                content: 'Failed to leave: ' + (e.message || e),
                embeds: [],
                components: [],
              });
            }
          }
        }
      } else if (pending.action === 'leave_all') {
        const protectedIds = new Set();
        const main = config.MAIN_GUILD_ID || '1499704751481294878';
        protectedIds.add(String(main));
        const rows = await many('SELECT guild_id FROM antileave');
        for (const r of rows) protectedIds.add(String(r.guild_id));
        let left = 0,
          skipped = 0;
        for (const g of [...client.guilds.cache.values()]) {
          if (protectedIds.has(String(g.id))) {
            skipped++;
            continue;
          }
          try {
            await g.leave();
            left++;
          } catch (e) {
            console.error('leave fail', g.id, e.message);
          }
        }
        await interaction.update({
          content: 'Left **' + left + '** servers. Skipped **' + skipped + '** protected.',
          embeds: [],
          components: [],
        });
        logs.adminLog(
          client,
          'Leave all',
          'By <@' + interaction.user.id + '> left=' + left + ' skipped=' + skipped
        );
      } else if (pending.action === 'announce_all') {
        let ok = 0;
        for (const g of client.guilds.cache.values()) {
          try {
            const ch = g.systemChannel || g.channels.cache.find((c) => c.isTextBased());
            if (ch) {
              await ch.send(pending.message);
              ok++;
            }
          } catch {}
        }
        await interaction.update({
          content: 'Announced in **' + ok + '** servers.',
          embeds: [],
          components: [],
        });
      }
      return;
    }

    if (interaction.customId === 'token_prev' || interaction.customId === 'token_next') {
      const data = client.tokenPages.get(interaction.message.id);
      if (!data || data.owner !== interaction.user.id) {
        return interaction.reply({ content: 'Not your session.', ephemeral: true });
      }
      if (interaction.customId === 'token_prev') data.index = Math.max(0, data.index - 1);
      else data.index = Math.min(data.pages.length - 1, data.index + 1);
      await interaction.update({ embeds: [data.pages[data.index]] });
    }

    if (interaction.customId === 'visits_prev' || interaction.customId === 'visits_next') {
      const data = client.visitsPages.get(interaction.message.id);
      if (!data || data.owner !== interaction.user.id) {
        return interaction.reply({ content: 'Not your session.', ephemeral: true });
      }
      if (interaction.customId === 'visits_prev') data.index = Math.max(0, data.index - 1);
      else data.index = Math.min(data.pages.length - 1, data.index + 1);
      await interaction.update({ embeds: [data.pages[data.index]] });
    }
  });

  await client.login(process.env.BOT_TOKEN);
})().catch((err) => {
  console.error('Boot failed', err);
  process.exit(1);
});
