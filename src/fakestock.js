// language: JavaScript, file: fakestock.js — display-only stock inflation
const { EmbedBuilder } = require('discord.js');
const { one, getSetting, setSetting } = require('./db');
const { getEmbedColor } = require('./embed_util');
const perms = require('./permissions');
const logs = require('./logs');
const { audit } = require('./audit');

const KEY = 'fake_stock_extra';

async function realStockCount() {
  const row = await one(
    'SELECT COUNT(*)::int AS c FROM stock s JOIN tokens t ON t.id = s.token_id WHERE t.valid = 1'
  );
  return Number(row?.c) || 0;
}

async function getFakeExtra() {
  const v = await getSetting(KEY, '0');
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function setFakeExtra(n) {
  const v = Math.max(0, Math.min(1_000_000, Math.floor(Number(n) || 0)));
  await setSetting(KEY, String(v));
  return v;
}

/** What members / live panel should see */
async function displayedStockCount() {
  const real = await realStockCount();
  const fake = await getFakeExtra();
  return real + fake;
}

async function handleFakestock(message, args, client) {
  const prefix = (await getSetting('prefix', '?')) || '?';
  const sub = (args[0] || '').toLowerCase();

  // Authorized only: owner or explicit grant
  if (!perms.isOwner(message.author.id) && !(await perms.canUse(message.author.id, 'fakestock'))) {
    return message.reply('No permission.');
  }

  const color = await getEmbedColor();
  let fake = await getFakeExtra();

  if (sub === 'show' || sub === 'status' || !sub) {
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Fake Stock')
          .setColor(color)
          .setDescription('Amount added on top of real stock for **public display** only.')
          .addFields({ name: 'Fake extra', value: '`' + fake + '`' })
          .setFooter({ text: prefix + 'fakestock add|remove|set|clear' })
          .setTimestamp(),
      ],
    });
  }

  if (sub === 'add') {
    const n = parseInt(args[1], 10);
    if (!n || n < 1) return message.reply('Usage: `' + prefix + 'fakestock add <n>`');
    fake = await setFakeExtra(fake + n);
    try {
      await require('./live').refreshLiveStock(client);
    } catch {}
    try {
      await audit(message.author.id, 'fakestock_add', String(n), 'extra=' + fake);
    } catch {}
    logs.adminLog(client, 'Fake stock +' + n, 'By <@' + message.author.id + '> · extra now `' + fake + '`');
    return message.reply('Fake extra **+' + n + '** → `' + fake + '`.');
  }

  if (sub === 'remove') {
    const n = parseInt(args[1], 10);
    if (!n || n < 1) return message.reply('Usage: `' + prefix + 'fakestock remove <n>`');
    fake = await setFakeExtra(Math.max(0, fake - n));
    try {
      await require('./live').refreshLiveStock(client);
    } catch {}
    try {
      await audit(message.author.id, 'fakestock_remove', String(n), 'extra=' + fake);
    } catch {}
    logs.adminLog(client, 'Fake stock -' + n, 'By <@' + message.author.id + '> · extra now `' + fake + '`');
    return message.reply('Fake extra **-' + n + '** → `' + fake + '`.');
  }

  if (sub === 'set') {
    const n = parseInt(args[1], 10);
    if (args[1] === undefined || Number.isNaN(n) || n < 0) {
      return message.reply('Usage: `' + prefix + 'fakestock set <n>` (0 clears)');
    }
    fake = await setFakeExtra(n);
    try {
      await require('./live').refreshLiveStock(client);
    } catch {}
    try {
      await audit(message.author.id, 'fakestock_set', String(fake));
    } catch {}
    logs.adminLog(client, 'Fake stock set', 'By <@' + message.author.id + '> · extra `' + fake + '`');
    return message.reply('Fake extra set to `' + fake + '`.');
  }

  if (sub === 'clear') {
    fake = await setFakeExtra(0);
    try {
      await require('./live').refreshLiveStock(client);
    } catch {}
    try {
      await audit(message.author.id, 'fakestock_clear');
    } catch {}
    return message.reply('Fake extra cleared (`0`).');
  }

  return message.reply(
    'Usage:\n' +
      '`' + prefix + 'fakestock show`\n' +
      '`' + prefix + 'fakestock add <n>`\n' +
      '`' + prefix + 'fakestock remove <n>`\n' +
      '`' + prefix + 'fakestock set <n>`\n' +
      '`' + prefix + 'fakestock clear`'
  );
}

module.exports = {
  realStockCount,
  getFakeExtra,
  setFakeExtra,
  displayedStockCount,
  handleFakestock,
};
