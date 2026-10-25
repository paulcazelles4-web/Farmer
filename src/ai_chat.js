// language: JavaScript, file: ai_chat.js — general AI Q&A + staff escalation channel
const { EmbedBuilder } = require('discord.js');
const { getSetting, setSetting } = require('./db');
const { getEmbedColor } = require('./embed_util');
const { getPrompt } = require('./server_prompt');
const perms = require('./permissions');
const logs = require('./logs');

const AICHANNEL_KEY = 'ai_staff_channel';
const COOLDOWN_MS = 3500;
const lastCall = new Map();

function aiKey() {
  return (
    process.env.AI_API_KEY ||
    process.env.XAI_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ''
  );
}

function aiBase() {
  return (
    process.env.AI_BASE_URL ||
    process.env.GROQ_BASE_URL ||
    process.env.XAI_BASE_URL ||
    'https://api.groq.com/openai/v1'
  ).replace(/\/$/, '');
}

function aiModel() {
  return process.env.AI_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
}

function aiConfigured() {
  return !!aiKey();
}

const BASE_BEHAVIOR = `You are a professional assistant for the Discord server Payout Central.

Tone: formal, restrained, never cheerful, no emojis, no hype, no "happy to help".
Language: answer in the same language as the user (French or English).

You may answer ANY question — general knowledge, technical, practical, or related to this server. You are not limited to server topics.

Server context (use when relevant, do not force it into unrelated answers):
- Payout Central offers two equal services: (1) custom Discord bot development, (2) member growth via Member Farm.
- Custom bots: request → staff review → possible build → delivery. No guaranteed acceptance or timeline from you.
- Member Farm: OAuth verify, managed stock, queue, ?join in the farm channel. Admin ops are staff-only. Never invent stock numbers or expose tokens.

When you need a human staff member (account issues, payments, acceptance decisions, live stock/queue ops, disputes, anything you cannot responsibly resolve):
1) Still give the user a brief useful reply.
2) End your message with a single line exactly in this form:
[[STAFF]] short summary of what staff must handle

Rules:
- Do not invent prices, deadlines, acceptances, or live operational data.
- Do not assist with crime, token theft, OAuth bypass, or Discord ToS evasion.
- Prefer concise, precise answers.
- Only use [[STAFF]] when staff action is actually needed, not on every message.
`;

async function buildSystemPrompt() {
  const custom = (await getPrompt()) || '';
  if (custom.trim()) {
    return BASE_BEHAVIOR + '\n\n—— Additional operator instructions ——\n' + custom.trim();
  }
  return BASE_BEHAVIOR;
}

async function callAI(userText, username) {
  const key = aiKey();
  if (!key) return { text: null, error: 'AI_API_KEY (or GROQ_API_KEY / XAI_API_KEY) is not set on the host.' };

  const system = await buildSystemPrompt();
  const body = {
    model: aiModel(),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: (username ? username + ': ' : '') + userText },
    ],
    temperature: 0.4,
    max_tokens: 900,
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
    console.error('AI error', res.status, t.slice(0, 400));
    return { text: null, error: 'Provider error HTTP ' + res.status };
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  return { text: text ? String(text).trim() : null, error: text ? null : 'Empty model response' };
}

function splitStaffMarker(raw) {
  if (!raw) return { reply: '', staff: null };
  const m = raw.match(/\[\[STAFF\]\]\s*([\s\S]*)$/i);
  if (!m) return { reply: raw.trim(), staff: null };
  const reply = raw.slice(0, m.index).trim();
  const staff = (m[1] || '').trim() || 'User requested staff attention.';
  return { reply: reply || '…', staff };
}

async function postStaffEscalation(client, message, summary, userQuestion) {
  const chId = await getSetting(AICHANNEL_KEY, '');
  if (!chId) return false;
  const ch = await client.channels.fetch(chId).catch(() => null);
  if (!ch || !ch.isTextBased?.()) return false;

  const color = await getEmbedColor();
  const embed = new EmbedBuilder()
    .setTitle('AI → Staff')
    .setColor(color)
    .setDescription(summary.slice(0, 2000))
    .addFields(
      {
        name: 'User',
        value: '<@' + message.author.id + '> (`' + message.author.id + '`)',
        inline: true,
      },
      {
        name: 'Channel',
        value: '<#' + message.channel.id + '>',
        inline: true,
      },
      {
        name: 'Question',
        value: (userQuestion || '').slice(0, 1000) || '—',
      }
    )
    .setFooter({ text: 'Payout Central · AI escalation' })
    .setTimestamp();

  await ch.send({ content: 'Staff review requested.', embeds: [embed] }).catch((e) => {
    console.error('ai staff post', e.message);
  });
  return true;
}

async function handleAiCommand(message, args, client) {
  const prefix = (await getSetting('prefix', '?')) || '?';
  const sub = (args[0] || '').toLowerCase();

  // ?ai channel set is alias handled via aichannel; keep ?ai for questions
  if (sub === 'channel' && (args[1] || '').toLowerCase() === 'set') {
    return handleAichannel(message, ['set', ...args.slice(2)], client);
  }

  const question = args.join(' ').trim();
  if (!question) {
    return message.reply(
      'Usage: `' + prefix + 'ai <your question>`\n' +
        'Staff channel: `' + prefix + 'aichannel set #channel`' +
        (aiConfigured() ? '' : '\n_Warning: no AI API key configured on the host._')
    );
  }

  const now = Date.now();
  const last = lastCall.get(message.author.id) || 0;
  if (now - last < COOLDOWN_MS) {
    return message.reply('Wait a moment before another AI request.');
  }
  lastCall.set(message.author.id, now);

  await message.channel.sendTyping().catch(() => {});

  let result;
  try {
    result = await callAI(question, message.author.username);
  } catch (e) {
    console.error('callAI', e);
    return message.reply('AI request failed.');
  }

  if (!result.text) {
    return message.reply(result.error || 'AI unavailable.');
  }

  const { reply, staff } = splitStaffMarker(result.text);
  const out = reply.slice(0, 1900);
  await message.reply({ content: out }).catch(() => message.channel.send(out).catch(() => {}));

  if (staff) {
    const ok = await postStaffEscalation(client, message, staff, question);
    if (ok) {
      await message.channel.send('A note was forwarded to the staff channel.').catch(() => {});
    } else {
      await message.channel
        .send('Staff input is needed, but no AI staff channel is set (`' + prefix + 'aichannel set #channel`).')
        .catch(() => {});
    }
  }
}

async function handleAichannel(message, args, client) {
  const prefix = (await getSetting('prefix', '?')) || '?';
  const sub = (args[0] || '').toLowerCase();

  const can =
    perms.isOwner(message.author.id) ||
    (await perms.canUse(message.author.id, 'aichannel')) ||
    (await perms.canUse(message.author.id, 'aiprompt'));

  if (!can) return message.reply('No permission.');

  if (sub === 'set') {
    const ch = message.mentions.channels.first();
    if (!ch) {
      return message.reply('Usage: `' + prefix + 'aichannel set #channel`');
    }
    await setSetting(AICHANNEL_KEY, ch.id);
    logs.adminLog(client, 'AI staff channel', 'By <@' + message.author.id + '> → <#' + ch.id + '>');
    return message.reply('AI staff channel set to <#' + ch.id + '>. Escalations will be posted there.');
  }

  if (sub === 'show' || sub === 'get') {
    const id = await getSetting(AICHANNEL_KEY, '');
    return message.reply(id ? 'AI staff channel: <#' + id + '>' : 'No AI staff channel set.');
  }

  if (sub === 'clear') {
    await setSetting(AICHANNEL_KEY, '');
    return message.reply('AI staff channel cleared.');
  }

  return message.reply(
    'Usage: `' + prefix + 'aichannel set #channel` · `show` · `clear`\n' +
      '(Does not change the farm join channel `' + prefix + 'channel set`.)'
  );
}

module.exports = {
  handleAiCommand,
  handleAichannel,
  aiConfigured,
  AICHANNEL_KEY,
};
