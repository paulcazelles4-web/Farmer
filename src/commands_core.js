// language: JavaScript, file: commands_core.js — assembled from cc_part*
const path = require('path');
const Module = require('module');
const parts = [
  require('./cc_part0'),
  require('./cc_part1'),
  require('./cc_part2'),
  require('./cc_part3'),
];
const code = parts.join('');
const m = new Module(path.join(__dirname, 'commands_core_assembled.js'));
m.filename = path.join(__dirname, 'commands_core_assembled.js');
m.paths = Module._nodeModulePaths(__dirname);
m._compile(code, m.filename);
module.exports = m.exports;
