'use strict';
// Runtime state: provider health / circuit breaker, learned context limits, model availability.
// Persisted to data/state.json so a restart keeps "provider is out of quota" etc.
const fs = require('node:fs');
const path = require('node:path');

const REASON_TEXT = {
  quota: '额度不足',
  auth: '令牌无效',
  failures: '连续报错',
  rate_limit: '被限流',
  manual: '手动下线',
};

class State {
  constructor(config, bus, dataDir) {
    this.config = config;
    this.bus = bus;
    this.file = path.join(dataDir, 'state.json');
    this.data = { health: {}, learned: {}, calibration: {}, modelUnavailable: {}, lastGoodModel: {}, activeProviderId: null };
    try {
      if (fs.existsSync(this.file)) Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {}
    this.lastClientHeaders = this.data.lastClientHeaders || null;
    this.saveTimer = null;
    this.warm = new Map(); // In-memory prompt-cache hints; never persisted across restarts.
  }

  save(immediate) {
    const write = () => {
      this.saveTimer = null;
      this.data.lastClientHeaders = this.lastClientHeaders;
      try {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2));
        fs.renameSync(this.file + '.tmp', this.file);
      } catch (e) {
        console.error('[state] save failed', e.message);
      }
    };
    if (immediate) {
      clearTimeout(this.saveTimer);
      return write();
    }
    if (!this.saveTimer) this.saveTimer = setTimeout(write, 1000);
  }

  get s() {
    return this.config.settings;
  }

  health(id) {
    if (!this.data.health[id]) {
      this.data.health[id] = {
        status: 'healthy', // healthy | cooldown | down
        consecutiveFailures: 0,
        cooldownUntil: 0,
        downReason: null,
        downSince: 0,
        nextProbeAt: 0,
        lastOkAt: 0,
        lastError: null,
        lastProbe: null,
      };
    }
    return this.data.health[id];
  }

  isConfigured(p) {
    return !!(p && p.enabled && p.apiKey && p.baseUrl);
  }

  isUsable(p) {
    if (!this.isConfigured(p)) return false;
    const h = this.health(p.id);
    if (h.status === 'down') return false;
    if (h.status === 'cooldown' && h.cooldownUntil > Date.now()) return false;
    return true;
  }

  // Ordered list of providers to try for a request.
  candidates(accepts = () => true) {
    const s = this.s;
    const all = this.config.providers.filter(accepts);
    if (s.mode === 'pinned' && s.pinnedProviderId && accepts(this.config.provider(s.pinnedProviderId))) {
      const p = this.config.provider(s.pinnedProviderId);
      return { list: p && this.isConfigured(p) ? [p] : [], lastResort: false };
    }
    const usable = all.filter((p) => this.isUsable(p));
    if (usable.length) return { list: usable, lastResort: false };
    // Everything is offline: try every configured provider anyway, in priority order.
    return { list: all.filter((p) => this.isConfigured(p)), lastResort: true };
  }

  recordSuccess(p, { viaProbe = false } = {}) {
    const h = this.health(p.id);
    const wasBad = h.status !== 'healthy';
    h.status = 'healthy';
    h.consecutiveFailures = 0;
    h.cooldownUntil = 0;
    h.downReason = null;
    h.nextProbeAt = 0;
    h.lastOkAt = Date.now();
    if (wasBad) {
      this.bus.log('success', 'recover', `${p.name} 已恢复${viaProbe ? '（探针检测通过）' : ''}`, p.id);
      this.refreshActive('恢复');
    }
    this.save();
  }

  // Returns true if the provider was taken offline by this failure.
  recordFailure(p, cls, { message, status, retryAfterSec } = {}) {
    const h = this.health(p.id);
    h.lastError = { ts: Date.now(), category: cls.category, label: cls.label, status: status || null, message: message || '' };
    let downed = false;
    if (cls.penalty === 'fatal') {
      this.markDown(p, cls.category, message);
      downed = true;
    } else if (cls.penalty === 'cooldown') {
      h.consecutiveFailures++;
      const sec = Math.min(Math.max(retryAfterSec || this.s.cooldownSec, 5), 3600);
      if (h.consecutiveFailures >= this.s.failureThreshold) {
        this.markDown(p, 'rate_limit', message);
        downed = true;
      } else {
        h.status = 'cooldown';
        h.cooldownUntil = Date.now() + sec * 1000;
        this.bus.log('warn', 'cooldown', `${p.name} ${cls.label}，冷却 ${sec} 秒`, p.id, { message });
        this.refreshActive(cls.label);
      }
    } else if (cls.penalty === 'soft') {
      h.consecutiveFailures++;
      if (h.consecutiveFailures >= this.s.failureThreshold) {
        this.markDown(p, 'failures', message);
        downed = true;
      }
    }
    this.save();
    this.bus.stateChanged();
    return downed;
  }

  markDown(p, reason, message) {
    const h = this.health(p.id);
    const already = h.status === 'down';
    h.status = 'down';
    h.downReason = reason;
    h.downSince = already ? h.downSince : Date.now();
    h.nextProbeAt = Date.now() + this.s.probeIntervalMin * 60000;
    if (!already) {
      const why = REASON_TEXT[reason] || reason;
      this.bus.log(
        reason === 'manual' ? 'info' : 'error',
        'down',
        `${p.name} 已下线（${why}），之后每 ${this.s.probeIntervalMin} 分钟探测一次`,
        p.id,
        { message }
      );
      this.refreshActive(why);
    }
    this.save();
  }

  reset(p) {
    delete this.data.health[p.id];
    delete this.data.modelUnavailable[p.id];
    this.health(p.id);
    this.bus.log('info', 'reset', `${p.name} 状态已手动重置`, p.id);
    this.refreshActive('手动重置');
    this.save();
  }

  // --- learned context limits (in our estimated-token units) ---
  learned(id) {
    const l = this.data.learned[id];
    if (!l) return {};
    const ttl = this.s.learnedLimitTtlHours * 3600000;
    for (const field of ['minRejected', 'maxAccepted', 'minRejectedBytes', 'maxAcceptedBytes']) {
      if (!l[field]) continue;
      if (!l[field + 'At']) l[field + 'At'] = Date.now();
      if (Date.now() - l[field + 'At'] > ttl) {
        delete l[field];
        delete l[field + 'At'];
      }
    }
    return l;
  }

  learnRejected(p, est) {
    if (!est) return;
    this.learned(p.id);
    const l = (this.data.learned[p.id] = this.data.learned[p.id] || {});
    if (!l.minRejected || est < l.minRejected) {
      l.minRejected = est;
      l.minRejectedAt = Date.now();
      if (l.maxAccepted && l.maxAccepted >= est) l.maxAccepted = Math.floor(est * 0.9);
      this.bus.log('info', 'learn', `已记录 ${p.name} 的上下文上限 ≈ ${Math.round(est / 1000)}k（估算）`, p.id, { est });
    } else {
      l.minRejectedAt = Date.now();
    }
    this.save();
  }

  learnAccepted(p, est) {
    if (!est) return;
    this.learned(p.id);
    const l = (this.data.learned[p.id] = this.data.learned[p.id] || {});
    if (!l.maxAccepted || est > l.maxAccepted) l.maxAccepted = est;
    l.maxAcceptedAt = Date.now();
    if (l.minRejected && est >= l.minRejected) {
      // Accepted something we thought was too big: limit moved or estimate drifted.
      delete l.minRejected;
      delete l.minRejectedAt;
    }
    this.save();
  }

  forgetLearned(p) {
    delete this.data.learned[p.id];
    this.save();
  }

  // Best known context limit (estimated tokens); null if unknown.
  // A configured hint stops counting once the provider has accepted clearly larger requests,
  // otherwise a growing session would always look "near the limit".
  effectiveLimit(p) {
    const l = this.learned(p.id);
    if (l.minRejected) return l.minRejected;
    if (p.contextLimit && !(l.maxAccepted > p.contextLimit * 1.1)) return p.contextLimit;
    return null;
  }

  hintDisproven(p) {
    const l = this.learned(p.id);
    return !!(p.contextLimit && !l.minRejected && l.maxAccepted > p.contextLimit * 1.1);
  }

  // True when we already know this request size gets rejected by the provider.
  tooBigFor(p, est, bytes = 0) {
    const l = this.learned(p.id);
    return !!((l.minRejected && est >= Math.max(l.minRejected * 0.97, (l.maxAccepted || 0) + 1)) || this.tooManyBytes(p, bytes));
  }

  tooManyBytes(p, bytes) {
    const l = this.learned(p.id);
    return !!(bytes && l.minRejectedBytes && bytes >= Math.max(l.minRejectedBytes * 0.97, (l.maxAcceptedBytes || 0) + 1));
  }

  effectiveByteLimit(p) {
    return this.learned(p.id).minRejectedBytes || null;
  }

  learnRejectedBytes(p, bytes) {
    if (!bytes) return;
    this.learned(p.id);
    const l = (this.data.learned[p.id] = this.data.learned[p.id] || {});
    l.minRejectedBytes = Math.min(l.minRejectedBytes || bytes, bytes);
    l.minRejectedBytesAt = Date.now();
    if (l.maxAcceptedBytes >= bytes) l.maxAcceptedBytes = Math.floor(bytes * 0.9);
    this.bus.log('info', 'learn', `已记录 ${p.name} 的请求体上限 ≈ ${Math.round(bytes / 1024)} KiB`, p.id, { bytes });
    this.save();
  }

  learnAcceptedBytes(p, bytes) {
    if (!bytes) return;
    this.learned(p.id);
    const l = (this.data.learned[p.id] = this.data.learned[p.id] || {});
    l.maxAcceptedBytes = Math.max(l.maxAcceptedBytes || 0, bytes);
    l.maxAcceptedBytesAt = Date.now();
    if (bytes >= l.minRejectedBytes) {
      delete l.minRejectedBytes;
      delete l.minRejectedBytesAt;
    }
    this.save();
  }

  markWarm(p, key, variant) {
    if (!key) return;
    const cutoff = Date.now() - this.s.cacheTtlSec * 1000;
    for (const [k, ts] of this.warm) if (ts <= cutoff) this.warm.delete(k);
    this.warm.set(JSON.stringify([p.id, key, variant]), Date.now());
  }

  isWarm(p, key, variant) {
    const ts = this.warm.get(JSON.stringify([p.id, key, variant]));
    return !!(ts && Date.now() - ts < this.s.cacheTtlSec * 1000);
  }

  // --- model availability ---
  markModelUnavailable(p, model) {
    const m = (this.data.modelUnavailable[p.id] = this.data.modelUnavailable[p.id] || {});
    const fresh = !m[model] || m[model] < Date.now();
    m[model] = Date.now() + this.s.modelUnavailableTtlMin * 60000;
    if (fresh) this.bus.log('warn', 'model', `${p.name} 不支持模型 ${model}，该模型暂时改走其他中转站`, p.id);
    this.save();
  }

  isModelUnavailable(p, model) {
    const until = this.data.modelUnavailable[p.id] && this.data.modelUnavailable[p.id][model];
    return !!(until && until > Date.now());
  }

  setLastGoodModel(p, model) {
    if (model && this.data.lastGoodModel[p.id] !== model) {
      this.data.lastGoodModel[p.id] = model;
      this.save();
    }
  }

  // --- token estimate calibration (actual input / estimate), per provider ---
  calibrate(p, est, actual) {
    if (!est || !actual || est < 500) return;
    const r = actual / est;
    if (r < 0.3 || r > 4) return;
    const c = (this.data.calibration[p.id] = this.data.calibration[p.id] || { ratio: r, n: 0 });
    c.ratio = c.n === 0 ? r : c.ratio * 0.9 + r * 0.1;
    c.n++;
    this.save();
  }

  // --- "active" route: first provider normal traffic goes to ---
  activeProvider() {
    const { list } = this.candidates();
    return list[0] || null;
  }

  refreshActive(reason) {
    const p = this.activeProvider();
    const id = p ? p.id : null;
    const prev = this.data.activeProviderId;
    if (id !== prev) {
      this.data.activeProviderId = id;
      const prevP = prev && this.config.provider(prev);
      const from = prevP ? prevP.name : '无';
      const to = p ? p.name : '无可用中转站';
      const order = (x) => this.config.providers.findIndex((q) => q.id === x);
      const level = !p ? 'error' : prev && order(id) < order(prev) ? 'success' : 'warn';
      this.bus.log(level, 'switch', `主路由切换：${from} → ${to}${reason ? `（${reason}）` : ''}`, id);
      this.save();
    }
    this.bus.stateChanged();
  }
}

module.exports = { State, REASON_TEXT };
