'use strict';
const crypto = require('node:crypto');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const randomId = (n = 12) => crypto.randomBytes(n).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 10) return k.slice(0, 2) + '***';
  return k.slice(0, 6) + '***' + k.slice(-4);
}

function truncate(s, n) {
  if (s == null) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;
}

function clone(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}

// Shallow-recursive merge of defaults into a user object (user values win, arrays replaced).
function mergeDefaults(defaults, user) {
  if (user === undefined || user === null) return clone(defaults);
  if (typeof defaults !== 'object' || Array.isArray(defaults) || defaults === null) return user;
  const out = { ...user };
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in out)) out[k] = clone(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = mergeDefaults(v, out[k]);
  }
  return out;
}

function fmtTokens(n) {
  if (n == null) return '-';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
  return String(n);
}

module.exports = { sha1, randomId, sleep, now, maskKey, truncate, clone, mergeDefaults, fmtTokens };
