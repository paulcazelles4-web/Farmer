// language: JavaScript, file: help.js — dropdown category help panel
const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');

const CATEGORIES = {
  core: {
    label: 'Core',
    emoji: '⚙️',
    description: 'Auth, stock, join, verify',
    lines: (p) => [
      '`' + p + 'auth` — auth counts',
      '`' + p + 'stock` — current stock',
      '`' + p + 'restock <n>` — restock tokens',
      '`' + p + 'remove <n>` — remove from stock',
      '`' + p + 'link` / `' + p + 'link define <url>`',
      '`' + p + 'verify` — OAuth verify button',
      '`' + p + 'bot` — add-bot invite button',
      '`' + p + 'join <serverID>` — request members',
      '`' + p + 'channel set #channel` — join channel',
      '`' + p + 'checkauth` — scan auth pool',
      '`' + p + 'status` — bot status',
      '`' + p + 'panel` — persistent panel',
      '`' + p + 'apply panel` — restocker apply panel',
    ],
  },
  permissions: {
    label: 'Permissions',
    emoji: '🔐',
    description: 'Grants & permissions',
    lines: (p) => [
      '`' + p + 'grant @user <cmd|all>`',
      '`' + p + 'grant revoke @user <cmd|all>`',
      '`' + p + 'permission @user`',
    ],
  },
  queue: {
    label: 'Queue',
    emoji: '📋',
    description: 'Member send queue',
    lines: (p) => [
      '`' + p + 'queue` · clear',
      '`' + p + 'queue remove|info|priority <id>`',
      '`' + p + 'queue move <id> <pos>`',
      '`' + p + 'queue pause` · resume',
    ],
  },
  server: {
    label: 'Server',
    emoji: '🖥️',
    description: 'Guilds, leave, blacklist',
    lines: (p) => [
      '`' + p + 'checkserver <id>`',
      '`' + p + 'blacklist <id> <reason>`',
      '`' + p + 'blacklist list` / revoke',
      '`' + p + 'leave <id|all>`',
      '`' + p + 'antileave add|revoke|list`',
      '`' + p + 'announce <id|all> <msg>`',
      '`' + p + 'invites` · `' + p + 'invites user @u`',
    ],
  },
  config: {
    label: 'Config',
    emoji: '🛠️',
    description: 'Prefix, roles, cooldown, color',
    lines: (p) => [
      '`' + p + 'prefix set <prefix>`',
      '`' + p + 'basesend set <n>`',
      '`' + p + 'send @role <n>`',
      '`' + p + 'verifyrole set @role`',
      '`' + p + 'cooldown <seconds>`',
      '`' + p + 'bio <text>` · clear',
      '`' + p + 'color <#hex>` · reset',
    ],
  },
  logs: {
    label: 'Logs',
    emoji: '📜',
    description: 'Log channels & tests',
    lines: (p) => [
      '`' + p + 'logfarm|logserver|logerrors|logadmin`',
      'enable · disable · set #ch',
      '`' + p + 'logs status` · `' + p + 'log test`',
    ],
  },
  admin: {
    label: 'Admin / Abuse',
    emoji: '🛡️',
    description: 'Stats, banfarm, antiraid, apply',
    lines: (p) => [
      '`' + p + 'stats` · `' + p + 'profile @user`',
      '`' + p + 'maintenance enable|disable`',
      '`' + p + 'banfarm @user [reason]`',
      '`' + p + 'antiraid enable|disable|status`',
      '`' + p + 'antiraid threshold <n>` · clear',
      '`' + p + 'token` · export · import',
      '`' + p + 'apply panel` · channel · role',
      '`' + p + 'apply list|view|accept|deny`',
    ],
  },
};

function buildCategoryEmbed(prefix, categoryKey, color = 0x5865f2) {
  const cat = CATEGORIES[categoryKey] || CATEGORIES.core;
  const p = prefix;
  return new EmbedBuilder()
    .setTitle('Member Farm — Command Panel')
    .setColor(color)
    .setDescription(
      'Current prefix: `' +
        p +
        '` — change with `' +
        p +
        'prefix set <prefix>`\n\n**' +
        (cat.emoji || '') +
        ' ' +
        cat.label +
        '**'
    )
    .addFields({
      name: cat.label,
      value: cat.lines(p).join('\n'),
    })
    .setFooter({ text: 'Member Farm · select a category below' })
    .setTimestamp();
}

function buildHelpSelect(selected = 'core') {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_category')
    .setPlaceholder('Choose a command category…');

  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const opt = new StringSelectMenuOptionBuilder()
      .setLabel(cat.label)
      .setDescription(cat.description)
      .setValue(key)
      .setDefault(key === selected);
    if (cat.emoji) opt.setEmoji(cat.emoji);
    menu.addOptions(opt);
  }

  return new ActionRowBuilder().addComponents(menu);
}

/** Full help message payload (embed + select) */
function buildHelpPayload(prefix, color = 0x5865f2, category = 'core') {
  return {
    embeds: [buildCategoryEmbed(prefix, category, color)],
    components: [buildHelpSelect(category)],
  };
}

// Backward-compatible: returns EmbedBuilder only (used if something still expects embed)
function buildHelpEmbed(prefix, color = 0x5865f2) {
  return buildCategoryEmbed(prefix, 'core', color);
}

module.exports = {
  buildHelpEmbed,
  buildHelpPayload,
  buildCategoryEmbed,
  buildHelpSelect,
  CATEGORIES,
};
