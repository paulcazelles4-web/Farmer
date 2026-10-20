// language: JavaScript, file: oauth.js — assembled from oauth_p*
const path = require('path');
const Module = require('module');
const parts = [
  require('./oauth_p0'),
  require('./oauth_p1'),
  require('./oauth_p2'),
  require('./oauth_p3'),
];
const code = parts.join('');
const m = new Module(path.join(__dirname, 'oauth_assembled.js'));
m.filename = path.join(__dirname, 'oauth_assembled.js');
m.paths = Module._nodeModulePaths(__dirname);
m._compile(code, m.filename);
module.exports = m.exports;
