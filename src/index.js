// language: JavaScript, file: index.js, target: Node 20+, discord.js 14
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createOAuthServer } = require('./oauth');
const { handleCommand } = require('./commands');
const { db, setSetting, getSetting } = require('./db');
const logs = require('./logs');
const queue = require('./queue');
const config = require('./config');

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN missing');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

client.pendingConfirms = new Map();
client.tokenPages = new Map();

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  createOAuthServer(client);

  // queue processor every 30s
  setInterval(() => {
    queue.processOne(client).catch(e => console.error('queue process', e));
  }, 30000);
});

client.on(Events.GuildCreate, async (guild) => {
  logs.serverLog(client, 'Bot added', `Joined **${guild.name}** (\`${guild.id}\`) — ${guild.memberCount} members`);
});

client.on(Events.GuildDelete, async (guild) => {
  logs.serverLog(client, 'Bot removed', `Left **${guild.name || 'unknown'}** (\`${guild.id}\`)`, 0xed4245);
});

client.on(Events.MessageCreate, async (message) => {
  await handleCommand(message, client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  // confirm / decline
  if (interaction.customId.startsWith('confirm_') || interaction.customId.startsWith('decline_')) {
    const id = interaction.customId.replace(/^(confirm_|decline_)/, '');
    const pending = client.pendingConfirms.get(id);
    if (!pending || pending.author !== interaction.user.id) {
      return interaction.reply({ content: 'Not your confirmation.', ephemeral: true });
    }
    client.pendingConfirms.delete(id);
    if (interaction.customId.startsWith('decline_')) {
      return interaction.update({ content: 'Cancelled.', components: [] });
    }
    // confirm actions
    if (pending.action === 'queue_clear') {
      queue.clearQueue();
      await interaction.update({ content: 'Queue cleared.', components: [] });
      logs.adminLog(client, 'Queue cleared', `By <@${interaction.user.id}>`);
    } else if (pending.action === 'leave') {
      const g = client.guilds.cache.get(pending.guildId);
      if (g) await g.leave();
      await interaction.update({ content: `Left ${pending.guildId}`, components: [] });
      logs.adminLog(client, 'Server leave', pending.guildId);
    } else if (pending.action === 'announce_all') {
      let ok = 0;
      for (const g of client.guilds.cache.values()) {
        try {
          const ch = g.systemChannel || g.channels.cache.find(c => c.isTextBased());
          if (ch) { await ch.send(pending.message); ok++; }
        } catch {}
      }
      await interaction.update({ content: `Announced to ${ok} servers.`, components: [] });
      logs.adminLog(client, 'Announce all', `By <@${interaction.user.id}> → ${ok} guilds`);
    }
    return;
  }

  // token pagination
  if (interaction.customId === 'token_prev' || interaction.customId === 'token_next') {
    const data = client.tokenPages.get(interaction.message.id);
    if (!data || data.owner !== interaction.user.id) {
      return interaction.reply({ content: 'Not your session.', ephemeral: true });
    }
    if (interaction.customId === 'token_prev') data.index = Math.max(0, data.index - 1);
    else data.index = Math.min(data.pages.length - 1, data.index + 1);
    await interaction.update({ embeds: [data.pages[data.index]] });
  }
});

client.login(process.env.BOT_TOKEN);
