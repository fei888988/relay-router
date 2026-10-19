'use strict';
// All external credential writes live here. Callers catch failures so routing can continue.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ccSwitchDbPath, jwtPayload, codexIdentity } = require('./ccswitch');

const tokenExp = (tokens) => {
  const exp = Number(jwtPayload(tokens?.access_token).exp);
  return Number.isFinite(exp) && exp > 0 ? exp : 0;
};
const credentialTokens = (tokens, accountId) => ({ id_token: tokens.id_token || '',
  access_token: tokens.access_token, refresh_token: tokens.refresh_token, account_id: accountId });
function matchingAuth(auth, accountId) {
  return auth?.auth_mode === 'chatgpt' && auth.tokens && codexIdentity(auth.tokens).accountId === accountId;
}

function writeCcSwitch(a, backup) {
  const file = ccSwitchDbPath();
  if (!file) throw new Error('CC Switch database missing');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare("SELECT app_type, settings_config FROM providers WHERE id = ? AND app_type = 'codex'").get(a.ccSwitchId);
    const settings = row && JSON.parse(row.settings_config);
    if (row?.app_type !== 'codex' || !matchingAuth(settings?.auth, a.accountId)) throw new Error('CC Switch binding changed');
    let written = false;
    if (tokenExp(a.tokens) > tokenExp(settings.auth.tokens)) {
      backup(file);
      // Preserve unknown token keys as well as every other setting.
      Object.assign(settings.auth.tokens, credentialTokens(a.tokens, a.accountId));
      settings.auth.last_refresh = new Date().toISOString();
      db.prepare('UPDATE providers SET settings_config = ? WHERE id = ? AND app_type = \'codex\'')
        .run(JSON.stringify(settings), a.ccSwitchId);
      written = true;
    }
    db.exec('COMMIT');
    return { written, tokens: settings.auth.tokens };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { db.close(); }
}

function authFilePath() {
  return process.env.SMART_ROUTER_CODEX_AUTH_FILE || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}
function readAuthFile(a) {
  const file = authFilePath();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const auth = JSON.parse(text);
  // Unlike CC Switch identity detection, the live file requires an explicit matching account_id.
  return auth?.auth_mode === 'chatgpt' && auth.tokens?.account_id === a.accountId ? auth : null;
}
function writeAuthFile(a) {
  // Re-read immediately before writing: another app may have rotated since the initial check.
  const auth = readAuthFile(a);
  if (!auth) return null;
  if (tokenExp(a.tokens) <= tokenExp(auth.tokens)) return { written: false, tokens: auth.tokens };
  Object.assign(auth.tokens, credentialTokens(a.tokens, a.accountId));
  auth.last_refresh = new Date().toISOString();
  const file = authFilePath(), temp = file + '.smart-router-' + process.pid + '-' + require('node:crypto').randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(auth, null, 2), { mode: fs.statSync(file).mode & 0o777, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return { written: true, tokens: auth.tokens };
}

module.exports = { tokenExp, writeCcSwitch, readAuthFile, writeAuthFile };
