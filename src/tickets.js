// language: JavaScript, file: tickets.js — automated support tickets + AI replies
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const { query, one, many, getSetting, setSetting } = require('./db');
const { getEmbedColor } = require('./embed_util');
const config = require('./config');
const perms = require('./permissions');

const AI_COOLDOWN_MS = 4000;
const lastAiReply = new Map(); // channelId -> ts

function aiConfigured() {
  return !!(process.env.AI_API_KEY || process.env.XAI_API_KEY || process.env.OPENAI_API_KEY);
}

function aiKey() {
  return process.env.AI_API_KEY || process.env.XAI_API_KEY || process.env.OPENAI_API_KEY || '';
}

function aiBase() {
  return (
    process.env.AI_BASE_URL ||
    process.env.XAI_BASE_URL ||
    'https://api.x.ai/v1'
  ).replace(/\/$/, '');
}

function aiModel() {
  return process.env.AI_MODEL || process.env.XAI_MODEL || 'grok-2-latest';
}

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      channel_id TEXT UNIQUE NOT NULL,
      guild_id TEXT NOT NULL,
      opener_id TEXT NOT NULL,
      opener_tag TEXT,
      status TEXT DEFAULT 'open',
      claimed_by TEXT,
      ai_enabled INTEGER DEFAULT 1,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT),
      closed_at BIGINT
    )
  `).catch(() => {});
}

async function isTicketChannel(channelId) {
  const row = await one(`SELECT * FROM tickets WHERE channel_id = $1 AND status = 'open'`, [
    String(channelId),
  ]);
  return row || null;
}

async function buildPanelEmbed() {
  const color = await getEmbedColor();
  return new EmbedBuilder()
    .setTitle('🎫 Support Tickets')
    .setColor(color)
    .setDescription(
      'Need help with **Member Farm**?\n\n' +
        'Click **Open Ticket** below.\n' +
        'An AI assistant will answer first. Staff can take over anytime.\n\n' +
        '_One open ticket per user._'
    )
    .setFooter({ text: 'Member Farm · Tickets' })
    .setTimestamp();
}

function panelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_open')
      .setLabel('Open Ticket')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎫')
  );
}

function ticketControlRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel('Claim (human)')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_ai_on')
      .setLabel('AI On')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('ticket_ai_off')
      .setLabel('AI Off')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
  );
}

async function postPanel(channel) {
  await ensureTables();
  const embed = await buildPanelEmbed();
  return channel.send({ embeds: [embed], components: [panelRow()] });
}

async function openTicket(interaction) {
  await ensureTables();
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: 'Guild only.', ephemeral: true });
  }

  const existing = await one(
    `SELECT channel_id FROM tickets WHERE opener_id = $1 AND guild_id = $2 AND status = 'open'`,
    [interaction.user.id, guild.id]
  );
  if (existing) {
    return interaction.reply({
      content: 'You already have an open ticket: <#' + existing.channel_id + '>',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const catId = await getSetting('ticket_category', '');
  let parent = catId || null;
  if (parent) {
    const ch = await guild.channels.fetch(parent).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildCategory) parent = null;
  }

  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  // Staff role optional
  const staffRole = await getSetting('ticket_staff_role', '');
  if (staffRole) {
    overwrites.push({
      id: staffRole,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  const safeName = ('ticket-' + interaction.user.username)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 90);

  let channel;
  try {
    channel = await guild.channels.create({
      name: safeName || 'ticket',
      type: ChannelType.GuildText,
      parent: parent || undefined,
      permissionOverwrites: overwrites,
      topic: 'Ticket for ' + interaction.user.id,
    });
  } catch (e) {
    return interaction.editReply('Failed to create channel: ' + (e.message || e));
  }

  await query(
    `INSERT INTO tickets (channel_id, guild_id, opener_id, opener_tag, status, ai_enabled)
     VALUES ($1, $2, $3, $4, 'open', 1)`,
    [channel.id, guild.id, interaction.user.id, interaction.user.tag || interaction.user.username]
  );

  const color = await getEmbedColor();
  const welcome = new EmbedBuilder()
    .setTitle('Ticket opened')
    .setColor(color)
    .setDescription(
      'Hey <@' +
        interaction.user.id +
        '> — describe your issue.\n\n' +
        (aiConfigured()
          ? '🤖 **AI assistant is active** and will reply automatically.\nStaff can **Claim** to take over or toggle AI.'
          : '⚠️ AI is not configured (`AI_API_KEY` missing). Staff will answer manually.')
    )
    .addFields(
      { name: 'Opener', value: '<@' + interaction.user.id + '>', inline: true },
      { name: 'ID', value: '`' + interaction.user.id + '`', inline: true }
    )
    .setFooter({ text: 'Member Farm · Tickets' })
    .setTimestamp();

  await channel.send({
    content: '<@' + interaction.user.id + '>',
    embeds: [welcome],
    components: [ticketControlRow()],
  });

  await interaction.editReply('Ticket created: <#' + channel.id + '>');
}

async function closeTicket(channel, closerId) {
  const row = await isTicketChannel(channel.id);
  if (!row) return { ok: false, error: 'Not a ticket channel.' };

  await query(
    `UPDATE tickets SET status = 'closed', closed_at = $1 WHERE channel_id = $2`,
    [Math.floor(Date.now() / 1000), channel.id]
  );

  try {
    await channel.send('Ticket closed by <@' + closerId + '>. Channel deletes in 5s.');
  } catch {}

  setTimeout(() => {
    channel.delete('Ticket closed').catch(() => {});
  }, 5000);

  return { ok: true };
}

async function claimTicket(channelId, staffId) {
  await query(`UPDATE tickets SET claimed_by = $1, ai_enabled = 0 WHERE channel_id = $2 AND status = 'open'`, [
    String(staffId),
    String(channelId),
  ]);
}

async function setTicketAi(channelId, on) {
  await query(`UPDATE tickets SET ai_enabled = $1 WHERE channel_id = $2 AND status = 'open'`, [
    on ? 1 : 0,
    String(channelId),
  ]);
}

async function callAI(messages) {
  const key = aiKey();
  if (!key) return null;

  const system =
    process.env.AI_TICKET_SYSTEM ||
    'You are the support assistant for Member Farm, a Discord member-farming bot. ' +
      'Be concise, clear, and helpful. Explain commands like ?join, ?verify, ?stock, OAuth, queue. ' +
      'Never invent server IDs or tokens. If you need staff, say so. Reply in the same language as the user.';

  const body = {
    model: aiModel(),
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: 0.5,
    max_tokens: 600,
  };

  const res = await fetch(aiBase() + '/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('AI ticket error', res.status, t.slice(0, 300));
    return null;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  return text ? String(text).slice(0, 1900) : null;
}

async function handleTicketMessage(message, client) {
  if (message.author.bot) return false;
  if (!message.guild) return false;

  const ticket = await isTicketChannel(message.channel.id);
  if (!ticket) return false;

  // Staff messages: no AI auto-reply
  if (ticket.claimed_by && String(message.author.id) === String(ticket.claimed_by)) return true;
  if (perms.isOwner(message.author.id)) return true;

  if (!ticket.ai_enabled) return true;
  if (!aiConfigured()) return true;

  // Only reply to the opener (and optionally anyone in channel)
  const onlyOpener = (await getSetting('ticket_ai_opener_only', '1')) === '1';
  if (onlyOpener && String(message.author.id) !== String(ticket.opener_id)) return true;

  const now = Date.now();
  const last = lastAiReply.get(message.channel.id) || 0;
  if (now - last < AI_COOLDOWN_MS) return true;
  lastAiReply.set(message.channel.id, now);

  // Build short history
  let history = [];
  try {
    const fetched = await message.channel.messages.fetch({ limit: 12 });
    const ordered = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const m of ordered) {
      if (!m.content) continue;
      if (m.author.id === client.user.id) {
        history.push({ role: 'assistant', content: m.content.slice(0, 800) });
      } else {
        history.push({
          role: 'user',
          content: (m.author.username + ': ' + m.content).slice(0, 800),
        });
      }
    }
  } catch {
    history = [{ role: 'user', content: message.content.slice(0, 800) }];
  }

  // Keep last 8 turns
  history = history.slice(-8);

  await message.channel.sendTyping().catch(() => {});
  const reply = await callAI(history).catch((e) => {
    console.error('callAI', e.message);
    return null;
  });

  if (reply) {
    await message.reply({ content: reply }).catch(async () => {
      await message.channel.send(reply).catch(() => {});
    });
  }
  return true;
}

async function handleTicketInteraction(interaction) {
  const id = interaction.customId;
  if (!id || !id.startsWith('ticket_')) return false;

  if (id === 'ticket_open') {
    await openTicket(interaction);
    return true;
  }

  if (id === 'ticket_close') {
    const ticket = await isTicketChannel(interaction.channel.id);
    if (!ticket) {
      await interaction.reply({ content: 'Not a ticket.', ephemeral: true });
      return true;
    }
    const isStaff =
      perms.isOwner(interaction.user.id) ||
      (await perms.canUse(interaction.user.id, 'ticket')) ||
      String(interaction.user.id) === String(ticket.opener_id);
    if (!isStaff) {
      await interaction.reply({ content: 'No permission.', ephemeral: true });
      return true;
    }
    await interaction.reply('Closing…');
    await closeTicket(interaction.channel, interaction.user.id);
    return true;
  }

  if (id === 'ticket_claim') {
    if (!perms.isOwner(interaction.user.id) && !(await perms.canUse(interaction.user.id, 'ticket'))) {
      await interaction.reply({ content: 'No permission.', ephemeral: true });
      return true;
    }
    await claimTicket(interaction.channel.id, interaction.user.id);
    await interaction.reply('Claimed by <@' + interaction.user.id + '>. AI paused.');
    return true;
  }

  if (id === 'ticket_ai_on' || id === 'ticket_ai_off') {
    if (!perms.isOwner(interaction.user.id) && !(await perms.canUse(interaction.user.id, 'ticket'))) {
      await interaction.reply({ content: 'No permission.', ephemeral: true });
      return true;
    }
    const on = id === 'ticket_ai_on';
    await setTicketAi(interaction.channel.id, on);
    await interaction.reply(on ? 'AI enabled for this ticket.' : 'AI disabled for this ticket.');
    return true;
  }

  return false;
}

async function handleTicketCommand(message, args, client) {
  const sub = (args[0] || '').toLowerCase();
  const prefix = (await getSetting('prefix', '?')) || '?';

  if (!(await perms.canUse(message.author.id, 'ticket')) && !perms.isOwner(message.author.id)) {
    if (!['close'].includes(sub)) {
      return message.reply('No permission for ticket admin commands.');
    }
  }

  if (sub === 'panel') {
    await postPanel(message.channel);
    return message.reply('Panel posted.');
  }

  if (sub === 'category' && message.mentions.channels.first()) {
    const ch = message.mentions.channels.first();
    await setSetting('ticket_category', ch.id);
    return message.reply('Ticket category set to **' + ch.name + '** (`' + ch.id + '`).');
  }

  if (sub === 'staff' && message.mentions.roles.first()) {
    const role = message.mentions.roles.first();
    await setSetting('ticket_staff_role', role.id);
    return message.reply('Ticket staff role set to ' + role.toString());
  }

  if (sub === 'close') {
    const r = await closeTicket(message.channel, message.author.id);
    if (!r.ok) return message.reply(r.error);
    return;
  }

  if (sub === 'status') {
    const open = await many(`SELECT * FROM tickets WHERE status = 'open' ORDER BY id DESC LIMIT 20`);
    const lines = open.length
      ? open.map((t) => '• <#' + t.channel_id + '> — <@' + t.opener_id + '> AI:' + (t.ai_enabled ? 'on' : 'off')).join('\n')
      : 'No open tickets.';
    return message.reply({ embeds: [new EmbedBuilder().setTitle('Open Tickets').setDescription(lines).setTimestamp()] });
  }

  return message.reply(
    'Usage:\n' +
      '`' + prefix + 'ticket panel` — post open button\n' +
      '`' + prefix + 'ticket category #category` — parent category\n' +
      '`' + prefix + 'ticket staff @role` — staff role access\n' +
      '`' + prefix + 'ticket close` — close this ticket\n' +
      '`' + prefix + 'ticket status` — list open tickets\n\n' +
      'Env: `AI_API_KEY` (or `XAI_API_KEY`), optional `AI_BASE_URL`, `AI_MODEL`'
  );
}

module.exports = {
  ensureTables,
  postPanel,
  handleTicketMessage,
  handleTicketInteraction,
  handleTicketCommand,
  aiConfigured,
};
