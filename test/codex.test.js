'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/server');

const KEY = 'router-test-secret';
const jwt = (claims) => 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
const access = (tag, seconds = 7200) => jwt({ exp: Math.floor(Date.now() / 1000) + seconds, tag });
function account(id, seconds = 7200) {
  return { id, name: id, accountId: 'chatgpt-account-' + id, enabled: true,
    tokens: { access_token: access(id, seconds), refresh_token: 'refresh-secret-' + id,
      id_token: jwt({ email: id + '@test.invalid', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'chatgpt-account-' + id } }), account_id: 'chatgpt-account-' + id } };
}
// A copy rotated elsewhere (e.g. by Codex/CC Switch) after ours: new refresh token, later iat.
function rotated(id, tag = 'rotated-' + id) {
  const a = account(id);
  const now = Math.floor(Date.now() / 1000);
  a.tokens.access_token = jwt({ iat: now + 60, exp: now + 7200 + 60, tag });
  a.tokens.refresh_token = 'refresh-rotated-' + id;
  return a;
}
const json = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const success = (ctx, res) => json(res, 200, { account: ctx.headers['chatgpt-account-id'], usage: { input_tokens: 7, output_tokens: 3 } });
async function setup(t, behavior = success, { accounts = [account('A'), account('B')], codex = {}, settings = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-codex-'));
  const env = Object.fromEntries(['CC_SWITCH_DB', 'SMART_ROUTER_CODEX_UPSTREAM', 'SMART_ROUTER_CODEX_AUTH_URL', 'SMART_ROUTER_CODEX_AUTH_FILE'].map((k) => [k, process.env[k]]));
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks); let body;
      try { body = JSON.parse(raw); } catch {}
      const ctx = { path: req.url, method: req.method, headers: req.headers, body, raw };
      calls.push(ctx); await fixture.behavior(ctx, res);
    } catch { if (!res.destroyed) res.destroy(); }
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;
  process.env.CC_SWITCH_DB = path.join(dir, 'cc-switch.db');
  process.env.SMART_ROUTER_CODEX_AUTH_FILE = path.join(dir, 'auth.json');
  process.env.SMART_ROUTER_CODEX_UPSTREAM = upstreamUrl + '/backend-api/codex';
  process.env.SMART_ROUTER_CODEX_AUTH_URL = upstreamUrl + '/oauth/token';
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ settings: { routerKey: KEY, ...settings }, providers: [], codex: { mode: 'auto', pinnedAccountId: null, accounts, ...codex } }));
  const app = createApp({ dataDir: dir });
  const addr = await app.listen(0, '127.0.0.1');
  const fixture = { app, calls, behavior, dir, base: 'http://127.0.0.1:' + addr.port };
  t.after(async () => {
    await app.close(); upstream.closeAllConnections(); await new Promise((r) => upstream.close(r));
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return fixture;
}
async function request(f, body = { model: 'gpt-test', input: 'hi', stream: false }, endpoint = '/codex/v1/responses', options = {}) {
  return fetch(f.base + endpoint, { method: 'POST', headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json', ...options.headers }, body: JSON.stringify(body), ...options });
}
async function panel(f, endpoint = '/status', method = 'GET', body) {
  const res = await fetch(f.base + '/api/codex' + endpoint, { method, headers: { 'x-panel': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const rowFor = async (f, id) => (await panel(f)).data.accounts.find((a) => a.id === id);
const RELAY_KEY = 'sk-relay-test-secret-9f2c';
async function addRelay(f, fields = {}) {
  const result = await panel(f, '/relays', 'POST', { name: 'relay C', baseUrl: process.env.SMART_ROUTER_CODEX_UPSTREAM.replace('/backend-api/codex', '/relay/v1/'), apiKey: RELAY_KEY, ...fields });
  assert.equal(result.status, 200); return result.data;
}
function fixtureDb(f, accounts) {
  const file = path.join(f.dir, 'cc-switch.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT, app_type TEXT, settings_config TEXT, is_current INTEGER)');
  const stmt = db.prepare('INSERT OR REPLACE INTO providers VALUES (?,?,?,?,?)');
  for (const a of accounts) stmt.run(a.id, a.name, 'codex', JSON.stringify({ auth: { auth_mode: 'chatgpt', tokens: a.tokens } }), 1);
  db.close(); return file;
}

test('Codex streams bytes immediately, replaces auth, preserves client headers and scans final usage', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  t.after(() => release());
  const f = await setup(t, async (c, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '12.5', 'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '120', 'x-codex-secondary-used-percent': 'bad', 'x-codex-plan-type': 'pro' });
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n');
    await gate;
    const final = 'event: response.completed\r\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":42,"output_tokens":9}}}\r\n\r\n';
    res.write(final.slice(0, 90)); res.end(final.slice(90));
  });
  const logged = new Promise((r) => f.app.bus.on('push', (msg) => { if (msg.kind === 'request') r(msg.data); }));
  const res = await request(f, { model: 'exact-model', input: 'hello', stream: true, store: true }, '/codex/v1/responses?x=1', {
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json', originator: 'codex_cli_rs', version: '1.2', 'user-agent': 'codex-test', session_id: 'session', conversation_id: 'conversation',
      'openai-beta': 'responses=experimental', 'x-codex-feature': 'yes', accept: 'text/event-stream', 'x-api-key': KEY },
  });
  const reader = res.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(), /hello/);
  release(); while (!(await reader.read()).done) {}
  const row = await logged;
  assert.equal(row.kind, 'codex'); assert.equal(row.providerId, 'A'); assert.equal(row.inputTokens, 42); assert.equal(row.outputTokens, 9);
  const c = f.calls[0];
  assert.equal(c.path, '/backend-api/codex/responses?x=1'); assert.equal(c.body.store, false); assert.equal(c.body.model, 'exact-model');
  assert.equal(c.headers.authorization, 'Bearer ' + f.app.config.data.codex.accounts[0].tokens.access_token);
  assert.equal(c.headers['chatgpt-account-id'], 'chatgpt-account-A');
  for (const key of ['originator', 'version', 'user-agent', 'session_id', 'conversation_id', 'openai-beta', 'x-codex-feature', 'accept']) assert.equal(c.headers[key], key === 'accept' ? 'text/event-stream' : ({ originator: 'codex_cli_rs', version: '1.2', 'user-agent': 'codex-test', session_id: 'session', conversation_id: 'conversation', 'openai-beta': 'responses=experimental', 'x-codex-feature': 'yes' })[key]);
  assert.equal(c.headers['x-api-key'], undefined);
  const status = (await panel(f)).data;
  assert.equal(status.endpoint, f.base + '/codex/v1'); assert.equal(status.accounts[0].usage.primary.usedPercent, 12.5);
  assert.equal(status.accounts[0].usage.secondary.usedPercent, null); assert.equal(status.accounts[0].planType, 'pro');
  assert.equal(status.accounts[0].stats.inputTokens24h, 42); assert.equal(status.recent[0].outputTokens, 9);
  assert.ok(!JSON.stringify(status).includes('refresh-secret')); assert.ok(!JSON.stringify(status).includes('eyJhbG'));
});

test('usage limit transparently fails over, logs switch, returns to priority A after reset', async (t) => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const f = await setup(t, (c, res) => c.headers['chatgpt-account-id'].endsWith('A')
    ? json(res, 429, { error: { type: 'usage_limit_reached', resets_at: reset } }) : success(c, res));
  assert.equal((await (await request(f)).json()).account, 'chatgpt-account-B');
  assert.equal((await rowFor(f, 'A')).exhaustedUntil, reset * 1000);
  assert.equal((await rowFor(f, 'A')).status, 'exhausted');
  assert.match((await panel(f)).data.recent[0].note, /额度用尽，切换 A → B/);
  f.app.codex.health(f.app.codex.accounts[0]).exhaustedUntil = Date.now() - 1;
  f.behavior = success;
  assert.equal((await (await request(f)).json()).account, 'chatgpt-account-A');
  assert.equal((await rowFor(f, 'A')).status, 'ok');
  const events = f.app.store.queryEvents({}).map((e) => e.type);
  for (const type of ['codex_switch', 'codex_exhaustion', 'codex_recovery']) assert.ok(events.includes(type));
});

test('pinned mode prefers pinned account and records fallback when exhausted', async (t) => {
  const f = await setup(t, success, { codex: { mode: 'pinned', pinnedAccountId: 'B' } });
  assert.equal((await (await request(f)).json()).account, 'chatgpt-account-B');
  f.behavior = (c, r) => c.headers['chatgpt-account-id'].endsWith('B') ? json(r, 429, { error: { type: 'usage_not_included', resets_in_seconds: 100 } }) : success(c, r);
  assert.equal((await (await request(f)).json()).account, 'chatgpt-account-A');
  assert.match((await panel(f)).data.recent[0].note, /B → A/);
  f.app.codex.health(f.app.codex.accounts[1]).exhaustedUntil = Date.now() - 1;
  f.behavior = success;
  assert.equal((await (await request(f)).json()).account, 'chatgpt-account-B');
});

for (const nearExpiry of [true, false]) test('token refresh single-flight ' + (nearExpiry ? 'near expiry' : 'on concurrent 401'), async (t) => {
  const a = account('A', nearExpiry ? 60 : 7200), next = access('rotated'); let refreshes = 0;
  const f = await setup(t, async (c, r) => {
    if (c.path === '/oauth/token') {
      refreshes++; assert.deepEqual(c.body, { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token, scope: 'openid profile email' });
      await new Promise((resolve) => setTimeout(resolve, 25));
      return json(r, 200, { access_token: next, refresh_token: 'rotated-refresh', id_token: a.tokens.id_token });
    }
    if (c.headers.authorization !== 'Bearer ' + next) return json(r, 401, { error: { type: 'invalid_token' } });
    success(c, r);
  }, { accounts: [a] });
  const responses = await Promise.all(Array.from({ length: 5 }, async () => { const r = await request(f); await r.text(); return r.status; }));
  assert.deepEqual(responses, [200, 200, 200, 200, 200]); assert.equal(refreshes, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'config.json'))).codex.accounts[0];
  assert.equal(saved.tokens.access_token, next); assert.equal(saved.tokens.refresh_token, 'rotated-refresh');
});

test('refresh adopts newer CC Switch tokens before refreshing and never writes its database', async (t) => {
  const f = await setup(t, success, { accounts: [account('A', -1)] });
  const newer = rotated('A'); fixtureDb(f, [newer]);
  const original = fs.readFileSync(process.env.CC_SWITCH_DB);
  assert.equal((await request(f)).status, 200);
  assert.equal(f.calls.filter((c) => c.path === '/oauth/token').length, 0);
  assert.equal(f.calls[0].headers.authorization, 'Bearer ' + newer.tokens.access_token);
  assert.deepEqual(fs.readFileSync(process.env.CC_SWITCH_DB), original);
});

test('invalid_grant rereads CC Switch and recovers a concurrent rotation', async (t) => {
  let f, refreshes = 0;
  const newer = rotated('A');
  f = await setup(t, (c, r) => {
    if (c.path === '/oauth/token') { refreshes++; fixtureDb(f, [newer]); return json(r, 400, { error: 'invalid_grant', error_description: 'refresh_token_reused' }); }
    success(c, r);
  }, { accounts: [account('A', -1)] });
  assert.equal((await request(f)).status, 200); assert.equal(refreshes, 1);
  assert.equal(f.app.codex.accounts[0].tokens.access_token, newer.tokens.access_token);
});

test('401 adopts a fresh CC Switch rotation and retries once without refreshing', async (t) => {
  const initial = account('A'), newer = rotated('A', 'newer');
  const f = await setup(t, (c, r) => c.headers.authorization === 'Bearer ' + newer.tokens.access_token ? success(c, r) : json(r, 401, { error: { type: 'expired' } }), { accounts: [initial] });
  fixtureDb(f, [newer]);
  assert.equal((await request(f)).status, 200); assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => c.path !== '/oauth/token'));
});

test('an older CC Switch copy never replaces tokens the router already rotated', async (t) => {
  const mine = rotated('A');
  const f = await setup(t, (c, r) => c.headers.authorization === 'Bearer ' + mine.tokens.access_token ? success(c, r) : json(r, 401, { error: { type: 'expired' } }), { accounts: [mine] });
  fixtureDb(f, [account('A')]); // stale: earlier token, old (already spent) refresh token
  assert.equal(f.app.codex.reconcile(f.app.codex.accounts[0]), false);
  assert.equal((await request(f)).status, 200);
  assert.equal(f.app.codex.accounts[0].tokens.refresh_token, mine.tokens.refresh_token);
});

test('refresh keeps an unrotated refresh token; second 401 marks auth and skips to B', async (t) => {
  const a = account('A'); let refreshes = 0;
  const f = await setup(t, (c, r) => {
    if (c.path === '/oauth/token') { refreshes++; return json(r, 200, { access_token: access('rejected-new') }); }
    if (c.headers['chatgpt-account-id'].endsWith('A')) return json(r, 401, { error: { type: 'unauthorized' } });
    success(c, r);
  }, { accounts: [a, account('B')] });
  // Identical tokens in a different property order must not suppress refresh on 401.
  fixtureDb(f, [a]);
  assert.equal((await (await request(f)).json()).account, 'chatgpt-account-B');
  assert.equal(refreshes, 1); assert.equal((await rowFor(f, 'A')).status, 'auth');
  assert.equal(f.app.codex.accounts[0].tokens.refresh_token, a.tokens.refresh_token);
  assert.equal(f.calls.filter((c) => c.headers['chatgpt-account-id']?.endsWith('A')).length, 2);
});

test('refresh failure marks auth and skips the account on later requests; reset clears it', async (t) => {
  const f = await setup(t, (c, r) => c.path === '/oauth/token' ? json(r, 400, { error: 'invalid_grant', secret: 'refresh-secret-A' }) : success(c, r), { accounts: [account('A', -1), account('B')] });
  for (let n = 0; n < 2; n++) assert.equal((await (await request(f)).json()).account, 'chatgpt-account-B');
  assert.equal(f.calls.filter((c) => c.path === '/oauth/token').length, 1);
  assert.equal((await rowFor(f, 'A')).status, 'auth'); assert.equal((await rowFor(f, 'A')).statusDetail, '需要重新登录');
  assert.ok(!JSON.stringify((await panel(f)).data).includes('refresh-secret'));
  assert.equal((await panel(f, '/accounts/A/reset', 'POST', {})).data.status, 'ok');
});

test('encrypted reasoning is removed only after switched-account decryption error, retrying same account once', async (t) => {
  const f = await setup(t, (c, r) => {
    if (c.headers['chatgpt-account-id'].endsWith('A')) return json(r, 429, { error: { type: 'usage_limit_reached' } });
    if (c.body.input.some((i) => i.encrypted_content)) return json(r, 400, { error: { type: 'invalid_encrypted_content', message: 'could not be decrypted' } });
    success(c, r);
  });
  const input = [{ type: 'reasoning', encrypted_content: 'cipher' }, { role: 'user', content: 'hi' }, { type: 'reasoning', summary: [] }];
  assert.equal((await request(f, { model: 'm', input })).status, 200);
  assert.equal(f.calls.length, 3); assert.deepEqual(f.calls[0].body.input, input); assert.deepEqual(f.calls[1].body.input, input);
  assert.deepEqual(f.calls[2].body.input, input.slice(1)); assert.equal(f.calls[2].headers['chatgpt-account-id'], 'chatgpt-account-B');
});

test('ordinary 400 and same-account encrypted errors pass through without retry', async (t) => {
  const f = await setup(t, (c, r) => json(r, 400, { error: { type: 'invalid_encrypted_content', message: 'encrypted content' } }));
  const r = await request(f, { input: [{ type: 'reasoning', encrypted_content: 'cipher' }] });
  assert.equal(r.status, 400); assert.equal((await r.json()).error.type, 'invalid_encrypted_content'); assert.equal(f.calls.length, 1);
});

test('all exhausted forwards the final upstream quota response unchanged', async (t) => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const f = await setup(t, (c, r) => json(r, 429, { error: { type: 'usage_limit_reached', resets_at: c.headers['chatgpt-account-id'].endsWith('A') ? reset : reset + 100 } }));
  const r = await request(f); assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { error: { type: 'usage_limit_reached', resets_at: reset + 100 } });
  const cooldown = await request(f); assert.equal(cooldown.status, 503);
  assert.equal((await cooldown.json()).error.type, 'router_unavailable');
  assert.equal(f.calls.length, 2);
});

for (const status of [400, 401, 402, 403, 429, 500, 503]) test('forwards original upstream error status, headers and bytes: ' + status, async (t) => {
  const raw = '  {"error":{"type":"original_upstream_error","code":"original_code","message":"original message"},"extra":true}\n';
  const f = await setup(t, (c, r) => {
    if (c.path === '/oauth/token') return json(r, 400, { error: 'invalid_grant' });
    r.writeHead(status, { 'content-type': 'application/problem+json', 'retry-after': '17', 'x-request-id': 'original-request-id' });
    r.end(raw);
  }, { accounts: [account('A')] });
  const r = await request(f);
  assert.equal(r.status, status); assert.equal(await r.text(), raw);
  assert.equal(r.headers.get('content-type'), 'application/problem+json');
  assert.equal(r.headers.get('retry-after'), '17');
  assert.equal(r.headers.get('x-request-id'), 'original-request-id');
});

test('connection failure is local 502 and cooldown is local 503, neither claims quota', async (t) => {
  const standby = account('B'); standby.enabled = false;
  const f = await setup(t, (c, r) => r.destroy(), { accounts: [account('A'), standby] });
  const router = f.app.codex, a = router.accounts[0];
  router.health(a).usage = { primary: { usedPercent: 40 }, secondary: { usedPercent: 20 } };
  for (let i = 0; i < 2; i++) {
    const r = await request(f); const body = await r.json();
    assert.equal(r.status, i ? 503 : 502);
    assert.equal(body.error.type, i ? 'router_unavailable' : 'router_connection_error');
    assert.equal(body.error.resets_at, undefined);
    assert.doesNotMatch(body.error.message, /quota|earliest reset/);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(router.health(a).usage.primary.usedPercent, 40);
  const rows = f.app.store.queryRequests({ kind: 'codex' });
  assert.equal(rows[0].attempts.length, 0);
  assert.equal(rows[1].attempts[0].status, 502);
  assert.match(rows[1].attempts[0].note, /ECONNRESET/);
  router.health(a).cooldownUntil = Date.now() - 1; f.behavior = success;
  assert.equal((await request(f)).status, 200);
});

test('empty pool reports local unavailability without claiming an upstream quota error', async (t) => {
  const f = await setup(t, success, { accounts: [] });
  const r = await request(f); assert.equal(r.status, 503);
  assert.equal((await r.json()).error.type, 'router_unavailable');
  assert.equal(f.calls.length, 0);
});

test('plain 429, 5xx and network failures cool down and switch; quota header fallback is honored', async (t) => {
  const f = await setup(t);
  for (const status of [429, 503, 0]) {
    for (const a of f.app.codex.accounts) f.app.codex.reset(a);
    f.behavior = (c, r) => {
      if (c.headers['chatgpt-account-id'].endsWith('B')) return success(c, r);
      if (!status) return r.destroy();
      json(r, status, { error: { type: 'rate_limit_error' } }, { 'retry-after': '12' });
    };
    assert.equal((await (await request(f)).json()).account, 'chatgpt-account-B');
    assert.equal((await rowFor(f, 'A')).status, 'cooldown');
  }
  f.app.codex.reset(f.app.codex.accounts[0]);
  f.behavior = (c, r) => c.headers['chatgpt-account-id'].endsWith('A') ? json(r, 429, { error: { type: 'usage_not_included' } }, { 'x-codex-primary-reset-after-seconds': '17' }) : success(c, r);
  const start = Date.now(); await (await request(f)).text();
  const until = (await rowFor(f, 'A')).exhaustedUntil;
  assert.ok(until >= start + 17000 && until <= Date.now() + 17000);
});

test('usage endpoint and exhausted prober recover quota without inference; unknown usage is preserved privately', async (t) => {
  let full = true;
  const f = await setup(t, (c, r) => {
    assert.equal(c.path, '/backend-api/wham/usage');
    json(r, 200, { plan_type: 'plus', unknown: { future: true, access_token: 'secret' }, rate_limit: { allowed: !full,
      primary_window: { used_percent: full ? 100 : 5, limit_window_seconds: 18000, reset_after_seconds: 200 }, secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 1900000000 } } });
  });
  let r = await panel(f, '/accounts/A/usage', 'POST', {});
  assert.equal(r.data.status, 'exhausted'); assert.equal(r.data.usage.primary.windowMinutes, 300);
  assert.equal(r.data.usage.secondary.resetsAt, 1900000000000);
  assert.equal(f.app.codex.health(f.app.codex.accounts[0]).usageRaw.unknown.access_token, '[masked]');
  full = false;
  f.app.codex.health(f.app.codex.accounts[0]).nextProbeAt = 0;
  f.app.codex.tick();
  await f.app.codex.probes.get('A');
  r = await rowFor(f, 'A');
  assert.equal(r.status, 'ok'); assert.equal(r.exhaustedUntil, null);
  assert.ok(f.calls.every((c) => c.path.endsWith('/wham/usage')));
});

test('healthy and exhausted accounts refresh quota every five minutes, coalescing probes and skipping disabled/auth accounts', async (t) => {
  const f = await setup(t, (c, r) => {
    assert.equal(c.path, '/backend-api/wham/usage');
    json(r, 200, { rate_limit: { allowed: true, primary_window: { used_percent: 25 } } });
  }, { accounts: ['A', 'B', 'C', 'D'].map((id) => account(id)) });
  const router = f.app.codex;
  router.accounts[2].enabled = false;
  router.health(router.accounts[3]).auth = true;
  router.health(router.accounts[1]).exhaustedUntil = Date.now() + 3600000;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const refresh = async () => {
    router.tick(); router.tick();
    await Promise.all([...router.probes.values()]);
  };
  await refresh();
  assert.equal(f.calls.length, 2);
  assert.equal(router.health(router.accounts[0]).usage.primary.usedPercent, 25);
  assert.equal(router.health(router.accounts[1]).exhaustedUntil, null);
  assert.equal(router.health(router.accounts[0]).nextProbeAt, now + 300000);
  now += 299999;
  await refresh(); assert.equal(f.calls.length, 2);
  now += 1;
  await refresh(); assert.equal(f.calls.length, 4);
});

test('failed quota refresh waits five minutes before retrying', async (t) => {
  const f = await setup(t, (c, r) => json(r, 503, {}), { accounts: [account('A')] });
  const router = f.app.codex;
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  router.tick(); await Promise.allSettled([...router.probes.values()]);
  assert.equal(router.health(router.accounts[0]).nextProbeAt, now + 300000);
  router.tick(); assert.equal(f.calls.length, 1);
  now += 300000;
  router.tick(); await Promise.allSettled([...router.probes.values()]);
  assert.equal(f.calls.length, 2);
});

for (const [status, error] of [
  [403, { type: 'upstream_error', code: 'insufficient_quota' }],
  [402, { message: 'Insufficient credit balance' }],
  [400, { type: 'upstream_error', code: 'usage_limit_reached' }],
  [403, { type: 'upstream_error', code: 'token_expired' }],
]) test('account failure retries the same request on B: ' + status + ' ' + JSON.stringify(error), async (t) => {
  const f = await setup(t, (c, r) => c.headers['chatgpt-account-id'].endsWith('A') ? json(r, status, { error }) : success(c, r));
  const input = { model: 'gpt-test', input: [{ role: 'user', content: 'preserve me' }], stream: false };
  const res = await request(f, input);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).account, 'chatgpt-account-B');
  assert.deepEqual(f.calls.map((c) => c.headers['chatgpt-account-id']), ['chatgpt-account-A', 'chatgpt-account-B']);
  assert.deepEqual(f.calls[1].body.input, input.input);
  assert.equal((await rowFor(f, 'A')).status, error.code === 'token_expired' ? 'auth' : 'exhausted');
});

test('panel imports read-only OAuth entries, deduplicates account id, orders and manages accounts with panel protection', async (t) => {
  const f = await setup(t, success, { accounts: [] });
  const a = account('source-A'), b = account('source-B'); fixtureDb(f, [a, b]);
  const db = new DatabaseSync(process.env.CC_SWITCH_DB);
  db.prepare('INSERT INTO providers VALUES (?,?,?,?,?)').run('api-key', 'API key', 'codex', JSON.stringify({ auth: { auth_mode: 'apikey', OPENAI_API_KEY: 'secret' } }), 0);
  const malformed = account('malformed'); malformed.tokens.id_token = jwt(null);
  db.prepare('INSERT INTO providers VALUES (?,?,?,?,?)').run(malformed.id, malformed.name, 'codex', JSON.stringify({ auth: { auth_mode: 'chatgpt', tokens: malformed.tokens } }), 0);
  db.close();
  const original = fs.readFileSync(process.env.CC_SWITCH_DB);
  let list = (await panel(f, '/ccswitch')).data;
  assert.equal(list.length, 3); assert.equal(list[0].email, 'source-A@test.invalid'); assert.equal(list[0].planType, 'plus'); assert.equal(list[0].imported, false);
  assert.equal(list[2].email, '');
  assert.ok(!JSON.stringify(list).includes('refresh-secret')); assert.ok(!JSON.stringify(list).includes('eyJhbG'));
  assert.deepEqual((await panel(f, '/import', 'POST', { ids: [a.id, b.id] })).data, { added: 2, updated: 0 });
  list = (await panel(f, '/ccswitch')).data; assert.equal(list[0].imported, true);
  assert.deepEqual((await panel(f, '/import', 'POST', { ids: [a.id] })).data, { added: 0, updated: 1 });
  const ids = (await panel(f)).data.accounts.map((a) => a.id);
  assert.equal((await panel(f, '/order', 'PUT', { ids: [ids[1], ids[0]] })).status, 200);
  assert.deepEqual((await panel(f)).data.accounts.map((a) => a.id), [ids[1], ids[0]]);
  assert.equal((await panel(f, '/order', 'PUT', { ids: [ids[0], ids[0]] })).status, 400);
  assert.equal((await panel(f, '/settings', 'PUT', { mode: 'pinned', pinnedAccountId: ids[0] })).status, 200);
  assert.equal((await panel(f)).data.activeAccountId, ids[0]);
  assert.equal((await panel(f, '/settings', 'PUT', { mode: 'invalid' })).status, 400);
  assert.equal((await panel(f, '/accounts/' + ids[0], 'PATCH', { enabled: false, name: 'Renamed' })).data.status, 'disabled');
  const dock = await (await fetch(f.base + '/api/status')).json(); assert.equal(dock.codex.accounts, 2); assert.equal(dock.codex.available, 1);
  const forbidden = await fetch(f.base + '/api/codex/settings', { method: 'PUT', body: '{}' }); assert.equal(forbidden.status, 403);
  assert.deepEqual(fs.readFileSync(process.env.CC_SWITCH_DB), original);
  assert.equal((await panel(f, '/accounts/' + ids[0], 'DELETE')).status, 200); assert.equal((await panel(f)).data.mode, 'auto');
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'config.json'))); assert.equal(saved.codex.accounts.length, 1); assert.deepEqual(saved.providers, []);
});

test('all Codex paths preserve method, query and raw bodies, auth matches /v1 and WebSocket is refused', async (t) => {
  const f = await setup(t, success);
  const r = await fetch(f.base + '/codex/v1/models?client_version=1.2', { headers: { authorization: 'Bearer ' + KEY } });
  assert.equal(r.status, 200); await r.text();
  assert.equal(f.calls[0].path, '/backend-api/codex/models?client_version=1.2'); assert.equal(f.calls[0].method, 'GET');
  await (await request(f, { input: 'compact', model: 'original' }, '/codex/v1/responses/compact')).text();
  assert.equal(f.calls[1].path, '/backend-api/codex/responses/compact'); assert.equal(f.calls[1].body.model, 'original');
  await new Promise((resolve, reject) => {
    const r = http.request(f.base + '/codex/v1/custom?raw=1', { method: 'PUT', headers: { authorization: 'Bearer ' + KEY, connection: 'x-drop', 'x-drop': 'secret', 'proxy-connection': 'keep-alive', 'content-length': 3 } }, (res) => { res.resume(); res.on('end', resolve); });
    r.on('error', reject); r.end('raw');
  });
  assert.equal(f.calls[2].headers['x-drop'], undefined); assert.equal(f.calls[2].raw.toString(), 'raw'); assert.equal(f.calls[2].method, 'PUT');
  assert.equal(f.calls[2].headers['proxy-connection'], undefined);
  const denied = await request(f, {}, '/codex/v1/responses', { headers: { authorization: 'Bearer wrong' } }); assert.equal(denied.status, 401);
  f.app.config.settings.requireKey = false; assert.equal((await request(f, {}, '/codex/v1/responses', { headers: {} })).status, 200);
  const upgrade = await new Promise((resolve, reject) => {
    const socket = net.connect(new URL(f.base).port, '127.0.0.1', () => socket.write('GET /codex/v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
    let text = ''; socket.on('data', (c) => { text += c; }); socket.on('end', () => resolve(text)); socket.on('error', reject);
  });
  assert.match(upgrade, /^HTTP\/1.1 426/);
});

function dbSettings(f, id) {
  const db = new DatabaseSync(path.join(f.dir, 'cc-switch.db'), { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT settings_config FROM providers WHERE id=?').get(id).settings_config); }
  finally { db.close(); }
}
function setDbSettings(f, id, settings) {
  const db = new DatabaseSync(path.join(f.dir, 'cc-switch.db'));
  try { db.prepare('UPDATE providers SET settings_config=? WHERE id=?').run(JSON.stringify(settings), id); }
  finally { db.close(); }
}
const syncNow = (f, id = 'A') => panel(f, '/accounts/' + id + '/sync', 'POST', {});

test('sync binding persists imports and unique legacy matches, rejects unbound and ambiguous accounts', async (t) => {
  const f = await setup(t, success, { accounts: [account('A'), account('B'), account('C')] });
  fixtureDb(f, [account('A'), { ...account('A'), id: 'duplicate' }, account('B')]);
  let a = await rowFor(f, 'A');
  assert.equal(a.bound, false); assert.equal(a.sync, false); assert.equal(a.ccSwitchId, null);
  assert.equal((await panel(f, '/accounts/A', 'PATCH', { sync: true })).status, 400);
  assert.equal((await panel(f, '/accounts/C', 'PATCH', { sync: true })).status, 400);
  assert.equal((await panel(f, '/accounts/B', 'PATCH', { sync: 'yes' })).status, 400);
  const b = await rowFor(f, 'B');
  assert.equal(b.ccSwitchId, 'B'); assert.equal(b.bound, true); assert.equal(b.sync, true); assert.equal(b.syncState.inSync, true);
  await panel(f, '/import', 'POST', { ids: ['A'] });
  a = await rowFor(f, 'A'); assert.equal(a.ccSwitchId, 'A'); assert.equal(a.bound, true); assert.equal(a.sync, true);
  await panel(f, '/accounts/A', 'PATCH', { sync: false });
  await panel(f, '/import', 'POST', { ids: ['A'] });
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'config.json'))).codex.accounts;
  assert.equal(saved.find((x) => x.id === 'A').sync, false); assert.equal(saved.find((x) => x.id === 'B').ccSwitchId, 'B');
  setDbSettings(f, 'B', { auth: { auth_mode: 'chatgpt', tokens: account('C').tokens } });
  assert.equal((await rowFor(f, 'B')).bound, false);
  assert.equal((await panel(f, '/accounts/B', 'PATCH', { sync: true })).status, 400);
});

test('router refresh syncs only bound auth credentials, preserves settings and backs up once across restarts', async (t) => {
  const initial = account('A', -1), next = rotated('A');
  const f = await setup(t, (c, r) => c.path === '/oauth/token' ? json(r, 200, next.tokens) : success(c, r), { accounts: [initial] });
  fixtureDb(f, [initial, account('B')]);
  const original = { config: 'model = "gpt-test"\n[projects."D:\\repo"]\ntrust_level = "trusted"\n',
    auth: { auth_mode: 'chatgpt', tokens: { ...initial.tokens, custom: 'keep-token-key' }, last_refresh: 'before', keep: { nested: true } },
    env: { KEEP: 'original' }, unrelated: [1, false, null] };
  setDbSettings(f, 'A', original);
  const other = dbSettings(f, 'B'), before = fs.readFileSync(process.env.CC_SWITCH_DB);
  await (await request(f)).text();
  const updated = dbSettings(f, 'A');
  assert.deepEqual(updated, { ...original, auth: { ...original.auth, tokens: { ...next.tokens, custom: 'keep-token-key' }, last_refresh: updated.auth.last_refresh } });
  assert.ok(Number.isFinite(Date.parse(updated.auth.last_refresh))); assert.deepEqual(dbSettings(f, 'B'), other);
  const backupDir = path.join(f.dir, 'backups'), backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1); assert.deepEqual(fs.readFileSync(path.join(backupDir, backups[0])), before);
  const savedState = JSON.parse(fs.readFileSync(path.join(f.dir, 'state.json')));
  assert.equal(savedState.codex.ccSwitchBackupPath, path.join(backupDir, backups[0]));
  // Emulate reloaded state, then a second rotation.
  f.app.codex.runtime.ccSwitchBackupPath = savedState.codex.ccSwitchBackupPath;
  f.app.codex.accounts[0].tokens = { ...next.tokens, access_token: access('next-again', 9000), refresh_token: 'next-refresh' };
  const result = await syncNow(f);
  assert.equal(result.data.syncState.lastDirection, 'to_ccswitch'); assert.equal(result.data.syncState.inSync, true);
  assert.deepEqual(fs.readdirSync(backupDir), backups);
  assert.ok(f.app.store.queryEvents({}).some((e) => e.type === 'codex_sync' && e.message.includes('CC Switch')));
});

test('sync off leaves database and auth file byte-identical after refresh and on-demand check', async (t) => {
  const initial = { ...account('A', -1), sync: false }, next = rotated('A');
  const f = await setup(t, (c, r) => c.path === '/oauth/token' ? json(r, 200, next.tokens) : success(c, r), { accounts: [initial] });
  fixtureDb(f, [initial]);
  fs.writeFileSync(process.env.SMART_ROUTER_CODEX_AUTH_FILE, JSON.stringify({ auth_mode: 'chatgpt', tokens: initial.tokens }));
  const dbBefore = fs.readFileSync(process.env.CC_SWITCH_DB), authBefore = fs.readFileSync(process.env.SMART_ROUTER_CODEX_AUTH_FILE);
  await (await request(f)).text(); await syncNow(f); f.app.codex.syncAll();
  assert.deepEqual(fs.readFileSync(process.env.CC_SWITCH_DB), dbBefore);
  assert.deepEqual(fs.readFileSync(process.env.SMART_ROUTER_CODEX_AUTH_FILE), authBefore);
  assert.equal(fs.existsSync(path.join(f.dir, 'backups')), false);
  // Off also prevents importing a newer copy during refresh recovery.
  fixtureDb(f, [{ ...next, tokens: { ...next.tokens, access_token: access('external', 10000) } }]);
  assert.equal(f.app.codex.reconcile(f.app.codex.accounts[0]), false);
});

test('periodic and on-demand sync adopt newer CC Switch credentials without token requests', async (t) => {
  const f = await setup(t, success, { accounts: [account('A'), account('B')] });
  fixtureDb(f, [rotated('A'), rotated('B')]);
  const originalPrepare = DatabaseSync.prototype.prepare; let reads = 0;
  const spy = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (sql.includes("FROM providers WHERE app_type = 'codex'")) reads++;
    return originalPrepare.call(this, sql);
  });
  assert.equal(f.app.codex.syncTimer._idleTimeout, 120000);
  f.app.codex.syncTimer._onTimeout();
  assert.equal(reads, 1); spy.mock.restore();
  assert.equal(f.app.codex.accounts[0].tokens.refresh_token, rotated('A').tokens.refresh_token);
  assert.equal((await rowFor(f, 'A')).syncState.lastDirection, 'from_ccswitch');
  const newer = { ...rotated('A'), tokens: { ...rotated('A').tokens, access_token: access('newer-again', 10000) } };
  fixtureDb(f, [newer]);
  const result = await syncNow(f);
  assert.equal(result.status, 200); assert.equal(result.data.syncState.inSync, true);
  assert.equal(f.app.codex.accounts[0].tokens.access_token, newer.tokens.access_token);
  assert.equal(f.calls.length, 0);
});

test('older CC Switch credentials are overwritten on enabling sync; reimport never rolls back ours', async (t) => {
  const mine = { ...rotated('A'), sync: false };
  const f = await setup(t, success, { accounts: [mine] }); fixtureDb(f, [account('A')]);
  await panel(f, '/import', 'POST', { ids: ['A'] });
  assert.equal(f.app.codex.accounts[0].tokens.access_token, mine.tokens.access_token);
  const result = await panel(f, '/accounts/A', 'PATCH', { sync: true });
  assert.equal(result.data.sync, true); assert.equal(result.data.syncState.inSync, true);
  assert.deepEqual(dbSettings(f, 'A').auth.tokens, mine.tokens);
  assert.equal(f.calls.length, 0);
});

test('transaction recheck never overwrites credentials rotated after the read-only snapshot', async (t) => {
  const mine = rotated('A'), newest = { ...account('A'), tokens: { ...account('A').tokens, access_token: access('race-winner', 10000), refresh_token: 'race-refresh' } };
  const f = await setup(t, success, { accounts: [mine] }); fixtureDb(f, [account('A')]);
  const originalExec = DatabaseSync.prototype.exec; let raced = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql === 'BEGIN IMMEDIATE' && !raced) { raced = true; fixtureDb(f, [newest]); }
    return originalExec.call(this, sql);
  });
  const result = await syncNow(f);
  assert.equal(raced, true); assert.equal(result.data.syncState.lastDirection, 'from_ccswitch');
  assert.deepEqual(dbSettings(f, 'A').auth.tokens, newest.tokens);
  assert.deepEqual(f.app.codex.accounts[0].tokens, newest.tokens);
  assert.equal(fs.existsSync(path.join(f.dir, 'backups')), false);
});

test('transaction identity recheck rolls back and reports a safe warning', async (t) => {
  const f = await setup(t, success, { accounts: [rotated('A')] }); fixtureDb(f, [account('A')]);
  const originalExec = DatabaseSync.prototype.exec; let raced = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql === 'BEGIN IMMEDIATE' && !raced) {
      raced = true; setDbSettings(f, 'A', { config: 'keep', auth: { auth_mode: 'chatgpt', tokens: account('B').tokens } });
    }
    return originalExec.call(this, sql);
  });
  const result = await syncNow(f);
  assert.equal(result.status, 200); assert.match(result.data.syncState.lastError, /同步失败/);
  assert.deepEqual(dbSettings(f, 'A').auth.tokens, account('B').tokens);
  assert.equal(result.data.bound, false);
  assert.equal(f.app.store.queryEvents({}).find((e) => e.type === 'codex_sync').level, 'warn');
});

test('auth.json mirror selects the newest of all three copies and preserves other fields', async (t) => {
  const mine = rotated('A');
  const f = await setup(t, success, { accounts: [mine] }); fixtureDb(f, [account('A')]);
  const file = process.env.SMART_ROUTER_CODEX_AUTH_FILE;
  const original = { auth_mode: 'chatgpt', tokens: { ...account('A').tokens, extra: 'keep' }, OPENAI_API_KEY: null, custom: { unchanged: true }, last_refresh: 'old' };
  fs.writeFileSync(file, JSON.stringify(original));
  let result = await syncNow(f);
  let auth = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(auth, { ...original, tokens: { ...mine.tokens, extra: 'keep' }, last_refresh: auth.last_refresh });
  assert.ok(Number.isFinite(Date.parse(auth.last_refresh))); assert.equal(result.data.syncState.lastDirection, 'to_authfile');
  const newest = { ...mine.tokens, access_token: access('live-auth', 10000), refresh_token: 'live-refresh' };
  fs.writeFileSync(file, JSON.stringify({ ...auth, tokens: newest }));
  result = await syncNow(f);
  assert.deepEqual(f.app.codex.accounts[0].tokens, newest); assert.deepEqual(dbSettings(f, 'A').auth.tokens, newest);
  const types = f.app.store.queryEvents({}).filter((e) => e.type === 'codex_sync').map((e) => e.message);
  assert.ok(types.some((s) => s.includes('从 auth.json'))); assert.ok(types.some((s) => s.includes('同步到 auth.json')));
  assert.equal(f.calls.length, 0); assert.equal(result.data.syncState.inSync, true);
  assert.equal(fs.readdirSync(f.dir).some((name) => name.endsWith('.tmp')), false);
});

test('auth.json with mismatched identity, mode or absent file is left untouched', async (t) => {
  const f = await setup(t, success, { accounts: [rotated('A')] }); fixtureDb(f, [account('A')]);
  const file = process.env.SMART_ROUTER_CODEX_AUTH_FILE;
  await syncNow(f); assert.equal(fs.existsSync(file), false);
  for (const auth of [{ auth_mode: 'chatgpt', tokens: account('B').tokens }, { auth_mode: 'apikey', tokens: account('A').tokens },
    { auth_mode: 'chatgpt', tokens: { ...account('A').tokens, account_id: undefined } }]) {
    fs.writeFileSync(file, JSON.stringify(auth)); const before = fs.readFileSync(file);
    await syncNow(f); assert.deepEqual(fs.readFileSync(file), before);
  }
});

test('failed external writes do not interrupt a successful router refresh or expose secrets', async (t) => {
  const initial = account('A', -1), next = rotated('A');
  const f = await setup(t, (c, r) => c.path === '/oauth/token' ? json(r, 200, next.tokens) : success(c, r), { accounts: [initial] });
  fixtureDb(f, [initial]);
  const db = new DatabaseSync(process.env.CC_SWITCH_DB);
  db.exec("CREATE TRIGGER reject_sync BEFORE UPDATE ON providers BEGIN SELECT RAISE(ABORT, 'refresh-secret-A'); END"); db.close();
  fs.writeFileSync(process.env.SMART_ROUTER_CODEX_AUTH_FILE, 'invalid JSON refresh-secret-A');
  await (await request(f)).text();
  assert.deepEqual(dbSettings(f, 'A').auth.tokens, initial.tokens);
  const result = await rowFor(f, 'A'); assert.equal(result.status, 'ok'); assert.match(result.syncState.lastError, /同步失败/);
  const events = f.app.store.queryEvents({}).filter((e) => e.type === 'codex_sync');
  assert.ok(events.length >= 2); assert.ok(events.every((e) => e.level === 'warn'));
  assert.ok(!JSON.stringify({ events, result }).includes('refresh-secret-A'));
});

test('binding supports id-token identity and repairs an incomplete older CC Switch copy', async (t) => {
  const mine = rotated('A');
  const f = await setup(t, success, { accounts: [mine] }); fixtureDb(f, [account('A')]);
  setDbSettings(f, 'A', { config: 'keep', auth: { auth_mode: 'chatgpt', tokens: { id_token: mine.tokens.id_token } } });
  assert.equal((await rowFor(f, 'A')).bound, true);
  assert.equal((await panel(f, '/ccswitch')).data.length, 0); // The import list still only offers usable credentials.
  const result = await syncNow(f);
  assert.equal(result.data.syncState.inSync, true); assert.deepEqual(dbSettings(f, 'A').auth.tokens, mine.tokens);
  assert.equal(dbSettings(f, 'A').config, 'keep');
});

test('equal-exp and missing-exp copies are never adopted based on iat or token differences', async (t) => {
  const mine = rotated('A');
  const f = await setup(t, success, { accounts: [mine] });
  const tokens = { ...mine.tokens, access_token: jwt({ exp: JSON.parse(Buffer.from(mine.tokens.access_token.split('.')[1], 'base64url')).exp, iat: 9999999999 }), refresh_token: 'equal-exp-refresh' };
  fixtureDb(f, [{ ...mine, tokens }]);
  let before = fs.readFileSync(process.env.CC_SWITCH_DB);
  assert.equal((await syncNow(f)).data.syncState.inSync, false);
  assert.deepEqual(f.app.codex.accounts[0].tokens, mine.tokens); assert.deepEqual(fs.readFileSync(process.env.CC_SWITCH_DB), before);
  fixtureDb(f, [{ ...mine, tokens: { ...tokens, access_token: jwt({ iat: 9999999999 }) } }]);
  assert.equal(f.app.codex.reconcile(f.app.codex.accounts[0]), false);
  await syncNow(f); assert.deepEqual(dbSettings(f, 'A').auth.tokens, mine.tokens);
});

test('a refresh response cannot roll back credentials adopted while its request was in flight', async (t) => {
  const initial = account('A', -1), next = rotated('A');
  const newest = { ...next, tokens: { ...next.tokens, access_token: access('concurrent-newest', 12000), refresh_token: 'concurrent-refresh' } };
  let f;
  f = await setup(t, (c, r) => {
    if (c.path === '/oauth/token') {
      fixtureDb(f, [newest]); f.app.codex.syncAll();
      return json(r, 200, next.tokens);
    }
    success(c, r);
  }, { accounts: [initial] }); fixtureDb(f, [initial]);
  const response = await request(f); assert.equal(response.status, 200); await response.text();
  assert.deepEqual(f.app.codex.accounts[0].tokens, newest.tokens); assert.deepEqual(dbSettings(f, 'A').auth.tokens, newest.tokens);
  assert.equal(f.calls.filter((c) => c.path === '/oauth/token').length, 1);
});

test('relay shares account priority, overrides model only for responses, preserves store and client headers', async (t) => {
  const f = await setup(t, (c, res) => c.headers['chatgpt-account-id']
    ? json(res, 429, { error: { type: 'usage_limit_reached' } }) : json(res, 200, { model: c.body?.model, usage: { input_tokens: 5, output_tokens: 2 } }));
  const relay = await addRelay(f, { model: 'relay-model' });
  assert.deepEqual(f.app.codex.accounts.map((a) => a.type), ['chatgpt', 'chatgpt', 'relay']);
  assert.equal((await (await request(f, { model: 'client-model', input: 'hi', stream: false, store: true })).json()).model, 'relay-model');
  assert.deepEqual(f.calls.map((c) => c.headers['chatgpt-account-id'] || 'relay'), ['chatgpt-account-A', 'chatgpt-account-B', 'relay']);
  const c = f.calls[2];
  assert.equal(c.path, '/relay/v1/responses'); assert.equal(c.body.store, true);
  assert.equal(c.headers.authorization, 'Bearer ' + RELAY_KEY); assert.equal(c.headers['chatgpt-account-id'], undefined);
  const state = (await panel(f)).data, row = state.accounts[2];
  assert.equal(row.type, 'relay'); assert.equal(row.active, true); assert.equal(row.requests24h, 1); assert.equal(row.stats.inputTokens24h, 5);
  for (const key of ['usage', 'meters', 'bound', 'sync', 'syncState', 'tokens', 'apiKey']) assert.equal(key in row, false);
  assert.ok(!JSON.stringify(state).includes(RELAY_KEY)); assert.ok(row.keyHint.includes('9f2c'));
  assert.equal(f.app.codex.summary().accounts, 3); assert.equal(f.app.codex.summary().available, 1);
  assert.equal(state.recent[0].accountId, relay.id);
  await panel(f, '/accounts/' + relay.id, 'PATCH', { model: '' });
  await request(f, { model: 'client-model', input: 'hi' });
  assert.equal(f.calls.at(-1).body.model, 'client-model'); assert.equal('store' in f.calls.at(-1).body, false);
  await fetch(f.base + '/codex/v1/models?x=1', { headers: { authorization: 'Bearer ' + KEY } });
  assert.equal(f.calls.at(-1).path, '/relay/v1/models?x=1');
});

for (const failure of [429, 503, 'network', 401, 403, 402, 'quota', 400, 404, 422]) test('relay failover classification: ' + failure, async (t) => {
  const f = await setup(t, success);
  const relay = await addRelay(f);
  await panel(f, '/order', 'PUT', { ids: [relay.id, 'A', 'B'] });
  f.behavior = (c, res) => {
    if (c.headers['chatgpt-account-id']) return success(c, res);
    if (failure === 'network') return res.destroy();
    json(res, failure === 'quota' ? 400 : failure, { error: { type: 'upstream_error', code: failure === 'quota' ? 'insufficient_quota' : undefined, message: 'original upstream error' } }, { 'retry-after': '90' });
  };
  const res = await request(f), body = await res.json();
  const client = [400, 404, 422].includes(failure);
  assert.equal(res.status, client ? failure : 200);
  assert.equal(f.calls.length, client ? 1 : 2);
  if (!client) assert.equal(body.account, 'chatgpt-account-A');
  assert.ok(!JSON.stringify(body).includes(RELAY_KEY));
  const row = await rowFor(f, relay.id);
  assert.equal(row.status, client ? 'ok' : [401, 403].includes(failure) ? 'auth' : 'cooldown');
  if (row.status === 'cooldown') assert.ok(row.until > Date.now() + (failure === 'network' ? 28000 : 88000));
  assert.ok(!JSON.stringify(f.app.store.queryEvents({})).includes(RELAY_KEY));
  assert.ok(!f.calls.some((c) => /oauth|wham/.test(c.path)));
});

test('relay cooldown backoff, tick probe recovery, auth persistence and manual test', async (t) => {
  const f = await setup(t, (c, res) => c.headers['chatgpt-account-id'] ? success(c, res) : json(res, 503, {}));
  const relay = await addRelay(f);
  await panel(f, '/settings', 'PUT', { mode: 'pinned', pinnedAccountId: relay.id });
  await request(f);
  const a = f.app.codex.accounts.find((a) => a.id === relay.id), h = f.app.codex.health(a);
  h.cooldownUntil = Date.now() - 1;
  assert.equal(f.app.codex.statusOf(a), 'cooldown');
  f.app.codex.tick(); await f.app.codex.probes.get(a.id);
  assert.ok(h.cooldownUntil > Date.now() + 58000);
  h.cooldownUntil = Date.now() - 1;
  f.behavior = (c, res) => json(res, 200, { data: Array.from({ length: 25 }, (_, i) => ({ id: 'model-' + i })) });
  f.app.codex.tick(); await f.app.codex.probes.get(a.id);
  assert.equal(f.calls.at(-1).path, '/relay/v1/models'); assert.equal(f.calls.at(-1).headers.authorization, 'Bearer ' + RELAY_KEY);
  assert.equal(f.app.codex.statusOf(a), 'ok');
  f.app.codex.relayFailure(a, 401); const before = f.calls.length; f.app.codex.tick();
  assert.equal(f.calls.length, before); assert.equal(f.app.codex.statusOf(a), 'auth');
  const probe = (await panel(f, '/accounts/' + a.id + '/test', 'POST', {})).data;
  assert.equal(probe.ok, true); assert.equal(probe.status, 200); assert.equal(probe.models.length, 20); assert.ok(probe.ms >= 0);
  assert.equal(f.app.codex.statusOf(a), 'ok');
  const events = f.app.store.queryEvents({}).map((e) => e.type);
  for (const type of ['codex_switch', 'codex_exhaustion', 'codex_auth', 'codex_recovery']) assert.ok(events.includes(type));
});

test('relay timeout before headers or body fails over without committing upstream headers', async (t) => {
  const f = await setup(t, success, { settings: { firstByteTimeoutSec: 1 } });
  const relay = await addRelay(f);
  await panel(f, '/order', 'PUT', { ids: [relay.id, 'A', 'B'] });
  for (const flush of [false, true]) {
    await panel(f, '/accounts/' + relay.id + '/reset', 'POST', {});
    f.behavior = (c, res) => {
      if (c.headers['chatgpt-account-id']) return success(c, res);
      if (flush) { res.writeHead(200, { 'content-type': 'text/event-stream', 'x-relay': 'yes' }); res.flushHeaders(); }
    };
    const response = await request(f);
    assert.equal((await response.json()).account, 'chatgpt-account-A'); assert.equal(response.headers.get('x-relay'), null);
  }
});

test('encrypted reasoning retry works in both directions across account and relay types', async (t) => {
  const f = await setup(t, success, { accounts: [account('A')] }); const relay = await addRelay(f);
  const input = [{ type: 'reasoning', encrypted_content: 'opaque' }, { role: 'user', content: 'hi' }];
  for (const relayFirst of [false, true]) {
    for (const a of f.app.codex.accounts) f.app.codex.reset(a);
    f.app.codex.runtime.activeAccountId = null;
    await panel(f, '/order', 'PUT', { ids: relayFirst ? [relay.id, 'A'] : ['A', relay.id] });
    f.behavior = (c, res) => {
      const isRelay = !c.headers['chatgpt-account-id'];
      if (isRelay === relayFirst) return json(res, 429, {});
      if (c.body.input.some((i) => i.encrypted_content)) return json(res, 400, { error: { message: 'encrypted content cannot be decrypted' } });
      json(res, 200, { ok: true });
    };
    const start = f.calls.length;
    assert.equal((await request(f, { model: 'client', input, store: true })).status, 200);
    assert.equal(f.calls.length - start, 3); assert.equal(f.calls.at(-1).body.input.length, 1);
    assert.equal(f.calls.at(-1).body.store, !relayFirst);
  }
});

test('relay CRUD validates atomically and supports reset, pin, disable, order and delete', async (t) => {
  const f = await setup(t);
  const good = { name: 'relay', baseUrl: 'https://example.invalid/v1///', apiKey: RELAY_KEY };
  for (const fields of [{ name: '' }, { baseUrl: 'ftp://example.invalid' }, { baseUrl: 'oops' }, { apiKey: '' }, { apiKey: 1 }, { model: 1 }]) {
    const result = await panel(f, '/relays', 'POST', { ...good, ...fields });
    assert.equal(result.status, 400); assert.match(result.data.error, /[\u4e00-\u9fff]/);
  }
  const relay = await addRelay(f, good); assert.equal(relay.baseUrl, 'https://example.invalid/v1');
  const id = relay.id, a = f.app.codex.accounts.at(-1);
  const patch = async (body) => panel(f, '/accounts/' + id, 'PATCH', body);
  assert.equal((await patch({ name: 'changed', baseUrl: 'bad' })).status, 400); assert.equal(a.name, 'relay');
  assert.equal((await patch({ enabled: 'no' })).status, 400);
  f.app.codex.relayFailure(a, 401);
  assert.equal((await patch({ apiKey: '', model: 'override', name: 'changed' })).data.status, 'ok'); assert.equal(a.apiKey, RELAY_KEY);
  await patch({ apiKey: 'new-key-secret', enabled: false }); assert.equal((await rowFor(f, id)).status, 'disabled');
  await patch({ enabled: true }); await panel(f, '/settings', 'PUT', { mode: 'pinned', pinnedAccountId: id });
  assert.equal(f.app.codex.candidates()[0].id, id);
  await panel(f, '/accounts/' + id, 'DELETE'); assert.equal(f.app.codex.configData.pinnedAccountId, null);
  assert.equal(f.app.codex.accounts.length, 2);
});

test('CC Switch relay TOML import is read-only, filters incompatible/self rows, redacts keys and updates reimports', async (t) => {
  const f = await setup(t); const file = fixtureDb(f, [account('official')]);
  const db = new DatabaseSync(file);
  const stmt = db.prepare('INSERT INTO providers VALUES (?,?,?,?,?)');
  const add = (id, config, auth = {}, extra = {}) => stmt.run(id, id, 'codex', JSON.stringify({ config, auth, ...extra }), 0);
  const toml = (base, extra = '') => `model_provider = "custom" # selected\nmodel = 'gpt-relay'\n[model_providers.other]\nbase_url = "https://ignored.invalid"\n[model_providers.custom]\nbase_url = "${base}"\n${extra}`;
  add('relay', toml('https://example.invalid/v1/', 'wire_api = "responses"\nexperimental_bearer_token = "fallback-key-secret"'), { OPENAI_API_KEY: RELAY_KEY });
  add('bearer', toml('http://127.0.0.1:2455/backend-api/codex', 'experimental_bearer_token = "bearer-key-secret"'), { OPENAI_API_KEY: '   ' });
  db.prepare('UPDATE providers SET is_current=1 WHERE id=?').run('relay');
  add('missing', toml('https://missing.invalid', 'env_key = "UNAVAILABLE_KEY"'));
  add('manual', toml('https://manual.invalid'), { OPENAI_API_KEY: 'manual-key-secret' }, { requires_manual_auth: true });
  add('wrong-wire', toml('https://wrong.invalid', 'wire_api = "chat"'), { OPENAI_API_KEY: RELAY_KEY });
  add('empty-wire', toml('https://wrong.invalid', 'wire_api = ""'), { OPENAI_API_KEY: RELAY_KEY });
  add('self', toml('http://localhost:18787/codex/v1'), { OPENAI_API_KEY: RELAY_KEY });
  add('self-ip', toml('http://127.0.0.1:18787/codex'), { OPENAI_API_KEY: RELAY_KEY });
  add('no-base', 'model_provider = "custom"'); db.close();
  const before = fs.readFileSync(file);
  const listing = (await panel(f, '/ccswitch')).data;
  assert.deepEqual(listing.map((r) => r.id).sort(), ['official', 'relay', 'bearer', 'missing', 'manual'].sort());
  assert.equal(listing.find((r) => r.id === 'relay').isCurrent, true);
  assert.equal(listing.find((r) => r.id === 'bearer').isCurrent, false);
  for (const id of ['missing', 'manual']) { const row = listing.find((r) => r.id === id); assert.equal(row.importable, false); assert.match(row.reason, /[\u4e00-\u9fff]/); }
  for (const secret of [RELAY_KEY, 'fallback-key-secret', 'bearer-key-secret', 'manual-key-secret']) assert.ok(!JSON.stringify(listing).includes(secret));
  assert.deepEqual((await panel(f, '/import', 'POST', { ids: listing.map((r) => r.id) })).data, { added: 3, updated: 0 });
  const a = f.app.codex.accounts.find((r) => r.ccSwitchId === 'relay'); assert.equal(a.apiKey, RELAY_KEY); assert.equal(a.model, 'gpt-relay');
  assert.equal((await panel(f, '/ccswitch')).data.find((r) => r.id === 'relay').imported, true);
  assert.deepEqual(fs.readFileSync(file), before);
  const update = new DatabaseSync(file);
  update.prepare('UPDATE providers SET settings_config=? WHERE id=?').run(JSON.stringify({ config: toml('https://new.invalid/v1').replace('gpt-relay', 'new-model'), auth: { OPENAI_API_KEY: 'new-import-key-secret' } }), 'relay'); update.close();
  const changed = fs.readFileSync(file);
  assert.deepEqual((await panel(f, '/import', 'POST', { ids: ['relay'] })).data, { added: 0, updated: 1 });
  assert.equal(a.baseUrl, 'https://new.invalid/v1'); assert.equal(a.apiKey, 'new-import-key-secret'); assert.equal(a.model, 'new-model');
  f.app.codex.syncAll(); await panel(f, '/accounts/' + a.id + '/sync', 'POST', {});
  assert.deepEqual(fs.readFileSync(file), changed);
});

test('relay streams without content-type retain usage scanning and empty successes complete', async (t) => {
  const f = await setup(t, (c, res) => {
    res.writeHead(200);
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":13,"output_tokens":4}}}\n\n');
  }, { accounts: [] });
  const relay = await addRelay(f);
  const logged = new Promise((resolve) => f.app.bus.on('push', (m) => { if (m.kind === 'request') resolve(m.data); }));
  const response = await request(f, { input: 'hi', stream: true });
  assert.match(await response.text(), /response.completed/);
  const row = await logged;
  assert.equal(row.providerId, relay.id); assert.equal(row.inputTokens, 13); assert.equal(row.outputTokens, 4);
  f.behavior = (c, res) => { res.writeHead(204); res.end(); };
  assert.equal((await request(f)).status, 204);
});
