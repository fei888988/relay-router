'use strict';
// Read-only access to CC Switch's provider database, used to import relay keys.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function ccSwitchDbPath() {
  const p = process.env.CC_SWITCH_DB || path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  return fs.existsSync(p) ? p : null;
}

// Returns [{ id, name, baseUrl, apiKey, models, isCurrent }] for Claude providers that have a key.
function readCcSwitchProviders() {
  const dbPath = ccSwitchDbPath();
  if (!dbPath) return [];
  const { DatabaseSync } = require('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT id, name, settings_config, is_current FROM providers WHERE app_type = 'claude'")
      .all();
    const out = [];
    for (const r of rows) {
      let env = {};
      try {
        env = JSON.parse(r.settings_config).env || {};
      } catch {
        continue;
      }
      const baseUrl = env.ANTHROPIC_BASE_URL;
      const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
      if (!baseUrl || !apiKey) continue;
      // Skip entries that point at this router itself.
      if (/127\.0\.0\.1|localhost/i.test(baseUrl)) continue;
      out.push({
        id: r.id,
        name: r.name,
        baseUrl: baseUrl.replace(/\/+$/, ''),
        apiKey,
        authHeader: env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : 'x-api-key',
        models: {
          main: env.ANTHROPIC_MODEL || null,
          haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || null,
          sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || null,
          opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || null,
        },
        isCurrent: !!r.is_current,
      });
    }
    return out;
  } catch (e) {
    return [];
  } finally {
    try {
      db && db.close();
    } catch {}
  }
}

// JWT claims are metadata only; authentication is performed by the upstream.
function jwtPayload(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  }
  catch { return {}; }
}

function codexIdentity(tokens) {
  const claims = jwtPayload(tokens.id_token);
  const auth = claims['https://api.openai.com/auth'] || {};
  return { email: claims.email || '', planType: auth.chatgpt_plan_type || '',
    accountId: tokens.account_id || auth.chatgpt_account_id || '' };
}

function readCcSwitchCodexAccounts(onError = () => {}, includeIncomplete = false) {
  const file = ccSwitchDbPath();
  if (!file) return [];
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    const out = [];
    for (const row of db.prepare("SELECT id, name, settings_config, is_current FROM providers WHERE app_type = 'codex'").all()) {
      let auth;
      try { auth = JSON.parse(row.settings_config).auth; } catch { continue; }
      if (auth?.auth_mode !== 'chatgpt' || !auth.tokens) continue;
      if (!includeIncomplete && (!auth.tokens.access_token || !auth.tokens.refresh_token)) continue;
      const identity = codexIdentity(auth.tokens);
      if (!identity.accountId) continue;
      out.push({ id: row.id, name: row.name, isCurrent: !!row.is_current, ...identity,
        tokens: { id_token: auth.tokens.id_token || '', access_token: auth.tokens.access_token,
          refresh_token: auth.tokens.refresh_token, account_id: identity.accountId } });
    }
    return out;
  } catch { onError(); return []; }
  finally { db?.close(); }
}

module.exports = { ccSwitchDbPath, readCcSwitchProviders, readCcSwitchCodexAccounts, jwtPayload, codexIdentity };
