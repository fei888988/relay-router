'use strict';
// Official ChatGPT accounts have their own priority queue, credentials and health.
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { randomId, maskKey } = require('./util');
const { readCcSwitchCodexAccounts, jwtPayload, codexIdentity } = require('./ccswitch');
const { tokenExp, writeCcSwitch, readAuthFile, writeAuthFile } = require('./codex-sync');
const fs = require('node:fs');
const path = require('node:path');

const number = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const expires = (a) => (number(jwtPayload(a.tokens?.access_token).exp) || 0) * 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const hop = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'];
function headers(input, account) {
  const drop = new Set([...hop, ...String(input.connection || '').toLowerCase().split(',').map((s) => s.trim())]);
  if (account) for (const k of ['authorization', 'chatgpt-account-id', 'x-api-key', 'x-panel']) drop.add(k);
  const out = Object.fromEntries(Object.entries(input).filter(([k, v]) => !drop.has(k.toLowerCase()) && v !== undefined));
  if (account) Object.assign(out, { authorization: 'Bearer ' + account.tokens.access_token, 'chatgpt-account-id': account.accountId });
  return out;
}
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function buffer(stream, max = 60 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) throw fail(413, 'Codex body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parse(buf) { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } }
function windowUsage(w) {
  if (!w || typeof w !== 'object') return null;
  const seconds = number(w.reset_after_seconds);
  const at = number(w.reset_at);
  const minutes = number(w.window_minutes);
  const length = number(w.limit_window_seconds ?? w.window_seconds);
  return { usedPercent: number(w.used_percent), windowMinutes: minutes ?? (length === null ? null : length / 60),
    resetsAt: at !== null ? at * 1000 : seconds !== null ? Date.now() + seconds * 1000 : null };
}

// Observes frames without changing bytes, buffering at most a single bounded event.
class UsageScanner extends Transform {
  constructor(row) { super(); this.row = row; this.decoder = new TextDecoder(); this.pending = ''; }
  _transform(chunk, encoding, callback) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const frames = this.pending.split(/\r?\n\r?\n/);
    this.pending = frames.pop();
    for (const frame of frames) {
      const data = frame.split(/\r?\n/).filter((s) => s.startsWith('data:')).map((s) => s.slice(5).trimStart()).join('\n');
      const obj = parse(Buffer.from(data));
      if (obj?.type === 'response.completed') recordUsage(this.row, obj.response?.usage);
    }
    if (this.pending.length > 4 * 1024 * 1024) this.pending = '';
    callback(null, chunk);
  }
}
function recordUsage(row, usage) {
  if (!usage) return;
  row.inputTokens = number(usage.input_tokens);
  row.outputTokens = number(usage.output_tokens);
}

class CodexRouter {
  constructor({ config, state, store, bus, checkKey }) {
    Object.assign(this, { config, state, store, bus, checkKey });
    this.runtime = state.data.codex ||= { accounts: {}, activeAccountId: null };
    this.refreshes = new Map();
    this.probes = new Map();
    this.controllers = new Set();
    this.upstream = (process.env.SMART_ROUTER_CODEX_UPSTREAM || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, '');
    this.authUrl = process.env.SMART_ROUTER_CODEX_AUTH_URL || 'https://auth.openai.com/oauth/token';
  }
  get configData() { return this.config.data.codex; }
  get accounts() { return this.configData.accounts; }
  health(a) { return this.runtime.accounts[a.id] ||= {}; }
  event(type, a, message) { this.bus.log(type === 'auth' ? 'error' : 'info', 'codex_' + type, message, a?.id); this.bus.stateChanged(); }
  statusOf(a) {
    const h = this.health(a);
    if (!a.enabled) return 'disabled';
    if (h.auth) return 'auth';
    if (h.exhaustedUntil > Date.now()) return 'exhausted';
    if (h.cooldownUntil > Date.now()) return 'cooldown';
    if (h.exhaustedUntil) {
      h.exhaustedUntil = null;
      h.lastError = null;
      this.event('recovery', a, 'Codex 额度重置，恢复可用');
      this.state.save();
    }
    return 'ok';
  }
  ordered() {
    const all = [...this.accounts];
    if (this.configData.mode === 'pinned') {
      const index = all.findIndex((a) => a.id === this.configData.pinnedAccountId);
      if (index >= 0) all.unshift(...all.splice(index, 1));
    }
    return all;
  }
  candidates() { return this.ordered().filter((a) => this.statusOf(a) === 'ok'); }
  summary() { const list = this.candidates(); return { activeAccountId: list[0]?.id || null, accounts: this.accounts.length, available: list.length }; }
  binding(a, rows) {
    if (!a.ccSwitchId) {
      const matches = rows.filter((x) => x.accountId === a.accountId);
      if (matches.length === 1) { a.ccSwitchId = matches[0].id; this.config.save(); }
    }
    return rows.find((x) => x.id === a.ccSwitchId && x.accountId === a.accountId) || null;
  }
  syncState(a) {
    return this.health(a).syncState ||= { lastSyncAt: null, lastDirection: null, lastError: null };
  }
  syncEvent(a, direction) {
    Object.assign(this.syncState(a), { lastSyncAt: Date.now(), lastDirection: direction });
    const messages = { to_ccswitch: `已把「${a.name}」的新凭据同步到 CC Switch`,
      from_ccswitch: `已从 CC Switch 同步「${a.name}」的新凭据`,
      to_authfile: `已把「${a.name}」的新凭据同步到 auth.json`, from_authfile: `已从 auth.json 同步「${a.name}」的新凭据` };
    this.event('sync', a, messages[direction]); this.state.save();
  }
  syncFailure(a, target) {
    // Do not surface external exception messages: they can contain credentials or raw JSON.
    const message = `「${a.name}」凭据同步失败（${target}）`;
    this.syncState(a).lastError = message;
    this.bus.log('warn', 'codex_sync', message, a.id); this.bus.stateChanged(); this.state.save();
  }
  readSyncRows(accounts = this.accounts) {
    return readCcSwitchCodexAccounts(() => { for (const a of accounts) this.syncFailure(a, '读取 CC Switch'); }, true);
  }
  backupCcSwitch(file) {
    if (this.runtime.ccSwitchBackupPath) return;
    const dir = path.join(this.config.dir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const backup = path.join(dir, 'cc-switch-' + Date.now() + '.db');
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    // Preserve committed pages that have not yet been checkpointed in a WAL database.
    if (fs.existsSync(file + '-wal')) fs.copyFileSync(file + '-wal', backup + '-wal');
    this.runtime.ccSwitchBackupPath = backup;
    this.state.save(true);
  }
  syncAccount(a, rows = this.readSyncRows([a])) {
    try { this.performSync(a, rows); }
    catch { this.syncFailure(a, '同步凭据'); }
  }
  performSync(a, rows) {
    const source = this.binding(a, rows);
    if (!source || a.sync === false) return;
    this.syncState(a).lastError = null;
    const adoptNewer = (tokens, direction) => {
      if (tokenExp(tokens) > tokenExp(a.tokens)) {
        if (!tokens.access_token || !tokens.refresh_token) throw new Error('Incomplete credentials');
        this.adopt(a, { tokens }); this.health(a).auth = false; this.health(a).lastError = null;
        this.syncEvent(a, direction);
      }
    };
    adoptNewer(source.tokens, 'from_ccswitch');
    try { const auth = readAuthFile(a); if (auth) adoptNewer(auth.tokens, 'from_authfile'); }
    catch { this.syncFailure(a, '读取 auth.json'); }
    // The transactional result can itself be newer than the snapshot read above.
    const toCcSwitch = () => {
      try {
        const result = writeCcSwitch(a, (file) => this.backupCcSwitch(file));
        if (result.written) this.syncEvent(a, 'to_ccswitch');
        else adoptNewer(result.tokens, 'from_ccswitch');
      } catch { this.syncFailure(a, '写入 CC Switch'); }
    };
    // Keep read-only opens cheap when nothing needs to change.
    if (tokenExp(a.tokens) > tokenExp(source.tokens)) toCcSwitch();
    try {
      const result = writeAuthFile(a);
      if (result?.written) this.syncEvent(a, 'to_authfile');
      else if (result && tokenExp(result.tokens) > tokenExp(a.tokens)) {
        adoptNewer(result.tokens, 'from_authfile'); toCcSwitch();
      }
    } catch { this.syncFailure(a, '写入 auth.json'); }
    this.state.save();
  }
  syncAll() {
    const rows = this.readSyncRows(); // One read-only database open per tick, shared by all accounts.
    for (const a of this.accounts) this.syncAccount(a, rows);
  }
  view(a, rows = this.readSyncRows([a])) {
    const h = this.health(a), status = this.statusOf(a);
    const source = this.binding(a, rows);
    const stats = this.store.db.prepare(`SELECT COUNT(*) AS requests24h, COALESCE(SUM(input_tokens),0) AS inputTokens24h,
      COALESCE(SUM(output_tokens),0) AS outputTokens24h FROM requests WHERE kind='codex' AND provider_id=? AND ts>=?`).get(a.id, Date.now() - 86400000);
    return { id: a.id, name: a.name, email: a.email || '', planType: h.planType || a.planType || '', accountIdMasked: maskKey(a.accountId),
      enabled: a.enabled, status, statusDetail: { ok: '可用', exhausted: '额度用尽', auth: '需要重新登录', cooldown: '冷却中', disabled: '已停用' }[status],
      exhaustedUntil: h.exhaustedUntil || null, usage: h.usage || null, tokenExpiresAt: expires(a), lastUsedAt: h.lastUsedAt || null,
      lastError: h.lastError || null, stats, ccSwitchId: a.ccSwitchId || null, bound: !!source,
      sync: !!source && a.sync !== false, syncState: { ...this.syncState(a), inSync: !!source && source.tokens.access_token === a.tokens.access_token } };
  }
  status(endpoint) {
    const rows = this.readSyncRows();
    const recent = this.store.queryRequests({ kind: 'codex', limit: 30 }).map((r) => ({ ts: r.ts, accountId: r.provider_id,
      model: r.model, status: r.status, durationMs: r.duration_ms, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      note: r.attempts.map((x) => x.note).filter(Boolean).join('；') }));
    return { mode: this.configData.mode, pinnedAccountId: this.configData.pinnedAccountId, activeAccountId: this.summary().activeAccountId,
      endpoint, routerKeySet: !!this.config.settings.routerKey, accounts: this.accounts.map((a) => this.view(a, rows)), recent };
  }
  reset(a) { Object.assign(this.health(a), { auth: false, exhaustedUntil: null, cooldownUntil: null, lastError: null }); this.state.save(); this.bus.stateChanged(); }
  adopt(a, source) {
    a.tokens = { ...source.tokens };
    Object.assign(a, codexIdentity(a.tokens));
    this.config.save();
  }
  reconcile(a) {
    // Refresh tokens are single-use: only adopt CC Switch's copy when it was issued after ours (later exp; lifetimes are fixed),
    // otherwise an older copy there would replace the rotated token we just obtained.
    const source = this.binding(a, this.readSyncRows([a]));
    if (!source || a.sync === false || !source.tokens.refresh_token || tokenExp(source.tokens) <= tokenExp(a.tokens)) return false;
    this.adopt(a, source);
    this.syncEvent(a, 'from_ccswitch');
    return true;
  }
  authFailure(a) {
    const h = this.health(a);
    h.auth = true; h.lastError = '需要重新登录';
    this.state.save(); this.event('auth', a, 'Codex 认证失败，需要重新登录');
  }
  refresh(a, rejectedToken) {
    if (this.refreshes.has(a.id)) return this.refreshes.get(a.id);
    const work = (async () => {
      try {
        if (rejectedToken && a.tokens.access_token !== rejectedToken && expires(a) > Date.now()) return;
        if (this.reconcile(a) && expires(a) > Date.now() + 300000) return;
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await this.request(this.authUrl, 'POST', { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({
            client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token, scope: 'openid profile email',
          })));
          const obj = parse(await buffer(response, 1024 * 1024));
          if (response.statusCode === 200 && obj?.access_token) {
            const tokens = { ...a.tokens };
            for (const key of ['access_token', 'id_token', 'refresh_token']) if (obj[key]) tokens[key] = obj[key];
            // A periodic sync may have adopted a later rotation while the token request was in flight.
            if (tokenExp(tokens) >= tokenExp(a.tokens)) this.adopt(a, { tokens });
            this.health(a).auth = false; this.health(a).lastError = null; this.state.save();
            this.syncAccount(a);
            return;
          }
          const invalid = /invalid_grant|refresh_token_reused/.test(JSON.stringify(obj));
          if (invalid && this.reconcile(a)) {
            if (expires(a) > Date.now() + 300000) return;
            if (attempt === 0) continue;
          }
          throw fail(401, '需要重新登录');
        }
      } catch {
        this.authFailure(a);
        throw fail(401, '需要重新登录');
      }
    })();
    this.refreshes.set(a.id, work);
    work.finally(() => this.refreshes.delete(a.id)).catch(() => {});
    return work;
  }
  request(url, method, requestHeaders, body, signal) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const controller = new AbortController(); this.controllers.add(controller);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const cleanup = () => this.controllers.delete(controller);
      const r = (target.protocol === 'https:' ? https : http).request(target, { method, headers: requestHeaders, signal: combined }, (response) => {
        r.setTimeout(Math.max(1, this.config.settings.idleTimeoutSec) * 1000);
        response.once('close', cleanup);
        resolve(response);
      });
      r.setTimeout(Math.max(1, this.config.settings.firstByteTimeoutSec) * 1000, () => r.destroy(new Error('Codex upstream timeout')));
      r.once('error', cleanup);
      r.on('error', reject);
      r.end(body);
    });
  }
  async authorized(a, url, method, clientHeaders, body, signal) {
    if (expires(a) <= Date.now() + 300000) await this.refresh(a);
    const token = a.tokens.access_token;
    let response = await this.request(url, method, headers(clientHeaders, a), body, signal);
    this.readHeaders(a, response.headers);
    if (response.statusCode === 401) {
      response.destroy();
      await this.refresh(a, token);
      response = await this.request(url, method, headers(clientHeaders, a), body, signal);
      this.readHeaders(a, response.headers);
      if (response.statusCode === 401) this.authFailure(a);
    }
    return response;
  }
  readHeaders(a, input) {
    const h = this.health(a);
    const snapshot = { ...(h.usage || { primary: null, secondary: null }), updatedAt: Date.now() };
    let found = false;
    for (const kind of ['primary', 'secondary']) {
      const prefix = 'x-codex-' + kind + '-';
      if (!Object.keys(input).some((k) => k.startsWith(prefix))) continue;
      found = true;
      snapshot[kind] = windowUsage({ used_percent: input[prefix + 'used-percent'], window_minutes: input[prefix + 'window-minutes'],
        reset_at: input[prefix + 'reset-at'], reset_after_seconds: input[prefix + 'reset-after-seconds'] });
    }
    if (input['x-codex-plan-type']) h.planType = input['x-codex-plan-type'];
    if (found) h.usage = snapshot;
    this.state.save();
  }
  exhaust(a, obj, input) {
    const h = this.health(a), error = obj?.error || {};
    const at = number(error.resets_at ?? error.reset_at), seconds = number(error.resets_in_seconds ?? error.reset_after_seconds);
    const resets = ['primary', 'secondary'].map((k) => number(input['x-codex-' + k + '-reset-after-seconds'])).filter((n) => n !== null);
    h.exhaustedUntil = at !== null ? at * 1000 : Date.now() + (seconds ?? (resets.length ? Math.max(...resets) : 3600)) * 1000;
    h.lastError = '额度用尽'; h.nextProbeAt = Date.now() + 600000;
    this.state.save(); this.event('exhaustion', a, 'Codex 额度用尽');
  }
  usage(a) {
    if (this.probes.has(a.id)) return this.probes.get(a.id);
    const work = (async () => {
      try {
        const url = new URL(this.upstream); url.pathname = url.pathname.replace(/\/codex$/, '') + '/wham/usage'; url.search = '';
        const r = await this.authorized(a, url, 'GET', { accept: 'application/json' });
        const obj = parse(await buffer(r, 2 * 1024 * 1024));
        if (r.statusCode !== 200 || !obj) throw fail(502, 'Codex usage refresh failed');
        const h = this.health(a), rate = obj.rate_limit || obj.rate_limits || {};
        const primary = windowUsage(rate.primary_window || rate.primary || obj.primary_window);
        const secondary = windowUsage(rate.secondary_window || rate.secondary || obj.secondary_window);
        h.usage = { primary, secondary, updatedAt: Date.now() };
        // Preserve unknown fields privately; never expose raw auth or upstream errors to the panel.
        h.usageRaw = this.redact(obj);
        if (typeof obj.plan_type === 'string') h.planType = obj.plan_type;
        const limited = rate.allowed === false || rate.limit_reached === true || [primary, secondary].some((w) => w?.usedPercent >= 100);
        if (limited) {
          const resets = [primary, secondary].filter((w) => w?.usedPercent >= 100).map((w) => w.resetsAt).filter(Boolean);
          this.exhaust(a, { error: { resets_at: (resets.length ? Math.max(...resets) : Date.now() + 3600000) / 1000 } }, {});
        } else if (rate.allowed === true || rate.limit_reached === false || [primary, secondary].some((w) => w?.usedPercent !== null && w?.usedPercent !== undefined)) {
          const wasBad = h.exhaustedUntil;
          h.exhaustedUntil = null; h.cooldownUntil = null; h.lastError = null;
          if (wasBad) this.event('recovery', a, 'Codex 额度恢复');
        }
        this.state.save(); return this.view(a);
      } finally { this.health(a).nextProbeAt = Date.now() + 600000; this.state.save(); }
    })();
    this.probes.set(a.id, work);
    work.finally(() => this.probes.delete(a.id)).catch(() => {});
    return work;
  }
  redact(value) {
    const secrets = this.accounts.flatMap((a) => Object.values(a.tokens || {}));
    const walk = (v) => {
      if (typeof v === 'string') { for (const secret of secrets) if (secret) v = v.split(secret).join('[masked]'); return v; }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /token|authorization/i.test(k) ? '[masked]' : walk(x)]));
      return v;
    };
    return walk(value);
  }
  start() {
    this.timer = setInterval(() => this.tick(), 15000);
    this.timer.unref();
    this.syncTimer = setInterval(() => this.syncAll(), 120000);
    this.syncTimer.unref();
  }
  tick() {
    for (const a of this.accounts) {
      const h = this.health(a);
      if (a.enabled && !h.auth && h.exhaustedUntil && (h.nextProbeAt || 0) <= Date.now()) this.usage(a).catch(() => {});
    }
  }
  async stop() {
    clearInterval(this.timer);
    clearInterval(this.syncTimer);
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.probes.values(), ...this.refreshes.values()]);
  }
  async api(method, parts, body, endpoint) {
    const [route, id, action] = parts;
    if (method === 'GET' && route === 'status') return this.status(endpoint);
    if (method === 'GET' && route === 'ccswitch') return readCcSwitchCodexAccounts().map((a) => {
      const imported = this.accounts.find((x) => x.accountId === a.accountId);
      return { id: a.id, name: a.name, email: a.email, planType: a.planType, accountIdMasked: maskKey(a.accountId),
        isCurrent: a.isCurrent, imported: !!imported, importedAs: imported?.id || null };
    });
    if (method === 'POST' && route === 'import') {
      if (!Array.isArray(body.ids)) throw fail(400, 'ids must be an array');
      let added = 0, updated = 0;
      for (const source of readCcSwitchCodexAccounts().filter((a) => body.ids.includes(a.id))) {
        let a = this.accounts.find((x) => x.accountId === source.accountId);
        if (a) { if (tokenExp(source.tokens) > tokenExp(a.tokens)) this.adopt(a, source); this.reset(a); updated++; }
        else { a = { id: 'cx_' + randomId(6), name: source.name, email: source.email, planType: source.planType,
          accountId: source.accountId, tokens: source.tokens, enabled: true }; this.accounts.push(a); added++; }
        a.ccSwitchId = source.id;
      }
      this.config.save(); return { added, updated };
    }
    if (method === 'PUT' && route === 'settings') {
      const next = { ...this.configData, ...body };
      if (!['auto', 'pinned'].includes(next.mode)) throw fail(400, 'Invalid mode');
      if (next.pinnedAccountId !== null && !this.accounts.some((a) => a.id === next.pinnedAccountId)) throw fail(400, 'Unknown pinned account');
      if (next.mode === 'pinned' && !next.pinnedAccountId) throw fail(400, 'Pinned account required');
      this.configData.mode = next.mode; this.configData.pinnedAccountId = next.pinnedAccountId;
      this.config.save(); return this.status(endpoint);
    }
    if (method === 'PUT' && route === 'order') {
      if (!Array.isArray(body.ids) || body.ids.length !== this.accounts.length || new Set(body.ids).size !== this.accounts.length || body.ids.some((id) => !this.accounts.some((a) => a.id === id))) throw fail(400, 'Full account order required');
      this.configData.accounts = body.ids.map((id) => this.accounts.find((a) => a.id === id));
      this.config.save(); return this.status(endpoint);
    }
    if (route === 'accounts' && id) {
      const a = this.accounts.find((x) => x.id === id);
      if (!a) throw fail(404, 'Account not found');
      if (method === 'POST' && action === 'usage') return this.usage(a);
      if (method === 'POST' && action === 'reset') { this.reset(a); return this.view(a); }
      if (method === 'POST' && action === 'sync') { this.syncAccount(a); return this.view(a); }
      if (method === 'PATCH' && !action) {
        if ('enabled' in body && typeof body.enabled !== 'boolean') throw fail(400, 'enabled must be boolean');
        if ('name' in body && (typeof body.name !== 'string' || !body.name.trim())) throw fail(400, 'name required');
        if ('sync' in body && typeof body.sync !== 'boolean') throw fail(400, 'sync must be boolean');
        if (body.sync === true && !this.binding(a, this.readSyncRows([a]))) throw fail(400, 'Account is not bound to CC Switch');
        if ('enabled' in body) a.enabled = body.enabled;
        if ('name' in body) a.name = body.name.trim();
        if ('sync' in body) a.sync = body.sync;
        if (body.sync === true) this.syncAccount(a);
        this.config.save(); return this.view(a);
      }
      if (method === 'DELETE' && !action) {
        this.configData.accounts = this.accounts.filter((x) => x.id !== id);
        if (this.configData.pinnedAccountId === id) { this.configData.mode = 'auto'; this.configData.pinnedAccountId = null; }
        delete this.runtime.accounts[id]; this.state.save(); this.config.save(); return { ok: true };
      }
    }
    throw fail(404, 'not found');
  }
  async handle(req, res, url) {
    const row = { ts: Date.now(), kind: 'codex', attempts: [], status: 500 };
    const controller = new AbortController(); this.controllers.add(controller);
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    res.on('close', abort);
    try {
      if (!this.checkKey(req)) { row.status = 401; return send(res, 401, { error: { type: 'authentication_error', message: 'Invalid router key' } }); }
      let bodyBuf = await buffer(req), body = parse(bodyBuf);
      if (/^\/codex\/v1\/responses\/?$/.test(url.pathname) && req.method === 'POST') {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Invalid responses JSON');
        body.store = false; bodyBuf = Buffer.from(JSON.stringify(body));
      }
      row.model = typeof body?.model === 'string' ? body.model : null; row.stream = !!body?.stream;
      const target = this.upstream + '/' + url.pathname.slice('/codex/v1/'.length) + url.search;
      const attempted = new Set();
      let previous = this.runtime.activeAccountId, reason = '账号切换', stripped = false;
      if (this.configData.mode === 'pinned' && !previous) previous = this.configData.pinnedAccountId;
      const pinned = this.accounts.find((a) => a.id === this.configData.pinnedAccountId);
      if (this.configData.mode === 'pinned' && pinned && this.statusOf(pinned) !== 'ok') {
        row.attempts.push({ accountId: pinned.id, note: '锁定账号不可用，按优先级回退' });
      }
      for (const a of this.ordered()) {
        if (this.statusOf(a) !== 'ok' || attempted.has(a.id)) continue;
        attempted.add(a.id); row.providerId = a.id;
        const switched = previous && previous !== a.id;
        if (switched) {
          const note = `${reason} ${this.accounts.find((x) => x.id === previous)?.name || previous} → ${a.name}`;
          row.attempts.push({ accountId: a.id, note }); this.event('switch', a, note);
        }
        previous = a.id;
        const h = this.health(a); h.lastUsedAt = Date.now(); this.state.save();
        try {
          let r = await this.authorized(a, target, req.method, req.headers, bodyBuf, controller.signal);
          let raw = null;
          if (r.statusCode >= 400) raw = await buffer(r, 4 * 1024 * 1024);
          if (switched && !stripped && r.statusCode === 400 && /encrypted[ _-]content|could not be decrypted|cannot be decrypted/i.test(raw.toString()) && Array.isArray(body?.input)) {
            const input = body.input.filter((item) => !(item?.type === 'reasoning' && item.encrypted_content));
            if (input.length !== body.input.length) {
              stripped = true; body = { ...body, input }; bodyBuf = Buffer.from(JSON.stringify(body));
              r = await this.authorized(a, target, req.method, req.headers, bodyBuf, controller.signal);
              raw = r.statusCode >= 400 ? await buffer(r, 4 * 1024 * 1024) : null;
            }
          }
          const obj = raw && parse(raw), code = obj?.error?.type || obj?.error?.code || '';
          row.attempts.push({ accountId: a.id, status: r.statusCode });
          if ([402, 403, 429].includes(r.statusCode) && /usage_limit|usage_not_included|plan_limit|quota|plan.*(?:required|not_supported|not_included)|(?:insufficient|exhausted).*usage/i.test(code)) {
            this.exhaust(a, obj, r.headers); reason = '额度用尽，切换'; continue;
          }
          if (r.statusCode === 401) { reason = '认证失败，切换'; continue; }
          if (r.statusCode === 429 || r.statusCode >= 500) {
            const retry = r.headers['retry-after'];
            const sec = number(retry) ?? (Number.isFinite(Date.parse(retry)) ? Math.max(0, (Date.parse(retry) - Date.now()) / 1000) : this.config.settings.cooldownSec);
            h.cooldownUntil = Date.now() + sec * 1000; h.lastError = r.statusCode === 429 ? '请求限流' : '上游服务异常';
            this.state.save(); reason = '上游暂不可用，切换'; continue;
          }
          row.status = r.statusCode; row.ok = r.statusCode < 400;
          if (row.ok) { this.runtime.activeAccountId = a.id; h.lastError = null; this.state.save(); }
          res.writeHead(r.statusCode, headers(r.headers)); res.flushHeaders();
          if (raw) return res.end(raw);
          if (String(r.headers['content-type']).includes('text/event-stream') || (row.stream && !r.headers['content-type'])) await pipeline(r, new UsageScanner(row), res);
          else {
            // Observe small JSON responses while continuing to forward each chunk immediately.
            let collected = [], size = 0;
            const observer = new Transform({ transform(chunk, enc, cb) {
              size += chunk.length; if (size <= 2 * 1024 * 1024) collected.push(chunk); else collected = [];
              cb(null, chunk);
            } });
            await pipeline(r, observer, res);
            if (collected.length) recordUsage(row, parse(Buffer.concat(collected))?.usage);
          }
          return;
        } catch (e) {
          if (res.headersSent || controller.signal.aborted) throw e;
          if (!h.auth) { h.cooldownUntil = Date.now() + this.config.settings.cooldownSec * 1000; h.lastError = '上游连接失败'; this.state.save(); }
          row.attempts.push({ accountId: a.id, status: h.auth ? 401 : 502 }); reason = h.auth ? '认证失败，切换' : '连接失败，切换';
        }
      }
      row.status = 429; row.providerId = null;
      const resets = this.accounts.filter((a) => a.enabled && !this.health(a).auth).flatMap((a) => [this.health(a).exhaustedUntil, this.health(a).cooldownUntil]).filter((v) => v > Date.now());
      const earliest = resets.length ? Math.min(...resets) : null;
      send(res, 429, { error: { type: 'usage_limit_reached', message: 'No Codex accounts available' + (earliest ? '; earliest reset: ' + new Date(earliest).toISOString() : ''),
        resets_at: earliest ? Math.ceil(earliest / 1000) : null } });
    } catch (e) {
      row.ok = false; row.status = res.headersSent ? row.status : e.status || 502;
      row.error = controller.signal.aborted ? 'Client disconnected' : 'Codex request failed';
      if (!res.headersSent && !res.destroyed) send(res, row.status, { error: { type: 'router_error', message: row.error } });
      else res.destroy();
    } finally {
      res.off('close', abort); this.controllers.delete(controller);
      row.durationMs = Date.now() - row.ts;
      row.id = this.store.addRequest(row); this.bus.request(row);
    }
  }
}

module.exports = { CodexRouter };
