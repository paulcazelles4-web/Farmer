// language: JavaScript, file: slash.js
// Reverted — no slash commands after apply-removal restore.
module.exports = {
  async registerSlashCommands() {},
  async handleSlash() {
    return false;
  },
};
