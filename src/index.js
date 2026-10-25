// language: JavaScript, file: index.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, EmbedBuilder } = require('discord.js');
const { init, one, many, query, getSetting } = require('./db');
const { createOAuthServer, dedupeAllTokens } = require('./oauth');
const { handleCommand } = require('./commands');
const logs = require('./logs');
const queue = require('./queue');
const live = require('./live');
const apply = require('./apply');
const config = require('./config');
const perms = require('./permissions');

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN missing');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing — set a Postgres connection string in env vars');
  process.exit(1);
}

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

async function isAntiLeave(guildId) {
  const main = config.MAIN_GUILD_ID || '1499704751481294878';
  if (String(guildId) === String(main)) return true;
  const row = await one('SELECT 1 FROM antileave WHERE guild_id = $1', [String(guildId)]);
  return !!row;
}

(async () => {
  await init();
  try {
    const r = await dedupeAllTokens();
    if (r.dropped) console.log('Startup dedupe: dropped ' + r.dropped + ' duplicate tokens');
  } catch (e) {
    console.error('dedupeAllTokens', e.message);
  }
  createOAuthServer(client);

  client.once(Events.ClientReady, () => {
    live.startLiveTicker(client);
    console.log('Logged in as ' + client.user.tag);
    setInterval(() => {
      queue.processOne(client).catch((e) => console.error('queue process', e));
    }, 30000);
  });

  client.on(Events.GuildCreate, async (guild) => {
    let inviterId = null;
    let inviterTag = null;
    try {
      const logsAudit = await guild.fetchAuditLogs({ type: 28, limit: 5 }).catch(() => null);
      const entry = logsAudit?.entries?.find(
        (e) => e.target?.id === client.user.id && Date.now() - e.createdTimestamp < 15000
      );
      if (entry?.executor) {
        inviterId = entry.executor.id;
        inviterTag = entry.executor.tag || entry.executor.username;
      }
    } catch (e) {
      console.error('audit log', e.message);
    }
    logs.serverLog(client, {
      type: 'join',
      guildName: guild.name,
      guildId: guild.id,
      memberCount: guild.memberCount,
      inviterTag,
      inviterId,
    });
  });

  client.on(Events.GuildDelete, async (guild) => {
    logs.serverLog(client, {
      type: 'leave',
      guildName: guild.name,
      guildId: guild.id,
      memberCount: guild.memberCount,
    });
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleCommand(message, client);
    } catch (e) {
      console.error('command', e);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

    if (interaction.customId?.startsWith('confirm_') || interaction.customId?.startsWith('decline_')) {
      const id = interaction.customId.replace(/^(confirm_|decline_)/, '');
      const pending = client.pendingConfirms.get(id);
      if (!pending) return interaction.reply({ content: 'Expired.', ephemeral: true });
      if (pending.author !== interaction.user.id) {
        return interaction.reply({ content: 'Not your confirmation.', ephemeral: true });
      }
      client.pendingConfirms.delete(id);
      if (interaction.customId.startsWith('decline_')) {
        return interaction.update({ content: 'Cancelled.', components: [] });
      }
      if (pending.action === 'queue_clear') {
        await queue.clearQueue();
        try { await live.refreshLiveQueue(client); } catch {}
        await interaction.update({ content: 'Queue cleared.', components: [] });
        logs.adminLog(client, 'Queue cleared', 'By <@' + interaction.user.id + '>');
      } else if (pending.action === 'leave_all') {
        const protectedIds = new Set();
        const main = config.MAIN_GUILD_ID || '1499704751481294878';
        protectedIds.add(String(main));
        const rows = await many('SELECT guild_id FROM antileave');
        for (const r of rows) protectedIds.add(String(r.guild_id));
        let left = 0, skipped = 0;
        for (const g of [...client.guilds.cache.values()]) {
          if (protectedIds.has(String(g.id))) { skipped++; continue; }
          try { await g.leave(); left++; } catch (e) { console.error('leave fail', g.id, e.message); }
        }
        await interaction.update({
          content: 'Left **' + left + '** servers. Skipped **' + skipped + '** protected.',
          components: [],
        });
        logs.adminLog(client, 'Leave all', 'By <@' + interaction.user.id + '> left=' + left + ' skipped=' + skipped);
      } else if (pending.action === 'announce_all') {
        let ok = 0;
        for (const g of client.guilds.cache.values()) {
          try {
            const ch = g.systemChannel || g.channels.cache.find((c) => c.isTextBased());
            if (ch) { await ch.send(pending.message); ok++; }
          } catch {}
        }
        await interaction.update({ content: 'Announced to ' + ok + ' servers.', components: [] });
        logs.adminLog(client, 'Announce all', 'By <@' + interaction.user.id + '> → ' + ok + ' guilds');
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
