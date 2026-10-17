'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMock, ok, err } = require('./mock-upstream');

process.env.CC_SWITCH_DB = path.join(os.tmpdir(), 'sr-no-ccswitch.db');
const { createApp } = require('../src/server');
const { isClientCompact, chainHash } = require('../src/compaction');
const { estimateRequest } = require('../src/tokens');
const { classify } = require('../src/classify');

const KEY = 'test-key';

async function setup(defs, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-'));
  const mocks = [];
  for (const d of defs) mocks.push(await createMock(d.name, d.behavior, d.models).start());
  const providers = mocks.map((m, i) => ({ id: m.name, name: m.name, baseUrl: m.url, apiKey: 'k-' + m.name, ...(defs[i].provider || {}) }));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ settings: { routerKey: KEY, sameProviderRetry: 0, ...settings }, providers })
  );
  const app = createApp({ dataDir: dir });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const m = Object.fromEntries(mocks.map((x) => [x.name, x]));
  return {
    app, m, base,
    async close() {
      await app.close();
      await Promise.all(mocks.map((x) => x.close()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function send(base, body, { key = KEY, path: p = '/v1/messages', ua = 'claude-cli/test' } = {}) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'user-agent': ua },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, text, json, provider: r.headers.get('x-smart-router-provider') };
}

const simple = (extra) => ({ model: 'claude-sonnet-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], ...extra });

async function listModels(t) {
  const r = await fetch(t.base + '/v1/models', { headers: { 'x-api-key': KEY } });
  assert.equal(r.status, 200);
  return r.json();
}

test('model catalog unions enabled providers, deduplicates by priority and encodes attribution', async () => {
  const t = await setup([
    { name: 'A', provider: { name: '优先 @ 0.3x', authHeader: 'both', extraHeaders: { 'x-discovery': 'yes' } }, models: ['shared', 'only-a'], behavior: ok },
    { name: 'B', models: ['shared', 'only-b'], behavior: ok },
    { name: 'C', provider: { enabled: false }, models: ['disabled'], behavior: ok },
  ]);
  try {
    const catalog = await listModels(t);
    // ids stay official so client capability lookups (effort levels) still match
    assert.deepEqual(catalog.data.map((m) => m.id), ['shared', 'only-a', 'only-b']);
    assert.deepEqual(catalog.data.map((m) => m.display_name), ['shared (优先 @ 0.3x)', 'only-a (优先 @ 0.3x)', 'only-b (B)']);
    assert.equal(catalog.has_more, false);
    assert.equal(catalog.first_id, 'shared');
    assert.equal(catalog.last_id, 'only-b');
    assert.ok(catalog.data.every((m) => m.type === 'model' && m.display_name && m.created_at));
    assert.equal(t.m.C.modelCalls.length, 0);
    const headers = t.m.A.modelCalls[0].headers;
    assert.equal(headers.authorization, 'Bearer k-A');
    assert.equal(headers['x-api-key'], 'k-A');
    assert.equal(headers['x-discovery'], 'yes');
    await listModels(t);
    assert.equal(t.m.A.modelCalls.length, 1, 'fresh catalogs are cached');
    t.app.config.moveProvider('B', 'up');
    assert.equal((await listModels(t)).data[0].display_name, 'shared (B)');
    t.app.config.upsertProvider({ id: 'A', enabled: false });
    assert.deepEqual((await listModels(t)).data.map((m) => m.display_name), ['shared (B)', 'only-b (B)']);
  } finally { await t.close(); }
});

test('suffixed and plain messages skip providers known to lack a model; count_tokens strips suffix too', async () => {
  const t = await setup([
    { name: 'A', models: ['other'], behavior: ok },
    { name: 'B', models: ['wanted'], behavior: (c) => c.path.endsWith('/count_tokens') ? { json: { input_tokens: 7 } } : ok(c) },
  ]);
  try {
    for (const model of ['wanted@provider=A', 'wanted']) {
      const r = await send(t.base, simple({ model }));
      assert.equal(r.provider, 'B');
      assert.equal(t.m.B.calls.at(-1).body.model, 'wanted');
    }
    const count = await send(t.base, simple({ model: 'wanted@provider=B' }), { path: '/v1/messages/count_tokens' });
    assert.equal(count.json.input_tokens, 7);
    assert.equal(t.m.B.calls.at(-1).body.model, 'wanted');
    assert.equal(t.m.A.calls.length, 0);
  } finally { await t.close(); }
});

test('attribution does not pin routing and filtered candidates still fail over', async () => {
  const t = await setup([
    { name: 'A', models: ['wanted'], behavior: () => err(503, 'api_error', 'model_not_found: wanted') },
    { name: 'B', models: ['wanted'], behavior: ok },
  ]);
  try {
    const r = await send(t.base, simple({ model: 'wanted@provider=B' }));
    assert.equal(r.provider, 'B');
    assert.equal(t.m.A.calls.length, 1, 'priority provider tried despite B attribution');
    assert.equal(t.m.A.calls[0].body.model, 'wanted');
    assert.equal(t.m.B.calls[0].body.model, 'wanted');
  } finally { await t.close(); }
});

test('pinned provider falls through only when catalog rules out the requested model', async () => {
  const t = await setup([
    { name: 'A', models: ['wanted'], behavior: ok },
    { name: 'B', models: ['other'], behavior: ok },
  ], { mode: 'pinned', pinnedProviderId: 'B' });
  try {
    assert.equal((await send(t.base, simple({ model: 'wanted' }))).provider, 'A');
    assert.equal((await send(t.base, simple({ model: 'other@provider=B' }))).provider, 'B');
  } finally { await t.close(); }
});

test('unknown and empty catalogs retain old routing behavior', async () => {
  for (const models of [null, []]) {
    const t = await setup([{ name: 'A', models, behavior: ok }, { name: 'B', models: ['wanted'], behavior: ok }]);
    try {
      assert.equal((await send(t.base, simple({ model: 'wanted' }))).provider, 'A');
      assert.equal(t.m.B.calls.length, 0);
      assert.equal(t.app.state.health('A').status, 'healthy');
    } finally { await t.close(); }
  }
});

test('stale discovery failures keep last good catalog and do not penalize health', async () => {
  const t = await setup([{ name: 'A', models: ['wanted'], behavior: ok }]);
  try {
    await listModels(t);
    const p = t.app.config.provider('A');
    const updated = t.app.models.view(p).modelsUpdatedAt;
    t.m.A.models = () => err(401, 'authentication_error', 'discovery unavailable');
    t.app.models.entry(p).attemptedAt = 0;
    assert.deepEqual((await listModels(t)).data.map((m) => m.id), ['wanted']);
    assert.equal(t.m.A.modelCalls.length, 2);
    assert.equal(t.app.models.view(p).modelsUpdatedAt, updated);
    assert.equal(t.app.state.health('A').status, 'healthy');
    assert.equal((await send(t.base, simple({ model: 'wanted@provider=A' }))).provider, 'A');
    assert.equal(t.m.A.calls[0].body.model, 'wanted');
    t.m.A.models = ['new'];
    t.app.models.entry(p).attemptedAt = 0;
    await t.app.models.refreshAll();
    assert.deepEqual(t.app.models.view(p).models, ['new']);
  } finally { await t.close(); }
});

test('modelMap aliases retain mapping when filtering discovered catalogs', async () => {
  const t = await setup([{ name: 'A', models: ['actual'], provider: { modelMap: { 'alias*': 'actual' } }, behavior: ok }]);
  try {
    assert.equal((await send(t.base, simple({ model: 'alias-model@provider=A' }))).provider, 'A');
    assert.equal(t.m.A.calls[0].body.model, 'actual');
  } finally { await t.close(); }
});

test('streams through the first provider and swaps credentials', async () => {
  const t = await setup([{ name: 'A', behavior: (c) => ok(c) }, { name: 'B', behavior: (c) => ok(c) }]);
  try {
    const r = await send(t.base, simple({ stream: true }));
    assert.equal(r.status, 200);
    assert.equal(r.provider, 'A');
    assert.match(r.text, /hello from A/);
    assert.match(r.text, /message_stop/);
    assert.equal(t.m.A.calls[0].headers.authorization, 'Bearer k-A');
    assert.equal(t.m.A.calls[0].headers['x-api-key'], undefined);
    assert.equal(t.m.B.calls.length, 0);
    const rows = t.app.store.queryRequests({ kind: 'messages' });
    assert.equal(rows[0].provider_id, 'A');
    assert.equal(rows[0].ok, 1);
    assert.equal(rows[0].output_tokens, 5);
  } finally {
    await t.close();
  }
});

test('rejects requests without the router key', async () => {
  const t = await setup([{ name: 'A', behavior: (c) => ok(c) }]);
  try {
    assert.equal((await send(t.base, simple(), { key: 'nope' })).status, 401);
    assert.equal(t.m.A.calls.length, 0);
  } finally {
    await t.close();
  }
});

test('repeated 5xx: fail over each time, take provider offline, probe brings it back', async () => {
  const t = await setup([
    { name: 'A', behavior: () => err(500, 'api_error', 'internal error') },
    { name: 'B', behavior: (c) => ok(c) },
  ]);
  try {
    for (let i = 0; i < 3; i++) {
      const r = await send(t.base, simple());
      assert.equal(r.status, 200);
      assert.equal(r.provider, 'B');
    }
    assert.equal(t.app.state.health('A').status, 'down');
    assert.equal(t.app.state.health('A').downReason, 'failures');
    const before = t.m.A.calls.length;
    assert.equal((await send(t.base, simple())).provider, 'B');
    assert.equal(t.m.A.calls.length, before, 'offline provider is not tried');

    // Still broken: probe keeps it down and reschedules ~10 min later.
    let pr = await t.app.prober.probe(t.app.config.provider('A'), { auto: true });
    assert.equal(pr.ok, false);
    assert.ok(t.app.state.health('A').nextProbeAt > Date.now() + 9 * 60000);

    t.m.A.behavior = (c) => ok(c);
    pr = await t.app.prober.probe(t.app.config.provider('A'), { auto: true });
    assert.equal(pr.ok, true);
    assert.equal(t.app.state.health('A').status, 'healthy');
    assert.equal((await send(t.base, simple())).provider, 'A');
    const ev = t.app.store.queryEvents({ type: 'switch' });
    assert.ok(ev.some((e) => /B → A|→ A/.test(e.message)), 'logged switch back to A');
  } finally {
    await t.close();
  }
});

test('quota exhausted takes provider offline immediately', async () => {
  const t = await setup([
    { name: 'A', behavior: () => ({ status: 403, json: { error: { message: '该令牌额度已用尽 (request id: x)', type: 'new_api_error' } } }) },
    { name: 'B', behavior: (c) => ok(c) },
  ]);
  try {
    const r = await send(t.base, simple());
    assert.equal(r.provider, 'B');
    const h = t.app.state.health('A');
    assert.equal(h.status, 'down');
    assert.equal(h.downReason, 'quota');
  } finally {
    await t.close();
  }
});

test('error event inside a 200 SSE stream fails over before anything reaches the client', async () => {
  const t = await setup([
    { name: 'A', behavior: () => ({ sse: 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n' }) },
    { name: 'B', behavior: (c) => ok(c) },
  ]);
  try {
    const r = await send(t.base, simple({ stream: true }));
    assert.equal(r.status, 200);
    assert.equal(r.provider, 'B');
    assert.doesNotMatch(r.text, /Overloaded/);
    assert.equal(t.app.state.health('A').consecutiveFailures, 1);
  } finally {
    await t.close();
  }
});

test('response ends at message_stop even if the relay keeps the connection open', async () => {
  const { sseBody } = require('./mock-upstream');
  const t = await setup([{ name: 'A', behavior: () => ({ sse: sseBody('held', {}), hold: true }) }]);
  try {
    const t0 = Date.now();
    const r = await send(t.base, simple({ stream: true }));
    assert.match(r.text, /message_stop/);
    assert.ok(Date.now() - t0 < 2000, 'did not wait for the relay to close');
    assert.equal(t.app.store.queryRequests({ kind: 'messages' })[0].ok, 1);
  } finally {
    await t.close();
  }
});

test('first-byte timeout fails over', async () => {
  const t = await setup([{ name: 'A', behavior: () => 'hang' }, { name: 'B', behavior: (c) => ok(c) }], { firstByteTimeoutSec: 1 });
  try {
    const r = await send(t.base, simple({ stream: true }));
    assert.equal(r.provider, 'B');
    const row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.equal(row.attempts[0].category, 'timeout');
  } finally {
    await t.close();
  }
});

test('model not available on a relay: only that model moves, provider stays healthy', async () => {
  const t = await setup([
    {
      name: 'A',
      behavior: (c) =>
        /haiku/.test(c.body.model)
          ? { status: 503, json: { error: { code: 'model_not_found', message: 'No available channel for model claude-haiku-4-5 under group x', type: 'new_api_error' } } }
          : ok(c),
    },
    { name: 'B', behavior: (c) => ok(c) },
  ]);
  try {
    assert.equal((await send(t.base, simple({ model: 'claude-haiku-4-5' }))).provider, 'B');
    const n = t.m.A.calls.length;
    assert.equal((await send(t.base, simple({ model: 'claude-haiku-4-5' }))).provider, 'B');
    assert.equal(t.m.A.calls.length, n, 'skips A for haiku while marked unavailable');
    assert.equal((await send(t.base, simple())).provider, 'A');
    assert.equal(t.app.state.health('A').status, 'healthy');
  } finally {
    await t.close();
  }
});

test('model map rewrites the model per provider', async () => {
  const t = await setup([{ name: 'A', behavior: (c) => ok(c), provider: { modelMap: { 'claude-haiku-*': 'claude-sonnet-5' } } }]);
  try {
    await send(t.base, simple({ model: 'claude-haiku-4-5-20251001' }));
    assert.equal(t.m.A.calls[0].body.model, 'claude-sonnet-5');
  } finally {
    await t.close();
  }
});

test('pinned mode sends everything to the pinned provider', async () => {
  const t = await setup([{ name: 'A', behavior: (c) => ok(c) }, { name: 'B', behavior: (c) => ok(c) }], { mode: 'pinned', pinnedProviderId: 'B' });
  try {
    assert.equal((await send(t.base, simple())).provider, 'B');
    assert.equal(t.m.A.calls.length, 0);
  } finally {
    await t.close();
  }
});

test('count_tokens falls back to a local estimate', async () => {
  const t = await setup([{ name: 'A', behavior: () => err(404, 'not_found_error', 'Not Found') }]);
  try {
    const r = await send(t.base, simple(), { path: '/v1/messages/count_tokens' });
    assert.equal(r.status, 200);
    assert.ok(r.json.input_tokens > 0);
  } finally {
    await t.close();
  }
});

// --- context limit + compaction ---

const LIMIT_CHARS = 100000;
const filler = (i) => `第${i}轮 `.padEnd(8, ' ') + 'lorem ipsum dolor sit amet '.repeat(296);
function convo(n) {
  const msgs = [];
  for (let i = 0; i < n; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: filler(i) }] });
  return { model: 'claude-sonnet-5', max_tokens: 1000, metadata: { user_id: 'user_x_account_y_session_11111111-2222-3333-4444-555555555555' }, messages: msgs };
}
const isSummarizer = (c) => Array.isArray(c.body && c.body.system) && JSON.stringify(c.body.system).includes('对话压缩器');
const tooLong = (c) => JSON.stringify(c.body.messages).length > LIMIT_CHARS;
const ctxErr = () => err(400, 'invalid_request_error', 'prompt is too long: 180000 tokens > 100000 maximum');

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout waiting');
}

test('[sizeFailover] context overflow: fail over, summarize in background, then return to the cheap provider', async () => {
  const t = await setup([
    { name: 'A', behavior: (c) => (tooLong(c) ? ctxErr() : ok(c)), provider: { allowCompaction: true } },
    { name: 'B', behavior: (c) => (isSummarizer(c) ? ok(c, 'SUMMARY-XYZ: 用户在做智能路由') : ok(c)) },
  ], { sizeFailover: true });
  try {
    const body1 = convo(21);
    const r1 = await send(t.base, body1);
    assert.equal(r1.status, 200);
    assert.equal(r1.provider, 'B', 'too-long request is served by the next provider');
    assert.ok(t.app.state.learned('A').minRejected > 0, 'learned A limit');

    const key = t.app.compactor.sessionKey(body1);
    await waitFor(() => t.app.compactor.get(key) && t.app.compactor.get(key).status === 'ready');
    const sess = t.app.compactor.get(key);
    assert.match(sess.summary, /SUMMARY-XYZ/);
    assert.ok(sess.coveredCount > 2 && sess.coveredCount < 21);

    // Conversation continues: next turn goes back to A with summary + recent turns.
    const body2 = convo(23);
    const r2 = await send(t.base, body2);
    assert.equal(r2.status, 200);
    assert.equal(r2.provider, 'A');
    const last = t.m.A.calls[t.m.A.calls.length - 1];
    assert.match(last.body.messages[0].content[0].text, /SUMMARY-XYZ/);
    assert.equal(last.body.messages.length, 23 - sess.coveredCount);
    assert.equal(last.body.messages[0].role, 'user');
    const row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.equal(row.compacted, 1);

    // Client rewrote history (e.g. its own /compact): summary is dropped, full short history goes to A.
    const r3 = await send(t.base, { ...convo(3), metadata: body1.metadata });
    assert.equal(r3.provider, 'A');
    assert.equal(t.m.A.calls[t.m.A.calls.length - 1].body.messages.length, 3);
  } finally {
    await t.close();
  }
});

test('a context hint the provider clearly exceeds does not trigger summaries', async () => {
  const t = await setup([{ name: 'A', behavior: (c) => ok(c), provider: { allowCompaction: true, contextLimit: 1000 } }]);
  try {
    await send(t.base, convo(21));
    await send(t.base, convo(23));
    await send(t.base, convo(25));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(t.app.store.queryRequests({ kind: 'compact' }).length, 0);
    assert.equal(t.app.state.effectiveLimit(t.app.config.provider('A')), null);
    assert.equal(t.app.state.hintDisproven(t.app.config.provider('A')), true);
  } finally {
    await t.close();
  }
});

test('ready summary is used to retry the same provider right after a rejection', async () => {
  const t = await setup([
    { name: 'A', behavior: (c) => (tooLong(c) ? ctxErr() : ok(c)), provider: { allowCompaction: true } },
    { name: 'B', behavior: (c) => (isSummarizer(c) ? ok(c, 'SUMMARY-2') : ok(c)) },
  ]);
  try {
    const body1 = convo(21);
    await send(t.base, body1);
    const key = t.app.compactor.sessionKey(body1);
    await waitFor(() => t.app.compactor.get(key) && t.app.compactor.get(key).status === 'ready');
    // Forget the learned limit so the router tries the full request first again.
    t.app.state.forgetLearned(t.app.config.provider('A'));
    const r = await send(t.base, convo(23));
    assert.equal(r.provider, 'A');
    const row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.deepEqual(row.attempts.map((a) => `${a.providerId}:${a.variant}:${a.ok}`), ['A:full:false', 'A:compacted:true']);
  } finally {
    await t.close();
  }
});

test('compacted responses report the full-history size to the client, logs keep real usage', async () => {
  const t = await setup([
    { name: 'A', behavior: (c) => (tooLong(c) ? ctxErr() : ok(c)), provider: { allowCompaction: true } },
    { name: 'B', behavior: (c) => (isSummarizer(c) ? ok(c, 'SUMMARY-U') : ok(c)) },
  ]);
  try {
    const body1 = convo(21);
    await send(t.base, body1);
    const key = t.app.compactor.sessionKey(body1);
    await waitFor(() => t.app.compactor.get(key) && t.app.compactor.get(key).status === 'ready');

    const r = await send(t.base, convo(23));
    assert.equal(r.provider, 'A');
    assert.ok(r.json.usage.input_tokens > 10, 'client sees inflated input');
    let row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.equal(row.compacted, 1);
    assert.equal(row.input_tokens, 10, 'log keeps the real number');

    const s = await send(t.base, { ...convo(25), stream: true });
    assert.equal(s.provider, 'A');
    const start = JSON.parse(s.text.split('\n').find((l) => l.startsWith('data:') && l.includes('message_start')).slice(5));
    assert.ok(start.message.usage.input_tokens > 10);
    assert.ok(s.text.includes('message_stop'), 'rest of the stream passes through');
    row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.equal(row.input_tokens, 10);
  } finally {
    await t.close();
  }
});

test('usage rewriter handles events split across chunks', () => {
  const { UsageRewriter } = require('../src/usage-rewrite');
  const { sseBody } = require('./mock-upstream');
  const src = sseBody('hi', { input: 100 });
  const rw = new UsageRewriter(3);
  const enc = new TextEncoder();
  let out = '';
  for (let i = 0; i < src.length; i += 7) out += rw.push(enc.encode(src.slice(i, i + 7)));
  out += rw.flush();
  assert.ok(out.includes('"input_tokens":300'));
  assert.equal(out.replace('"input_tokens":300', '"input_tokens":100'), src);
});

test('all providers reject the context: client gets a "prompt is too long" error', async () => {
  const t = await setup([
    { name: 'A', behavior: (c) => (tooLong(c) ? ctxErr() : ok(c)) },
    { name: 'B', behavior: (c) => (tooLong(c) ? ctxErr() : ok(c)) },
  ]);
  try {
    const r = await send(t.base, convo(21));
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /^Prompt is too long/);
  } finally {
    await t.close();
  }
});

test('everything offline: last-resort attempt still goes out and heals on success', async () => {
  const t = await setup([{ name: 'A', behavior: (c) => ok(c) }, { name: 'B', behavior: (c) => ok(c) }]);
  try {
    t.app.state.markDown(t.app.config.provider('A'), 'failures', 'x');
    t.app.state.markDown(t.app.config.provider('B'), 'failures', 'x');
    const r = await send(t.base, simple());
    assert.equal(r.provider, 'A');
    assert.equal(t.app.state.health('A').status, 'healthy');
  } finally {
    await t.close();
  }
});

test('panel API refuses mutations without the panel header', async () => {
  const t = await setup([{ name: 'A', behavior: (c) => ok(c) }]);
  try {
    const r = await fetch(t.base + '/api/mode', { method: 'POST', body: '{"mode":"auto"}' });
    assert.equal(r.status, 403);
    const s = await (await fetch(t.base + '/api/status')).json();
    assert.equal(s.providers[0].apiKey, undefined);
    assert.equal(s.activeProviderId, 'A');
  } finally {
    await t.close();
  }
});


test('summaries require a real context rejection even with a known limit or legacy preemptive setting', async () => {
  const t = await setup([
    { name: 'A', behavior: (c) => ok(c), provider: { allowCompaction: true } },
    { name: 'B', behavior: (c) => ok(c) },
  ], { compaction: { enabled: true, preemptive: true } });
  try {
    const scheduled = [];
    t.app.compactor.schedule = (...args) => { scheduled.push(args); return false; };
    t.app.state.learnRejected(t.app.config.provider('A'), 10000);
    const r = await send(t.base, convo(21));
    assert.equal(r.status, 200);
    assert.equal(r.provider, 'A', 'estimated overflow must still be sent for confirmation');
    assert.equal(scheduled.length, 0, 'successful requests must not schedule a summary');
    assert.equal(t.app.store.queryRequests({ kind: 'compact' }).length, 0);
  } finally { await t.close(); }
});

function readySummary(app, body, coveredCount = 14) {
  const key = app.compactor.sessionKey(body);
  app.compactor.sessions[key] = {
    key, status: 'ready', summary: 'READY-SUMMARY', coveredCount,
    coveredHash: chainHash(body.messages, coveredCount), lastUsedAt: Date.now(),
  };
  return key;
}

const compactRequest = () => {
  const body = convo(21);
  body.messages.at(-1).content = [{ type: 'text', text: 'Your task is to create a detailed summary of the conversation so far.' }];
  return body;
};
const hasSummary = (c) => JSON.stringify(c.body.messages).includes('READY-SUMMARY');

test('client compaction detection tolerates case, whitespace, blocks and system prompts', () => {
  for (const text of [
    'Your task is to create a detailed summary of the conversation so far',
    'Please CREATE A DETAILED SUMMARY OF THE CONVERSATION.',
    'Write a comprehensive summary of our conversation',
    'Provide a detailed\n summary of this conversation',
  ]) {
    assert.equal(isClientCompact(simple({ messages: [{ role: 'user', content: text }] })), true);
    assert.equal(isClientCompact(simple({ system: [{ type: 'text', text }] })), true);
  }
  assert.equal(isClientCompact(simple({ system: 'Create a detailed summary of the conversation' })), true);
  assert.equal(isClientCompact(simple()), false);
  assert.equal(isClientCompact(null), false);
  assert.equal(isClientCompact(simple({ messages: [
    { role: 'user', content: 'create a detailed summary of the conversation' },
    { role: 'assistant', content: 'done' }, { role: 'user', content: 'continue coding' },
  ] })), false, 'only the last user turn is checked');
  assert.equal(isClientCompact(simple({ messages: [{ role: 'user', content: [
    { type: 'tool_result', content: 'create a detailed summary of the conversation' },
  ] }] })), false, 'tool output is not a compaction instruction');
});

test('[sizeFailover] client /compact skips known-small providers and sends full history despite a ready summary', async () => {
  const t = await setup([
    { name: 'A', behavior: (c) => ok(c), provider: { allowCompaction: true } },
    { name: 'B', behavior: (c) => ok(c) },
  ], { sizeFailover: true });
  try {
    const body = compactRequest();
    readySummary(t.app, body);
    t.app.state.learnRejected(t.app.config.provider('A'), 10000);
    let schedules = 0;
    t.app.compactor.schedule = () => { schedules++; return false; };
    assert.equal((await send(t.base, body)).provider, 'B');
    assert.equal(t.m.A.calls.length, 0);
    assert.deepEqual(t.m.B.calls[0].body.messages, body.messages);
    const row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.equal(row.client_compact, 1);
    assert.equal(row.compacted, 0);
    assert.equal(row.attempts[0].skipped, true);
    assert.equal(schedules, 0);
  } finally { await t.close(); }
});

test('[sizeFailover] client /compact tries full on unknown providers then falls back only after all reject full', async () => {
  const t = await setup([
    { name: 'A', behavior: (c) => hasSummary(c) ? ok(c) : ctxErr(), provider: { allowCompaction: true } },
    { name: 'B', behavior: () => ctxErr() },
  ], { sizeFailover: true });
  try {
    const body = compactRequest();
    readySummary(t.app, body);
    let schedules = 0;
    t.app.compactor.schedule = () => { schedules++; return false; };
    assert.equal((await send(t.base, body)).provider, 'A');
    let row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.deepEqual(row.attempts.map((a) => `${a.providerId}:${a.variant}`), ['A:full', 'B:full', 'A:compacted']);
    assert.equal(row.client_compact, 1);
    assert.equal(row.compacted, 1);
    assert.equal(row.compacted_failover, 0);
    // Next request skips both full sends without spending attempts on them.
    assert.equal((await send(t.base, body)).provider, 'A');
    row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.equal(row.attempts.filter((a) => a.skipped).length, 2);
    assert.equal(row.attempts.filter((a) => !a.skipped).length, 1);
    assert.equal(schedules, 0);
  } finally { await t.close(); }
});

test('[sizeFailover] client /compact continues full-history pass after a context rejection with a ready summary', async () => {
  const t = await setup([
    { name: 'A', behavior: () => ctxErr(), provider: { allowCompaction: true } },
    { name: 'B', behavior: (c) => ok(c) },
  ], { sizeFailover: true });
  try {
    const body = compactRequest();
    readySummary(t.app, body);
    assert.equal((await send(t.base, body)).provider, 'B');
    assert.deepEqual(t.m.B.calls[0].body.messages, body.messages);
    assert.equal(t.app.store.queryRequests({ kind: 'compact' }).length, 0);
  } finally { await t.close(); }
});

test('[sizeFailover] 413 learns byte limits, builds a byte-budgeted tail and compacts subsequent image-heavy requests', async () => {
  const byteLimit = 180000;
  const t = await setup([
    { name: 'A', behavior: (c) => Buffer.byteLength(JSON.stringify(c.body)) > byteLimit
      ? { status: 413, raw: '<html>Request Entity Too Large</html>' } : ok(c), provider: { allowCompaction: true } },
    { name: 'B', behavior: (c) => ok(c, isSummarizer(c) ? 'BYTE-SUMMARY' : 'ok') },
  ], { sizeFailover: true });
  try {
    const body = convo(12);
    body.messages[8].content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(220000) } });
    assert.equal((await send(t.base, body)).provider, 'B');
    const a = t.app.config.provider('A');
    assert.equal(t.app.state.learned('A').minRejected, undefined, '413 does not teach token rejection');
    assert.equal(t.app.state.learned('A').minRejectedBytes, Buffer.byteLength(JSON.stringify(body)));
    assert.equal(t.app.state.tooBigFor(a, 1, Buffer.byteLength(JSON.stringify(body))), true);
    const key = t.app.compactor.sessionKey(body);
    await waitFor(() => t.app.compactor.get(key)?.status === 'ready');
    assert.ok(t.app.compactor.get(key).coveredCount > 8, 'byte-heavy image is summarized out of the tail');
    assert.equal((await send(t.base, body)).provider, 'A');
    const sent = t.m.A.calls.at(-1).body;
    assert.match(JSON.stringify(sent), /BYTE-SUMMARY/);
    assert.ok(Buffer.byteLength(JSON.stringify(sent)) < byteLimit);
    assert.equal(t.app.state.learned('A').maxAcceptedBytes, Buffer.byteLength(JSON.stringify(sent)));
    const rec = t.app.store.queryRequests({ kind: 'messages' })[0].attempts[0];
    assert.equal(rec.variant, 'compacted');
    assert.equal(rec.sentBytes, Buffer.byteLength(JSON.stringify(sent)));
    assert.equal(classify({ status: 413 }, {}).category, 'body_too_large');
  } finally { await t.close(); }
});

test('[sizeFailover] known oversized bytes skip a provider without a summary instead of repeating 413', async () => {
  const t = await setup([
    { name: 'A', behavior: () => ({ status: 413, raw: 'Request Entity Too Large' }) },
    { name: 'B', behavior: (c) => ok(c) },
  ], { sizeFailover: true, costAwareFailover: { minTokens: 0 } });
  try {
    const body = convo(5);
    assert.equal((await send(t.base, body)).provider, 'B');
    assert.equal((await send(t.base, body)).provider, 'B');
    assert.equal(t.m.A.calls.length, 1);
    const row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.equal(row.attempts[0].skipped, true);
    assert.match(row.attempts[0].reason, /字节/);
  } finally { await t.close(); }
});

test('byte and token learning expire and larger acceptance overrides stale configured hints', async () => {
  const t = await setup([{ name: 'A', behavior: (c) => ok(c), provider: { contextLimit: 78000 } }]);
  try {
    const s = t.app.state;
    const p = t.app.config.provider('A');
    s.learnAccepted(p, 232000);
    s.learnRejectedBytes(p, 1000000);
    s.learnAcceptedBytes(p, 800000);
    assert.equal(s.effectiveLimit(p), null);
    assert.equal(s.hintDisproven(p), true);
    assert.equal(s.tooBigFor(p, 257000, 1100000), true);
    assert.equal(s.tooBigFor(p, 257000, 800000), false);
    s.learnAcceptedBytes(p, 1100000);
    assert.equal(s.effectiveByteLimit(p), null, 'larger success clears obsolete byte rejection');
    s.learnRejectedBytes(p, 1200000);
    s.learnRejected(p, 300000);
    const l = s.learned('A');
    for (const field of ['minRejected', 'maxAccepted', 'minRejectedBytes', 'maxAcceptedBytes']) l[field + 'At'] = Date.now() - 25 * 3600000;
    assert.deepEqual(s.learned('A'), {});
    assert.equal(s.effectiveLimit(p), 78000);
  } finally { await t.close(); }
});

const largeRequest = () => simple({ messages: [{ role: 'user', content: 'large conversation '.repeat(22000) }] });

test('large cold-cache failover retries network failures twice without spending maxAttempts', async () => {
  const t = await setup([
    { name: 'A', behavior: () => 'disconnect' }, { name: 'B', behavior: (c) => ok(c) },
  ], { maxAttempts: 2 });
  try {
    const body = largeRequest();
    assert.ok(estimateRequest(body) >= 100000);
    assert.equal((await send(t.base, body)).provider, 'B');
    assert.equal(t.m.A.calls.length, 3);
    assert.equal(t.m.B.calls.length, 1);
    const row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.deepEqual(row.attempts.map((a) => a.providerId), ['A', 'A', 'A', 'B']);
    assert.deepEqual(row.attempts.map((a) => a.costAwareRetry || 0), [0, 1, 2, 0]);
    assert.equal(row.cost_aware_retry, 1);
    assert.equal(t.app.store.queryEvents({ type: 'cost_retry' }).length, 2);
  } finally { await t.close(); }
});

test('large failover to a warm session and small cold-cache requests switch immediately', async () => {
  const t = await setup([
    { name: 'A', behavior: () => 'disconnect' }, { name: 'B', behavior: (c) => ok(c) },
  ], { mode: 'pinned', pinnedProviderId: 'B' });
  try {
    const body = largeRequest();
    await send(t.base, body);
    const p = t.app.config.provider('B');
    const key = t.app.compactor.sessionKey(body);
    assert.equal(t.app.state.isWarm(p, key, 'full'), true);
    assert.equal(t.app.state.isWarm(p, key, 'compacted'), false);
    t.app.config.updateSettings({ mode: 'auto' });
    assert.equal((await send(t.base, body)).provider, 'B');
    assert.equal(t.m.A.calls.length, 1);
    assert.equal((await send(t.base, simple())).provider, 'B');
    assert.equal(t.m.A.calls.length, 2);
    assert.equal(t.app.store.queryEvents({ type: 'cost_retry' }).length, 0);
    t.app.config.updateSettings({ cacheTtlSec: 0 });
    assert.equal(t.app.state.isWarm(p, key, 'full'), false);
  } finally { await t.close(); }
});

test('cost retry can recover on the same provider even when ordinary attempts are exhausted', async () => {
  const t = await setup([
    { name: 'A', behavior: (c) => c.n ? ok(c) : err(503, 'api_error', 'internal error') },
    { name: 'B', behavior: (c) => ok(c) },
  ], { maxAttempts: 1 });
  try {
    assert.equal((await send(t.base, largeRequest())).provider, 'A');
    assert.equal(t.m.A.calls.length, 2);
    assert.equal(t.m.B.calls.length, 0);
    assert.equal(t.app.store.queryRequests({ kind: 'messages' })[0].attempts[1].costAwareRetry, 1);
  } finally { await t.close(); }
});

test('failover reuses a ready summary on a provider with allowCompaction false, with an opt-out', async () => {
  const t = await setup([
    { name: 'A', behavior: () => err(500, 'api_error', 'internal error'), provider: { allowCompaction: true } },
    { name: 'B', behavior: (c) => ok(c), provider: { allowCompaction: false } },
  ]);
  try {
    const body = convo(21);
    readySummary(t.app, body);
    t.app.state.learnRejected(t.app.config.provider('A'), 30000);
    assert.equal((await send(t.base, body)).provider, 'B');
    assert.equal(hasSummary(t.m.A.calls[0]), true);
    assert.equal(hasSummary(t.m.B.calls[0]), true);
    let row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.equal(row.compacted_failover, 1);
    assert.equal(row.attempts[1].compactedFailover, true);
    assert.equal(t.app.store.queryEvents({ type: 'compacted_failover' }).length, 1);
    t.app.config.updateSettings({ compaction: { compactOnFailover: false } });
    assert.equal((await send(t.base, body)).provider, 'B');
    assert.deepEqual(t.m.B.calls[1].body.messages, body.messages);
    row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.equal(row.compacted_failover, 0);
  } finally { await t.close(); }
});

test('new cache settings have defaults and normalize nested panel updates', async () => {
  const t = await setup([{ name: 'A', behavior: (c) => ok(c) }]);
  try {
    const s = t.app.config.settings;
    assert.equal(s.cacheTtlSec, 300);
    assert.deepEqual(s.costAwareFailover, { minTokens: 100000, extraRetries: 2 });
    assert.equal(s.compaction.compactOnFailover, true);
    t.app.config.updateSettings({ cacheTtlSec: -1, costAwareFailover: { extraRetries: 1.8 }, compaction: { compactOnFailover: false } });
    assert.equal(s.cacheTtlSec, 0);
    assert.deepEqual(s.costAwareFailover, { minTokens: 100000, extraRetries: 1 });
    assert.equal(s.compaction.compactOnFailover, false);
  } finally { await t.close(); }
});

test('byte-limited text requests answer "prompt is too long" with a token gap, including learned-byte skips', async () => {
  const t = await setup([{ name: 'A', behavior: () => ({ status: 413, raw: 'Request Entity Too Large' }) }]);
  try {
    for (let i = 0; i < 2; i++) {
      const r = await send(t.base, convo(5));
      assert.equal(r.status, 400);
      assert.match(r.json.error.message, /^Prompt is too long: (\d+) tokens > (\d+) maximum/);
      const [, actual, max] = r.json.error.message.match(/(\d+) tokens > (\d+)/).map(Number);
      assert.ok(actual > max, 'Claude Code reads a positive gap');
      assert.match(r.json.error.message, /字节上限/);
    }
    assert.equal(t.m.A.calls.length, 1);
  } finally { await t.close(); }
});

const REACTIVE_UA = 'claude-cli/2.1.295 (external, claude-desktop-3p, agent-sdk/0.3.295)';

test('size hold: byte 413 stays on the cheap relay, no cold failover and no router summary for reactive Claude Code', async () => {
  const t = await setup([
    { name: 'A', behavior: () => ({ status: 413, raw: '<html>413 Request Entity Too Large</html>' }), provider: { allowCompaction: true } },
    { name: 'B', behavior: (c) => ok(c) },
  ]);
  try {
    let schedules = 0;
    const orig = t.app.compactor.schedule.bind(t.app.compactor);
    t.app.compactor.schedule = (...a) => { schedules++; return orig(...a); };
    const body = convo(21);
    const r = await send(t.base, body, { ua: REACTIVE_UA });
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /^Prompt is too long: \d+ tokens > \d+ maximum/);
    assert.equal(t.m.B.calls.length, 0, 'the full history never goes to the cold relay');
    assert.equal(schedules, 0, 'Claude Code compacts by itself');
    // Claude Code's own compaction request also exceeds the learned byte limit: same answer, still no failover.
    const compact = convo(31);
    compact.messages.at(-1).content = [{ type: 'text', text: 'Your task is to create a detailed summary of the conversation so far.' }];
    const r2 = await send(t.base, compact, { ua: REACTIVE_UA });
    assert.equal(r2.status, 400);
    assert.match(r2.json.error.message, /^Prompt is too long/);
    assert.equal(t.m.A.calls.length, 1, 'known-oversized bodies are not re-sent');
    assert.equal(t.m.B.calls.length, 0);
    const row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.equal(row.status, 400);
    assert.match(row.error, /交回客户端/);
  } finally { await t.close(); }
});

test('size hold: older or unknown clients still get a router summary scheduled, on the same relay', async () => {
  const t = await setup([
    { name: 'A', behavior: (c) => tooLong(c) ? ctxErr() : ok(c, isSummarizer(c) ? 'OLD-CLIENT-SUMMARY' : 'ok'), provider: { allowCompaction: true } },
    { name: 'B', behavior: (c) => ok(c) },
  ]);
  try {
    const body = convo(21);
    const r = await send(t.base, body, { ua: 'claude-cli/2.0.10 (external, cli)' });
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /^Prompt is too long/);
    assert.equal(t.m.B.calls.length, 0);
    const key = t.app.compactor.sessionKey(body);
    await waitFor(() => t.app.compactor.get(key)?.status === 'ready');
    assert.ok(t.m.B.calls.every(isSummarizer), 'B only ever sees the summarizer prompt, never the full request');
    const r2 = await send(t.base, body, { ua: 'claude-cli/2.0.10 (external, cli)' });
    assert.equal(r2.status, 200);
    assert.equal(r2.provider, 'A');
    assert.match(JSON.stringify(t.m.A.calls.at(-1).body), /context-summary/);
  } finally { await t.close(); }
});

test('size hold: media-heavy bodies keep 413 so Claude Code strips images; real outages still fail over', async () => {
  const t = await setup([
    { name: 'A', behavior: (c) => c.n === 0 ? { status: 413, raw: 'Request Entity Too Large' } : err(503, 'api_error', 'No available accounts') },
    { name: 'B', behavior: (c) => ok(c) },
  ], { sameProviderRetry: 0 });
  try {
    const body = convo(5);
    body.messages[2].content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(200000) } });
    const r = await send(t.base, body, { ua: REACTIVE_UA });
    assert.equal(r.status, 413);
    assert.equal(r.json.error.type, 'request_too_large');
    assert.equal(t.m.B.calls.length, 0);
    const r2 = await send(t.base, simple(), { ua: REACTIVE_UA });
    assert.equal(r2.provider, 'B', '503 is a real failure: fail over as before');
  } finally { await t.close(); }
});

test('reactive client detection and size settings defaults', async () => {
  const t = await setup([{ name: 'A', behavior: (c) => ok(c) }]);
  try {
    const r = t.app.router;
    const req = (ua) => ({ headers: { 'user-agent': ua } });
    assert.equal(r.clientCompactsItself(req(REACTIVE_UA)), true);
    assert.equal(r.clientCompactsItself(req('claude-cli/2.1.195 (external, cli)')), true);
    assert.equal(r.clientCompactsItself(req('claude-cli/2.1.194')), false);
    assert.equal(r.clientCompactsItself(req('claude-cli/test')), false);
    assert.equal(r.clientCompactsItself(req('curl/8')), false);
    let s = t.app.config.settings;
    assert.equal(s.sizeFailover, false);
    assert.equal(s.reactiveCompactMinVersion, '2.1.195');
    t.app.config.updateSettings({ sizeFailover: 1, reactiveCompactMinVersion: 'x' });
    s = t.app.config.settings;
    assert.equal(s.sizeFailover, false, 'only an explicit true enables it');
    assert.equal(s.reactiveCompactMinVersion, '2.1.195');
    t.app.config.updateSettings({ sizeFailover: true, reactiveCompactMinVersion: '2.2' });
    s = t.app.config.settings;
    assert.equal(s.sizeFailover, true);
    assert.equal(s.reactiveCompactMinVersion, '2.2');
  } finally { await t.close(); }
});

test('[sizeFailover] cost retries exclude auth, quota, model and genuine context errors even above the threshold', async () => {
  for (const failure of [
    err(401, 'authentication_error', 'invalid api key'),
    err(402, 'api_error', 'payment required'),
    err(404, 'api_error', 'model not found'), ctxErr(),
  ]) {
    const t = await setup([
      { name: 'A', behavior: () => failure }, { name: 'B', behavior: (c) => ok(c) },
    ], { sizeFailover: true, costAwareFailover: { minTokens: 0 } });
    try {
      assert.equal((await send(t.base, simple())).provider, 'B');
      assert.equal(t.m.A.calls.length, 1);
      assert.equal(t.app.store.queryEvents({ type: 'cost_retry' }).length, 0);
    } finally { await t.close(); }
  }
});

test('pre-commit stream errors and timeouts can use cost retries', async () => {
  for (const failure of [
    { sse: 'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"stream failed"}}\n\n' },
    'hang',
  ]) {
    const t = await setup([
      { name: 'A', behavior: (c) => c.n ? ok(c) : failure }, { name: 'B', behavior: (c) => ok(c) },
    ], { firstByteTimeoutSec: 0.1, costAwareFailover: { minTokens: 0, extraRetries: 1 } });
    try {
      assert.equal((await send(t.base, simple({ stream: true }))).provider, 'A');
      assert.equal(t.m.A.calls.length, 2);
      assert.equal(t.m.B.calls.length, 0);
      assert.equal(t.app.store.queryRequests({ kind: 'messages' })[0].attempts[1].costAwareRetry, 1);
    } finally { await t.close(); }
  }
});

test('client abort cancels the cost-aware backoff before another upstream send', async () => {
  const t = await setup([
    { name: 'A', behavior: () => 'disconnect' }, { name: 'B', behavior: (c) => ok(c) },
  ], { costAwareFailover: { minTokens: 0 } });
  const ac = new AbortController();
  try {
    const pending = fetch(t.base + '/v1/messages', {
      method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify(simple()), signal: ac.signal,
    }).then(() => null, (e) => e);
    await waitFor(() => t.app.store.queryEvents({ type: 'cost_retry' }).length === 1);
    ac.abort();
    assert.equal((await pending).name, 'AbortError');
    await waitFor(() => t.app.store.queryRequests({ kind: 'messages' }).length === 1);
    assert.equal(t.m.A.calls.length, 1);
    assert.equal(t.m.B.calls.length, 0);
    const row = t.app.store.queryRequests({ kind: 'messages' })[0];
    assert.equal(row.ok, 0);
    assert.match(row.error, /取消/);
  } finally { ac.abort(); await t.close(); }
});
