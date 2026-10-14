// language: JavaScript, file: permissions.js
const { one, many, query } = require('./db');
const config = require('./config');

function isOwner(userId) {
  return String(userId) === String(config.OWNER_ID);
}

async function hasGrant(userId, command) {
  if (isOwner(userId)) return true;
  const row = await one(
    `SELECT 1 FROM grants WHERE user_id = $1 AND (command = $2 OR command = 'all')`,
    [String(userId), command]
  );
  return !!row;
}

async function grant(userId, command) {
  await query(
    `INSERT INTO grants (user_id, command) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [String(userId), command]
  );
}

async function revoke(userId, command) {
  if (command === 'all') {
    await query('DELETE FROM grants WHERE user_id = $1', [String(userId)]);
  } else {
    await query('DELETE FROM grants WHERE user_id = $1 AND command = $2', [String(userId), command]);
  }
}

async function listGrants(userId) {
  const rows = await many('SELECT command FROM grants WHERE user_id = $1', [String(userId)]);
  return rows.map(r => r.command);
}

async function isMaintenance() {
  const row = await one(`SELECT value FROM settings WHERE key = 'maintenance'`);
  return row?.value === '1';
}

async function isMaintenanceAllowed(userId) {
  if (isOwner(userId)) return true;
  const row = await one('SELECT 1 FROM maintenance_allowed WHERE user_id = $1', [String(userId)]);
  return !!row;
}

async function canUse(userId, command) {
  if (isOwner(userId)) return true;
  if ((await isMaintenance()) && !(await isMaintenanceAllowed(userId))) return false;
  return hasGrant(userId, command);
}

module.exports = {
  isOwner, hasGrant, grant, revoke, listGrants,
  isMaintenance, isMaintenanceAllowed, canUse,
};
