// language: JavaScript, file: audit.js
const { EmbedBuilder } = require('discord.js');
const { query, many } = require('./db');
const { getEmbedColor } = require('./embed_util');
const perms = require('./permissions');

async function ensureAuditTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
    )
  `).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC)`).catch(() => {});
}

async function audit(actorId, action, target = null, detail = null) {
  try {
    await ensureAuditTable();
    await query(
      `INSERT INTO audit_log (actor_id, action, target, detail) VALUES ($1, $2, $3, $4)`,
      [String(actorId), String(action).slice(0, 64), target != null ? String(target).slice(0, 200) : null, detail != null ? String(detail).slice(0, 1000) : null]
    );
  } catch (e) {
    console.error('audit', e.message);
  }
}

async function handleAuditCommand(message, args) {
  if (!perms.isOwner(message.author.id) && !(await perms.canUse(message.author.id, 'audit'))) {
    return message.reply('No permission.');
  }
  await ensureAuditTable();
  const limit = Math.min(Math.max(parseInt(args[0], 10) || 15, 1), 40);
  const rows = await many(
    `SELECT * FROM audit_log ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  const color = await getEmbedColor();
  if (!rows.length) {
    return message.reply({ embeds: [new EmbedBuilder().setTitle('Audit Trail').setColor(color).setDescription('No entries yet.').setTimestamp()] });
  }
  const lines = rows.map((r) => {
    const when = r.created_at ? '<t:' + r.created_at + ':R>' : '—';
    const target = r.target ? ' → `' + r.target + '`' : '';
    const detail = r.detail ? ' · ' + r.detail.slice(0, 80) : '';
    return '**' + r.action + '** <@' + r.actor_id + '>' + target + detail + ' · ' + when;
  });
  return message.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Audit Trail')
        .setColor(color)
        .setDescription(lines.join('\n').slice(0, 4000))
        .setFooter({ text: 'Showing ' + rows.length + ' · ?audit [limit]' })
        .setTimestamp(),
    ],
  });
}

module.exports = { audit, handleAuditCommand, ensureAuditTable };
