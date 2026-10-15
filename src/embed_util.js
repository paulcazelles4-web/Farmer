// language: JavaScript, file: embed_util.js
const { getSetting, setSetting } = require('./db');

const DEFAULT_HEX = '5865f2';

function parseHex(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return s.toLowerCase();
}

async function getEmbedColor() {
  const raw = await getSetting('embed_color', DEFAULT_HEX);
  const hex = parseHex(raw) || DEFAULT_HEX;
  return parseInt(hex, 16);
}

async function getEmbedHex() {
  const raw = await getSetting('embed_color', DEFAULT_HEX);
  return parseHex(raw) || DEFAULT_HEX;
}

async function setEmbedColor(hexOrReset) {
  if (!hexOrReset || String(hexOrReset).toLowerCase() === 'reset') {
    await setSetting('embed_color', DEFAULT_HEX);
    return DEFAULT_HEX;
  }
  const hex = parseHex(hexOrReset);
  if (!hex) return null;
  await setSetting('embed_color', hex);
  return hex;
}

module.exports = { getEmbedColor, getEmbedHex, setEmbedColor, parseHex, DEFAULT_HEX };
