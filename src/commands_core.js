const fs = require('fs');
const path = require('path');
const code =
  fs.readFileSync(path.join(__dirname, 'commands_core_a.js'), 'utf8') +
  fs.readFileSync(path.join(__dirname, 'commands_core_b.js'), 'utf8');
const m = { exports: {} };
new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
  m.exports,
  require,
  m,
  __filename,
  __dirname
);
module.exports = m.exports;
