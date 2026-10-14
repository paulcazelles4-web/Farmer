// language: JavaScript, file: permissions.js
const { db } = require('./db');
const config = require('./config');

function isOwner(userId) {
  return String(userId) === String(config.OWNER_ID);
}

function hasGrant(userId, command) {
  if (isOwner(userId)) return true;
  const row = db.prepare('SELECT 1 FROM grants WHERE user_id = ? AND (command = ? OR command = \'all\')').get(String(userId), command);
  return !!row;
}

function grant(userId, command) {
  db.prepare('INSERT OR IGNORE INTO grants (user_id, command) VALUES (?, ?)').run(String(userId), command);
}

function revoke(userId, command) {
  if (command === 'all') {
    db.prepare('DELETE FROM grants WHERE user_id = ?').run(String(userId));
  } else {
    db.prepare('DELETE FROM grants WHERE user_id = ? AND command = ?').run(String(userId), command);
  }
}

function listGrants(userId) {
  return db.prepare('SELECT command FROM grants WHERE user_id = ?').all(String(userId)).map(r => r.command);
}

function isMaintenance() {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get('maintenance')?.value === '1';
}

function isMaintenanceAllowed(userId) {
  if (isOwner(userId)) return true;
  return !!db.prepare('SELECT 1 FROM maintenance_allowed WHERE user_id = ?').get(String(userId));
}

function canUse(userId, command) {
  if (isOwner(userId)) return true;
  if (isMaintenance() && !isMaintenanceAllowed(userId)) return false;
  return hasGrant(userId, command);
}

module.exports = { isOwner, hasGrant, grant, revoke, listGrants, isMaintenance, isMaintenanceAllowed, canUse };
