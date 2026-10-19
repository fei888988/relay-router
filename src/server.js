'use strict';
// HTTP entry: /v1/* -> router, /api/* -> panel API, everything else -> panel static files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Config, DATA_DIR } = require('./config');
const { Store } = require('./store');
const { Bus } = require('./events');
const { State } = require('./state');
const { Compactor } = require('./compaction');
const { Router } = require('./proxy');
const { Prober } = require('./prober');
const { Models } = require('./models');
const { CodexRouter } = require('./codex');
const { readCcSwitchProviders, ccSwitchDbPath } = require('./ccswitch');
const { maskKey, truncate } = require('./util');
const { CATEGORIES } = require('./classify');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

function createApp({ dataDir = DATA_DIR } = {}) {
  const config = new Config(dataDir).load();
  const store = new Store(dataDir);
  const bus = new Bus(store);
  const state = new State(config, bus, dataDir);
  const compactor = new Compactor({ config, state, bus, store, dataDir });
  const models = new Models({ config, state, bus });
  const router = new Router({ config, state, bus, store, compactor, models });
  const prober = new Prober({ config, state, bus, store, models });
  const codex = new CodexRouter({ config, state, bus, store, checkKey: (req) => router.checkKey(req) });
  const sseClients = new Set();

  bus.on('push', (msg) => {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of sseClients) c.write(line);
  });

  const s = () => config.settings;
  const hostOk = (req) => {
    const h = (req.headers.host || '').toLowerCase();
    return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h);
  };

  function providerView(p) {
    const h = state.health(p.id);
    const l = state.learned(p.id);
    const mu = state.data.modelUnavailable[p.id] || {};
    return {
      ...p,
      ...models.view(p),
      apiKey: undefined,
      apiKeyMasked: maskKey(p.apiKey),
      hasKey: !!p.apiKey,
      configured: state.isConfigured(p),
      usable: state.isUsable(p),
      health: h,
      learned: l,
      effectiveLimit: state.effectiveLimit(p),
      hintDisproven: state.hintDisproven(p),
      calibration: state.data.calibration[p.id] || null,
      lastGoodModel: state.data.lastGoodModel[p.id] || null,
      modelUnavailable: Object.entries(mu).filter(([, t]) => t > Date.now()).map(([m, t]) => ({ model: m, until: t })),
      probing: prober.inflight.has(p.id),
    };
  }

  function status() {
    const active = state.activeProvider();
    const since = Date.now() - 86400000;
    const st = store.stats(since);
    return {
      now: Date.now(),
      settings: { ...s(), routerKey: s().routerKey },
      providers: config.providers.map(providerView),
      activeProviderId: active ? active.id : null,
      lastResort: state.candidates().lastResort,
      stats: st,
      compaction: { running: compactor.running.size, sessions: Object.keys(compactor.sessions).length },
      categories: CATEGORIES,
      ccSwitchDb: ccSwitchDbPath(),
      baseUrl: `http://${s().host}:${s().port}`,
      codex: codex.summary(),
    };
  }

  async function api(req, res, url) {
    const m = req.method;
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop 'api'
    if (m !== 'GET' && req.headers['x-panel'] !== '1') return json(res, 403, { error: 'forbidden' });
    const q = Object.fromEntries(url.searchParams);
    const body = m === 'GET' ? {} : await readJson(req).catch(() => ({}));
    if (parts[0] === 'codex') return json(res, 200, await codex.api(m, parts.slice(1), body,
      `http://${req.headers.host}/codex/v1`));
    const prov = (id) => {
      const p = config.provider(id);
      if (!p) throw Object.assign(new Error('中转站不存在'), { status: 404 });
      return p;
    };

    // GET endpoints
    if (m === 'GET' && parts[0] === 'status') return json(res, 200, status());
    if (m === 'GET' && parts[0] === 'requests') return json(res, 200, store.queryRequests(q));
    if (m === 'GET' && parts[0] === 'events') return json(res, 200, store.queryEvents(q));
    if (m === 'GET' && parts[0] === 'sessions' && !parts[1]) return json(res, 200, compactor.list());
    if (m === 'GET' && parts[0] === 'sessions' && parts[1]) {
      const x = compactor.get(parts[1]);
      return x ? json(res, 200, x) : json(res, 404, { error: '会话不存在' });
    }
    if (m === 'GET' && parts[0] === 'ccswitch') {
      return json(res, 200, readCcSwitchProviders().map((p) => ({ ...p, apiKey: undefined, apiKeyMasked: maskKey(p.apiKey), imported: config.providers.some((x) => x.ccSwitchId === p.id) })));
    }
    if (m === 'GET' && parts[0] === 'stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    // Mutations
    if (m === 'POST' && parts[0] === 'mode') {
      if (body.mode === 'pinned') {
        prov(body.providerId);
        config.updateSettings({ mode: 'pinned', pinnedProviderId: body.providerId });
        bus.log('warn', 'mode', `已手动锁定到 ${config.provider(body.providerId).name}（自动切换已暂停）`, body.providerId);
      } else {
        config.updateSettings({ mode: 'auto', pinnedProviderId: null });
        bus.log('info', 'mode', '已恢复自动路由');
      }
      state.refreshActive('手动操作');
      return json(res, 200, status());
    }
    if (m === 'POST' && parts[0] === 'settings') {
      config.updateSettings(body);
      bus.log('info', 'settings', '设置已保存');
      state.refreshActive();
      return json(res, 200, status());
    }
    if (m === 'POST' && parts[0] === 'regenerate-key') {
      config.regenerateKey();
      bus.log('warn', 'settings', '路由密钥已重新生成，请同步更新 CC Switch');
      return json(res, 200, status());
    }
    if (m === 'POST' && parts[0] === 'import') {
      const src = readCcSwitchProviders();
      const added = [];
      for (const item of body.items || []) {
        const c = src.find((x) => x.id === item.ccSwitchId);
        if (!c) continue;
        if (item.targetId) {
          config.upsertProvider({ id: item.targetId, apiKey: c.apiKey, baseUrl: c.baseUrl, authHeader: c.authHeader, ccSwitchId: c.id });
          added.push(config.provider(item.targetId).name);
        } else {
          const p = config.upsertProvider({ name: item.name || c.name, baseUrl: c.baseUrl, apiKey: c.apiKey, authHeader: c.authHeader, ccSwitchId: c.id });
          added.push(p.name);
        }
      }
      if (added.length) bus.log('info', 'config', `已从 CC Switch 导入：${added.join('、')}`);
      state.refreshActive();
      return json(res, 200, status());
    }
    if (m === 'POST' && parts[0] === 'providers' && !parts[1]) {
      if (!body.name || !body.baseUrl) return json(res, 400, { error: '名称和地址必填' });
      const p = config.upsertProvider({ ...body, id: undefined });
      bus.log('info', 'config', `新增中转站 ${p.name}`, p.id);
      state.refreshActive();
      return json(res, 200, status());
    }
    if (parts[0] === 'providers' && parts[1]) {
      const p = prov(parts[1]);
      const action = parts[2];
      if (m === 'PUT' && !action) {
        config.upsertProvider({ ...body, id: p.id });
        bus.log('info', 'config', `已更新中转站 ${body.name || p.name}`, p.id);
        state.refreshActive();
        return json(res, 200, status());
      }
      if (m === 'DELETE' && !action) {
        config.removeProvider(p.id);
        bus.log('warn', 'config', `已删除中转站 ${p.name}`);
        state.refreshActive();
        return json(res, 200, status());
      }
      if (m === 'POST' && action === 'probe') {
        const r = await prober.probe(p, { manual: true });
        return json(res, 200, { result: r, status: status() });
      }
      if (m === 'POST' && action === 'reset') {
        state.reset(p);
        return json(res, 200, status());
      }
      if (m === 'POST' && action === 'toggle') {
        config.upsertProvider({ id: p.id, enabled: !p.enabled });
        bus.log('info', 'config', `${p.name} 已${config.provider(p.id).enabled ? '启用' : '停用'}`, p.id);
        state.refreshActive('手动' + (config.provider(p.id).enabled ? '启用' : '停用'));
        return json(res, 200, status());
      }
      if (m === 'POST' && action === 'offline') {
        state.markDown(p, 'manual', '手动下线');
        return json(res, 200, status());
      }
      if (m === 'POST' && (action === 'up' || action === 'down')) {
        config.moveProvider(p.id, action);
        bus.log('info', 'config', `已调整优先级：${config.providers.map((x) => x.name).join(' > ')}`);
        state.refreshActive('优先级调整');
        return json(res, 200, status());
      }
      if (m === 'POST' && action === 'forget') {
        state.forgetLearned(p);
        bus.log('info', 'learn', `已清除 ${p.name} 学到的上下文上限`, p.id);
        return json(res, 200, status());
      }
      if (m === 'GET' && action === 'balance') {
        const { attempt } = require('./upstream');
        const r = await attempt({ provider: p, method: 'GET', pathname: '/api/usage/token', clientHeaders: {}, settings: { ...s(), firstByteTimeoutSec: 15, nonStreamTimeoutSec: 15 } });
        if (r.ok && r.json && r.json.data) return json(res, 200, r.json.data);
        return json(res, 200, { error: r.ok ? '该中转站不支持查询' : truncate(r.text, 200) });
      }
    }
    if (m === 'DELETE' && parts[0] === 'sessions' && parts[1]) {
      compactor.remove(parts[1]);
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && parts[0] === 'sessions' && parts[1] && parts[2] === 'reset') {
      compactor.invalidate(parts[1], '已手动丢弃摘要');
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }

  function serveStatic(req, res, url) {
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      return res.end();
    }
    try {
      if (url.pathname.startsWith('/codex/v1/')) return await codex.handle(req, res, url);
      if (url.pathname.startsWith('/v1/')) return await router.handle(req, res, url);
      if (!hostOk(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('forbidden host');
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method === 'HEAD' || (req.method === 'GET' && url.pathname === '/health')) return json(res, 200, { ok: true });
      return serveStatic(req, res, url);
    } catch (e) {
      console.error('[server]', e);
      if (!res.headersSent) json(res, e.status || 500, { error: e.message });
      else res.end();
    }
  });
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/codex/v1/')) return socket.destroy();
    // Codex falls back to Responses over HTTP when WebSocket negotiation fails.
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;

  let cleanupTimer = null;
  return {
    config, store, bus, state, compactor, router, prober, models, codex, server,
    listen(port = s().port, host = s().host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          prober.start();
          codex.start();
          store.cleanup(s().logRetentionDays);
          cleanupTimer = setInterval(() => store.cleanup(s().logRetentionDays), 6 * 3600000);
          state.data.activeProviderId = (state.activeProvider() || {}).id || null;
          resolve(server.address());
        });
      });
    },
    async close() {
      prober.stop();
      await codex.stop();
      clearInterval(cleanupTimer);
      for (const c of sseClients) c.end();
      state.save(true);
      compactor.save(true);
      const closed = new Promise((r) => server.close(() => r()));
      server.closeAllConnections && server.closeAllConnections();
      await closed;
      store.close();
    },
  };
}

module.exports = { createApp };
