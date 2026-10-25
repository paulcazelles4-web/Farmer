// language: JavaScript, file: server_prompt.js — editable AI system prompt (no baked-in default)
const { EmbedBuilder } = require('discord.js');
const { getSetting, setSetting } = require('./db');
const { getEmbedColor } = require('./embed_util');
const perms = require('./permissions');
const logs = require('./logs');

const PROMPT_KEY = 'ai_system_prompt';

async function getPrompt() {
  const v = await getSetting(PROMPT_KEY, '');
  return v ? String(v) : '';
}

async function setPrompt(text) {
  await setSetting(PROMPT_KEY, String(text));
}

async function handleAiprompt(message, args, client) {
  const sub = (args[0] || '').toLowerCase();
  const prefix = (await getSetting('prefix', '?')) || '?';
  const color = await getEmbedColor();

  const canEdit =
    perms.isOwner(message.author.id) || (await perms.canUse(message.author.id, 'aiprompt'));

  if (!sub || sub === 'show' || sub === 'view' || sub === 'get') {
    const prompt = await getPrompt();
    if (!prompt.trim()) {
      return message.reply(
        'No AI system prompt stored yet.\nSet one with `' +
          prefix +
          'aiprompt set <text>` · attachment `.txt` · or reply to a message.'
      );
    }
    const preview =
      prompt.length > 1800
        ? prompt.slice(0, 1800) + '\n…\n_(truncated — ' + prompt.length + ' chars)_'
        : prompt;
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('AI System Prompt')
          .setColor(color)
          .setDescription('```\n' + preview.replace(/```/g, "'''") + '\n```')
          .addFields({ name: 'Length', value: '`' + prompt.length + '` characters', inline: true })
          .setFooter({ text: prefix + 'aiprompt set | append | clear' })
          .setTimestamp(),
      ],
    });
    if (prompt.length > 1800 && canEdit) {
      try {
        const chunks = [];
        for (let i = 0; i < prompt.length; i += 1900) chunks.push(prompt.slice(i, i + 1900));
        await message.author.send('Full AI prompt (' + chunks.length + ' part(s)):');
        for (const c of chunks) await message.author.send('```\n' + c.replace(/```/g, "'''") + '\n```');
      } catch {
        await message.channel.send('Could not DM the full prompt.').catch(() => {});
      }
    }
    return;
  }

  if (!canEdit) {
    return message.reply('No permission. Need owner or grant `aiprompt`.');
  }

  if (sub === 'clear') {
    await setPrompt('');
    logs.adminLog(client, 'AI prompt cleared', 'By <@' + message.author.id + '>');
    return message.reply('AI system prompt cleared.');
  }

  if (sub === 'set' || sub === 'append') {
    let text = args.slice(1).join(' ').trim();

    const att = message.attachments.first();
    if (att && (att.name?.endsWith('.txt') || att.name?.endsWith('.md') || att.contentType?.includes('text'))) {
      try {
        const res = await fetch(att.url);
        text = await res.text();
      } catch (e) {
        return message.reply('Failed to read attachment: ' + (e.message || e));
      }
    }

    if (!text && message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        text = ref.content || '';
        if (ref.attachments?.size) {
          const a = ref.attachments.first();
          if (a) {
            const res = await fetch(a.url);
            text = (text ? text + '\n' : '') + (await res.text());
          }
        }
      } catch {
        return message.reply('Could not read replied message.');
      }
    }

    if (!text || !text.trim()) {
      return message.reply(
        'Usage:\n' +
          '`' + prefix + 'aiprompt set <text>`\n' +
          '`' + prefix + 'aiprompt set` + `.txt` attachment\n' +
          '`' + prefix + 'aiprompt set` as reply to a message\n' +
          '`' + prefix + 'aiprompt append <text>`\n' +
          '`' + prefix + 'aiprompt show` · `clear`'
      );
    }

    if (sub === 'append') {
      const cur = await getPrompt();
      text = (cur ? cur + '\n' : '') + text;
    }

    if (text.length > 100000) {
      return message.reply('Prompt too large (max ~100k characters).');
    }

    await setPrompt(text);
    logs.adminLog(
      client,
      'AI prompt ' + (sub === 'append' ? 'appended' : 'set'),
      'By <@' + message.author.id + '> · `' + text.length + '` chars'
    );
    return message.reply('AI system prompt **' + sub + '** · `' + text.length + '` characters.');
  }

  return message.reply('Usage: `' + prefix + 'aiprompt show|set|append|clear`');
}

module.exports = {
  getPrompt,
  setPrompt,
  handleAiprompt,
};
