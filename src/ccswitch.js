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

module.exports = { ccSwitchDbPath, readCcSwitchProviders };
