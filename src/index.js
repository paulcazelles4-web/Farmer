// language: JavaScript, file: index.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, EmbedBuilder } = require('discord.js');
const { init, one, many, query, getSetting } = require('./db');
const { createOAuthServer } = require('./oauth');
const { handleCommand } = require('./commands');
const logs = require('./logs');
const queue = require('./queue');
const apply = require('./apply');
const config = require('./config');
const perms = require('./permissions');

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
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.pendingConfirms = new Map();
client.tokenPages = new Map();
client.bootAt = Date.now();

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
    let inviterId = null;
    let inviterTag = null;
    try {
      const logsAudit = await guild.fetchAuditLogs({ type: 28, limit: 5 }).catch(() => null);
      const entry = logsAudit?.entries?.find(
        e => e.target?.id === client.user.id && Date.now() - e.createdTimestamp < 15000
      );
      if (entry?.executor) {
        inviterId = entry.executor.id;
        inviterTag = entry.executor.tag || entry.executor.username;
      }
    } catch (e) {
      console.error('audit log', e.message);
    }

    await query(
      `INSERT INTO bot_invites (guild_id, guild_name, inviter_id, inviter_tag, member_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [guild.id, guild.name, inviterId, inviterTag, guild.memberCount]
    ).catch(e => console.error('bot_invites insert', e.message));

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
    logs.serverLog(client, 'Bot removed', `Left **${guild.name || 'unknown'}** (\`${guild.id}\`)`, 0xed4245);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author && !message.author.bot) {
      const bl = await one('SELECT reason FROM user_blacklist WHERE user_id = $1', [message.author.id]);
      if (bl) {
        const prefix = (await getSetting('prefix', config.DEFAULT_PREFIX)) || config.DEFAULT_PREFIX;
        if (message.content.startsWith(prefix)) {
          if (String(message.author.id) !== String(config.OWNER_ID)) return;
        }
      }
    }
    try {
      if (await apply.handleApplyMessage(message, client)) return;
    } catch (e) {
      console.error('apply message', e.message);
    }
    try {
      const prefix = (await getSetting('prefix', config.DEFAULT_PREFIX)) || config.DEFAULT_PREFIX;
      if (message.content.startsWith(prefix)) {
        const rest = message.content.slice(prefix.length).trim();
        const cmd0 = (rest.split(/\s+/)[0] || '').toLowerCase();
        if (cmd0 === 'apply') {
          const args = rest.split(/\s+/).slice(1);
          await apply.handleApplyCommand(message, args, client, perms);
          return;
        }
      }
    } catch (e) {
      console.error('apply cmd', e.message);
    }
    await handleCommand(message, client);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isModalSubmit() && (await apply.handleApplyModal(interaction, client))) return;
    } catch (e) {
      console.error('apply modal', e.message);
    }

    try {
      if (interaction.isStringSelectMenu() && interaction.customId === 'help_category') {
        const { buildHelpPayload } = require('./help');
        const { getEmbedColor } = require('./embed_util');
        const prefix = (await getSetting('prefix', config.DEFAULT_PREFIX)) || config.DEFAULT_PREFIX;
        const color = await getEmbedColor();
        const cat = interaction.values[0] || 'core';
        await interaction.update(buildHelpPayload(prefix, color, cat));
        return;
      }
    } catch (e) {
      console.error('help select', e.message);
    }

    if (!interaction.isButton()) return;

    try {
      if (await apply.handleApplyButton(interaction, client)) return;
    } catch (e) {
      console.error('apply button', e.message);
    }

    if (interaction.customId === 'panel_stock') {
      const count = (await one(
        'SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1'
      ))?.c || 0;
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('Stock').setColor(0x5865f2)
          .addFields({ name: 'Available', value: '`' + count + '`', inline: true })
          .setFooter({ text: 'Member Farm' }).setTimestamp()],
        ephemeral: true,
      });
    }
    if (interaction.customId === 'panel_status') {
      const uptimeMs = client.uptime || 0;
      const h = Math.floor(uptimeMs / 3600000);
      const m = Math.floor((uptimeMs % 3600000) / 60000);
      const stock = (await one(
        'SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1'
      ))?.c || 0;
      const tokens = (await one('SELECT COUNT(*)::int AS c FROM tokens WHERE valid = 1'))?.c || 0;
      const qC = await one(`SELECT COUNT(*)::int AS c FROM queue WHERE status = 'pending'`);
      const paused = await queue.isPaused();
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('Status').setColor(0x57f287).addFields(
          { name: 'Uptime', value: '`' + h + 'h ' + m + 'm`', inline: true },
          { name: 'Ping', value: '`' + Math.round(client.ws.ping) + 'ms`', inline: true },
          { name: 'Guilds', value: '`' + client.guilds.cache.size + '`', inline: true },
          { name: 'Auths', value: '`' + tokens + '`', inline: true },
          { name: 'Stock', value: '`' + stock + '`', inline: true },
          { name: 'Queue', value: '`' + (qC?.c || 0) + '`' + (paused ? ' PAUSED' : ''), inline: true }
        ).setFooter({ text: 'Member Farm' }).setTimestamp()],
        ephemeral: true,
      });
    }

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
          return interaction.update({ content: `Protected: cannot leave \`${pending.guildId}\`.`, components: [] });
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
        let left = 0, skipped = 0;
        for (const g of [...client.guilds.cache.values()]) {
          if (protectedIds.has(String(g.id))) { skipped++; continue; }
          try { await g.leave(); left++; } catch (e) { console.error('leave fail', g.id, e.message); }
        }
        await interaction.update({
          content: `Left **${left}** servers. Skipped **${skipped}** protected.`,
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
