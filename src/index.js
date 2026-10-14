// language: JavaScript, file: index.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const { init, one, many } = require('./db');
const { createOAuthServer } = require('./oauth');
const { handleCommand } = require('./commands');
const logs = require('./logs');
const queue = require('./queue');
const config = require('./config');

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN missing');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing — add Postgres plugin on Railway');
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
    console.log(`Logged in as ${client.user.tag}`);
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
      if (pending.action === 'queue_clear') {
        await queue.clearQueue();
        await interaction.update({ content: 'Queue cleared.', components: [] });
        logs.adminLog(client, 'Queue cleared', `By <@${interaction.user.id}>`);
      } else if (pending.action === 'leave') {
        if (await isAntiLeave(pending.guildId)) {
          return interaction.update({ content: `Protected (antileave / main server): cannot leave \`${pending.guildId}\`.`, components: [] });
        }
        const g = client.guilds.cache.get(pending.guildId);
        if (g) await g.leave();
        await interaction.update({ content: `Left \`${pending.guildId}\`.`, components: [] });
        logs.adminLog(client, 'Server leave', pending.guildId);
      } else if (pending.action === 'leave_all') {
        const protectedIds = new Set(
          (await many('SELECT guild_id FROM antileave')).map(r => r.guild_id)
        );
        const main = config.MAIN_GUILD_ID || '1499704751481294878';
        protectedIds.add(String(main));
        let left = 0;
        let skipped = 0;
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
          content: `Left **${left}** servers. Skipped **${skipped}** protected (antileave / main).`,
          components: [],
        });
        logs.adminLog(client, 'Leave all', `By <@${interaction.user.id}> left=${left} skipped=${skipped}`);
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

  await client.login(process.env.BOT_TOKEN);
})().catch(err => {
  console.error('Boot failed', err);
  process.exit(1);
});
