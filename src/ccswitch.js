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

// Deliberately small TOML reader: only string/bool assignments and provider sections are needed.
function codexRelayConfig(toml) {
  const sections = Object.create(null); sections[''] = Object.create(null); let section = '';
  for (const line of String(toml || '').split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (heading) { section = heading[1].replace(/["']/g, ''); sections[section] ||= Object.create(null); continue; }
    const assignment = line.match(/^\s*([\w-]+)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*'|true|false)\s*(?:#.*)?$/);
    if (!assignment) continue;
    const value = assignment[2];
    try { sections[section][assignment[1]] = value.startsWith("'") ? value.slice(1, -1) : JSON.parse(value); } catch {}
  }
  return { ...sections[''], provider: sections['model_providers.' + sections[''].model_provider] || {} };
}
function readCcSwitchCodexRelays(port = 18787) {
  const file = ccSwitchDbPath(); if (!file) return [];
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file, { readOnly: true });
    const out = [];
    for (const row of db.prepare("SELECT id, name, settings_config, is_current FROM providers WHERE app_type = 'codex'").all()) {
      let settings; try { settings = JSON.parse(row.settings_config); } catch { continue; }
      if (!settings || typeof settings !== 'object') continue;
      if (settings.auth?.auth_mode === 'chatgpt' && settings.auth.tokens) continue;
      const config = codexRelayConfig(settings.config), p = config.provider;
      if (!p.base_url || (p.wire_api !== undefined && p.wire_api !== 'responses')) continue;
      let url; try { url = new URL(p.base_url); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (['127.0.0.1', 'localhost'].includes(url.hostname) && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === Number(port) && /^\/codex(?:\/|$)/.test(url.pathname)) continue;
      const apiKey = [settings.auth?.OPENAI_API_KEY, p.experimental_bearer_token]
        .find((key) => typeof key === 'string' && key.trim())?.trim() || '';
      const manual = settings.requires_manual_auth || settings.auth?.requires_manual_auth || config.requires_manual_auth || p.requires_manual_auth;
      out.push({ id: row.id, name: row.name, type: 'relay', isCurrent: !!row.is_current, baseUrl: p.base_url.replace(/\/+$/, ''), apiKey,
        model: config.model || '', importable: !manual && !!apiKey, reason: manual ? '需要手动认证' : !apiKey ? '缺少 API 密钥' : '' });
    }
    return out;
  } catch { return []; }
  finally { db?.close(); }
}
module.exports = { ccSwitchDbPath, readCcSwitchProviders, readCcSwitchCodexAccounts, readCcSwitchCodexRelays, jwtPayload, codexIdentity };
