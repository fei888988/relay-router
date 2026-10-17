'use strict';
// Minimal health probes for offline providers (every probeIntervalMin), plus manual "probe now".
const { attempt } = require('./upstream');
const { classify } = require('./classify');
const { truncate } = require('./util');

class Prober {
  constructor({ config, state, bus, store, models }) {
    Object.assign(this, { config, state, bus, store, models });
    this.inflight = new Set();
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 15000);
    this.startTimer = setTimeout(() => this.tick(), 3000);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.startTimer);
  }

  tick() {
    for (const p of this.config.providers) {
      if (!this.state.isConfigured(p)) continue;
      this.models.refresh(p).catch(() => {});
      const h = this.state.health(p.id);
      if (h.status === 'down' && h.nextProbeAt <= Date.now()) this.probe(p, { auto: true }).catch(() => {});
    }
  }

  async pickModel(p, exclude) {
    if (p.probeModel && p.probeModel !== exclude) return p.probeModel;
    const last = this.state.data.lastGoodModel[p.id];
    if (last && last !== exclude) return last;
    // Ask the relay which models it has; prefer a cheap one.
    await this.models.refresh(p);
    const ids = this.models.view(p).models.filter((x) => x !== exclude && !this.state.isModelUnavailable(p, x));
    const pick = ids.find((x) => /haiku/i.test(x)) || ids.find((x) => /sonnet/i.test(x)) || ids[0];
    if (pick) return pick;
    return exclude === 'claude-sonnet-4-6' ? 'claude-sonnet-5' : 'claude-sonnet-4-6';
  }

  // Returns { ok, category, label, message, model, ms }
  async probe(p, { auto = false, manual = false } = {}) {
    if (this.inflight.has(p.id)) return { ok: false, label: '探测进行中' };
    this.inflight.add(p.id);
    try {
      let model = await this.pickModel(p);
      let result = await this.once(p, model);
      if (!result.ok && result.category === 'model_unavailable') {
        this.state.markModelUnavailable(p, model);
        model = await this.pickModel(p, model);
        result = await this.once(p, model);
      }
      const h = this.state.health(p.id);
      h.lastProbe = { ts: Date.now(), ok: result.ok, label: result.label, message: result.message, model };
      if (result.ok) {
        this.state.setLastGoodModel(p, model);
        this.state.recordSuccess(p, { viaProbe: true });
        if (manual) this.bus.log('success', 'probe', `${p.name} 探测正常（${model}，${result.ms}ms）`, p.id);
      } else {
        const cls = result.cls;
        if (h.status === 'down') {
          h.nextProbeAt = Date.now() + this.config.settings.probeIntervalMin * 60000;
          if (cls && cls.penalty === 'fatal' && cls.category !== h.downReason) h.downReason = cls.category;
          this.bus.log('info', 'probe', `${p.name} 仍不可用：${result.label} ${truncate(result.message, 120)}`, p.id);
        } else if (cls && cls.penalty === 'fatal') {
          this.state.markDown(p, cls.category, result.message);
        } else if (manual) {
          this.bus.log('warn', 'probe', `${p.name} 探测失败：${result.label} ${truncate(result.message, 120)}`, p.id);
        }
        this.state.save();
        this.bus.stateChanged();
      }
      return { ...result, cls: undefined, model };
    } finally {
      this.inflight.delete(p.id);
    }
  }

  async once(p, model) {
    const t0 = Date.now();
    const body = {
      model,
      max_tokens: 1,
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const headers = { 'anthropic-version': '2023-06-01', ...(this.state.lastClientHeaders || {}), 'content-type': 'application/json' };
    delete headers['anthropic-beta'];
    const r = await attempt({
      provider: p, pathname: '/v1/messages', clientHeaders: headers, bodyBuf: Buffer.from(JSON.stringify(body)),
      settings: { ...this.config.settings, firstByteTimeoutSec: 60, nonStreamTimeoutSec: 60 },
    });
    const ms = Date.now() - t0;
    const ok = !!(r.ok && r.json && r.json.type === 'message');
    const cls = ok ? null : classify(r.ok ? { status: 502, text: '响应格式异常' } : r, this.config.settings.patterns);
    const message = ok ? null : r.ok ? '响应格式异常' : r.text;
    this.store.addRequest({
      ts: t0, kind: 'probe', model, stream: false, estTokens: 20, providerId: p.id, status: r.status || null, ok,
      durationMs: ms, ttfbMs: r.ttfbMs, inputTokens: ok && r.json.usage ? r.json.usage.input_tokens : null,
      outputTokens: ok && r.json.usage ? r.json.usage.output_tokens : null,
      attempts: [{ providerId: p.id, ok, status: r.status || null, category: cls && cls.category, label: cls && cls.label, message: truncate(message, 300), ms }],
      error: ok ? null : `${cls.label}: ${truncate(message, 300)}`,
    });
    return { ok, category: cls && cls.category, label: ok ? '正常' : cls.label, message, ms, cls };
  }
}

module.exports = { Prober };
