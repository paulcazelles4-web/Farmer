// language: JavaScript, file: help.js — dropdown help filtered by user perms
const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const perms = require('./permissions');

const CATEGORIES = {
  core: {
    label: 'Core',
    emoji: '⚙️',
    description: 'Auth, stock, join, verify',
    entries: (p) => [
      { cmd: 'auth', perm: 'auth', text: '`' + p + 'auth` — auth counts' },
      { cmd: 'stock', perm: 'stock', text: '`' + p + 'stock` — displayed stock' },
      { cmd: 'restock', perm: 'restock', text: '`' + p + 'restock <n>` — restock tokens' },
      { cmd: 'remove', perm: 'remove', text: '`' + p + 'remove <n>` — remove from stock' },
      { cmd: 'fakestock', perm: 'fakestock', text: '`' + p + 'fakestock show|add|remove|set|clear`' },
      { cmd: 'link', perm: 'link', text: '`' + p + 'link` · define · server' },
      { cmd: 'verify', perm: null, text: '`' + p + 'verify` — farm authorize (public)' },
      {
        cmd: 'serververify',
        perm: 'serververify',
        text: '`' + p + 'serververify` — server verify panel (alts → Alt role)',
      },
      { cmd: 'bot', perm: null, text: '`' + p + 'bot` — add-bot invite button' },
      { cmd: 'join', perm: null, text: '`' + p + 'join <serverID>` — request members' },
      { cmd: 'channel', perm: 'channel', text: '`' + p + 'channel set #channel` — join channel' },
      { cmd: 'send', perm: 'send', text: '`' + p + 'send @user <n>` — members per join for that user' },
      { cmd: 'checkauth', perm: 'checkauth', text: '`' + p + 'checkauth` — scan auth pool' },
      { cmd: 'status', perm: null, text: '`' + p + 'status` — bot status' },
      { cmd: 'panel', perm: 'panel', text: '`' + p + 'panel` — persistent panel' },
      { cmd: 'checkserver', perm: null, text: '`' + p + 'checkserver <id>` — server info' },
    ],
  },
  permissions: {
    label: 'Permissions',
    emoji: '🔐',
    description: 'Grants & permissions',
    entries: (p) => [
      { cmd: 'grant', perm: 'grant', text: '`' + p + 'grant @user <cmd|all>`' },
      { cmd: 'grant', perm: 'grant', text: '`' + p + 'grant revoke @user <cmd|all>`' },
      { cmd: 'permission', perm: 'permission', text: '`' + p + 'permission @user`' },
    ],
  },
  queue: {
    label: 'Queue',
    emoji: '📋',
    description: 'Member send queue',
    entries: (p) => [
      { cmd: 'queue', perm: 'queue', text: '`' + p + 'queue` · clear' },
      { cmd: 'queue', perm: 'queue', text: '`' + p + 'queue remove|info|priority <id>`' },
      { cmd: 'queue', perm: 'queue', text: '`' + p + 'queue move <id> <pos>`' },
      { cmd: 'queue', perm: 'queue', text: '`' + p + 'queue pause` · resume' },
    ],
  },
  server: {
    label: 'Server',
    emoji: '🖥️',
    description: 'Guilds, leave, blacklist',
    entries: (p) => [
      { cmd: 'blacklist', perm: 'blacklist', text: '`' + p + 'blacklist <id> <reason>`' },
      { cmd: 'blacklist', perm: 'blacklist', text: '`' + p + 'blacklist list` / revoke' },
      { cmd: 'leave', perm: 'leave', text: '`' + p + 'leave <id|all>`' },
      { cmd: 'antileave', perm: 'antileave', text: '`' + p + 'antileave add|revoke|list`' },
      { cmd: 'announce', perm: 'announce', text: '`' + p + 'announce <id|all> <msg>`' },
      { cmd: 'invites', perm: 'invites', text: '`' + p + 'invites` · `' + p + 'invites user @u`' },
    ],
  },
  config: {
    label: 'Config',
    emoji: '🛠️',
    description: 'Prefix, roles, cooldown, color',
    entries: (p) => [
      { cmd: 'prefix', perm: 'prefix', text: '`' + p + 'prefix set <prefix>`' },
      { cmd: 'basesend', perm: 'basesend', text: '`' + p + 'basesend set <n>`' },
      { cmd: 'send', perm: 'send', text: '`' + p + 'send @user <n>` — per-user join amount' },
      { cmd: 'verifyrole', perm: 'verifyrole', text: '`' + p + 'verifyrole set @role`' },
      { cmd: 'cooldown', perm: 'cooldown', text: '`' + p + 'cooldown <seconds>`' },
      { cmd: 'bio', perm: 'bio', text: '`' + p + 'bio <text>` · clear' },
      { cmd: 'color', perm: 'color', text: '`' + p + 'color <#hex>` · reset' },
    ],
  },
  logs: {
    label: 'Logs',
    emoji: '📜',
    description: 'Log channels & tests',
    entries: (p) => [
      { cmd: 'logs', perm: 'logs', text: '`' + p + 'logs status` — all log channels' },
      { cmd: 'logfarm', perm: 'logs', text: '`' + p + 'logfarm set #ch` · enable · disable' },
      { cmd: 'logserver', perm: 'logs', text: '`' + p + 'logserver set #ch` · enable · disable' },
      { cmd: 'logerrors', perm: 'logs', text: '`' + p + 'logerrors set #ch` · enable · disable' },
      { cmd: 'logadmin', perm: 'logs', text: '`' + p + 'logadmin set #ch` · enable · disable' },
      { cmd: 'logverify', perm: 'logs', text: '`' + p + 'logverify set #ch` · enable · disable' },
      { cmd: 'logs', perm: 'logs', text: '`' + p + 'log test` — simulate all log types' },
    ],
  },
  admin: {
    label: 'Admin / Abuse',
    emoji: '🛡️',
    description: 'Stats, banfarm, antiraid',
    entries: (p) => [
      { cmd: 'stats', perm: 'stats', text: '`' + p + 'stats`' },
      { cmd: 'profile', perm: 'profile', text: '`' + p + 'profile @user`' },
      { cmd: 'maintenance', perm: 'maintenance', text: '`' + p + 'maintenance enable|disable`' },
      { cmd: 'banfarm', perm: 'banfarm', text: '`' + p + 'banfarm @user [reason]`' },
      { cmd: 'antiraid', perm: 'antiraid', text: '`' + p + 'antiraid enable|disable|status`' },
      { cmd: 'antiraid', perm: 'antiraid', text: '`' + p + 'antiraid threshold <n>` · clear' },
      { cmd: 'token', perm: 'owner', text: '`' + p + 'token` · export · import' },
    ],
  },
};

async function canSee(userId, permKey) {
  if (permKey === null || permKey === undefined) return true;
  if (permKey === 'owner') return perms.isOwner(userId);
  if (perms.isOwner(userId)) return true;
  return perms.canUse(userId, permKey);
}

async function filterCategory(prefix, categoryKey, userId) {
  const cat = CATEGORIES[categoryKey];
  if (!cat) return null;
  const entries = cat.entries(prefix);
  const visible = [];
  for (const e of entries) {
    if (await canSee(userId, e.perm)) visible.push(e.text);
  }
  if (!visible.length) return null;
  return {
    key: categoryKey,
    label: cat.label,
    emoji: cat.emoji,
    description: cat.description,
    lines: visible,
  };
}

async function getVisibleCategories(prefix, userId) {
  const out = [];
  for (const key of Object.keys(CATEGORIES)) {
    const filtered = await filterCategory(prefix, key, userId);
    if (filtered) out.push(filtered);
  }
  return out;
}

function buildCategoryEmbed(prefix, cat, color = 0x5865f2) {
  return new EmbedBuilder()
    .setTitle('Member Farm — Command Panel')
    .setColor(color)
    .setDescription(
      'Current prefix: `' +
        prefix +
        '` — change with `' +
        prefix +
        'prefix set <prefix>`\n\n**' +
        (cat.emoji || '') +
        ' ' +
        cat.label +
        '**\n_Showing only commands you can use._'
    )
    .addFields({
      name: cat.label,
      value: cat.lines.join('\n').slice(0, 1020),
    })
    .setFooter({ text: 'Member Farm · select a category below' })
    .setTimestamp();
}

function buildHelpSelect(visibleCats, selectedKey) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_category')
    .setPlaceholder('Choose a command category…');
  for (const cat of visibleCats) {
    const opt = new StringSelectMenuOptionBuilder()
      .setLabel(cat.label)
      .setDescription((cat.description || '').slice(0, 100))
      .setValue(cat.key)
      .setDefault(cat.key === selectedKey);
    if (cat.emoji) opt.setEmoji(cat.emoji);
    menu.addOptions(opt);
  }
  return new ActionRowBuilder().addComponents(menu);
}

async function buildHelpPayload(prefix, color = 0x5865f2, category = 'core', userId) {
  const visible = await getVisibleCategories(prefix, userId);
  if (!visible.length) {
    return {
      embeds: [
        new EmbedBuilder()
          .setTitle('Member Farm — Command Panel')
          .setColor(color)
          .setDescription('You have no available commands.')
          .setFooter({ text: 'Member Farm' })
          .setTimestamp(),
      ],
      components: [],
    };
  }
  const selected = visible.find((c) => c.key === category) || visible[0];
  const embed = buildCategoryEmbed(prefix, selected, color);
  const components = visible.length > 1 ? [buildHelpSelect(visible, selected.key)] : [];
  return { embeds: [embed], components };
}

function buildHelpEmbed(prefix, color = 0x5865f2) {
  const lines = CATEGORIES.core.entries(prefix).filter((e) => e.perm === null).map((e) => e.text);
  return new EmbedBuilder()
    .setTitle('Member Farm — Command Panel')
    .setColor(color)
    .setDescription('Current prefix: `' + prefix + '`')
    .addFields({ name: 'Core', value: lines.join('\n') || '`—`' })
    .setFooter({ text: 'Member Farm' })
    .setTimestamp();
}

module.exports = {
  buildHelpEmbed,
  buildHelpPayload,
  getVisibleCategories,
  CATEGORIES,
};
