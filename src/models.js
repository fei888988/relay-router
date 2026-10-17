'use strict';
const { attempt } = require('./upstream');

// Discovery is advisory: failures never change health or discard a good list.
class Models {
  constructor({ config, state, bus }) {
    Object.assign(this, { config, state, bus });
    this.cache = new Map();
    this.inflight = new Map();
    this.suffixes = new Set();
    this.ttlMs = 10 * 60000;
  }

  suffix(p) { return '@provider=' + encodeURIComponent(p.name); }

  base(model) {
    if (typeof model !== 'string') return model;
    const i = model.lastIndexOf('@provider=');
    if (i <= 0) return model;
    const suffix = model.slice(i);
    return this.suffixes.has(suffix) || this.config.providers.some((p) => this.suffix(p) === suffix)
      ? model.slice(0, i) : model;
  }

  entry(p) {
    // A changed endpoint/key/header configuration must not reuse another catalog.
    const identity = JSON.stringify([p.baseUrl, p.apiKey, p.authHeader, p.extraHeaders]);
    let entry = this.cache.get(p.id);
    if (!entry || entry.identity !== identity) {
      entry = { identity, models: [], attemptedAt: 0, updatedAt: 0 };
      this.cache.set(p.id, entry);
    }
    return entry;
  }

  supports(p, model) {
    const ids = this.entry(p).models;
    return !ids.length || ids.some((m) => m.id === model);
  }

  view(p) {
    const e = this.entry(p);
    return { models: e.models.map((m) => m.id), modelsUpdatedAt: e.updatedAt };
  }

  async refresh(p, force = false) {
    if (!this.state.isConfigured(p)) return;
    const e = this.entry(p);
    if (this.inflight.has(e)) return this.inflight.get(e);
    if (!force && Date.now() - e.attemptedAt < this.ttlMs) return;
    e.attemptedAt = Date.now();
    const work = (async () => {
      try {
        const r = await attempt({ provider: p, method: 'GET', pathname: '/v1/models',
          clientHeaders: { 'anthropic-version': '2023-06-01' },
          settings: { ...this.config.settings, firstByteTimeoutSec: 20, nonStreamTimeoutSec: 20 } });
        if (r.ok && !r.stream && Array.isArray(r.json?.data) && r.json.data.every((m) => m && typeof m.id === 'string' && m.id.length)) {
          e.models = r.json.data.map((m) => ({ id: m.id, display_name: m.display_name || m.id,
            created_at: m.created_at || '1970-01-01T00:00:00Z' }));
          e.updatedAt = Date.now();
          this.bus.stateChanged();
        } else if (r.ok && r.stream) await r.reader.cancel();
      } catch {} finally { this.inflight.delete(e); }
    })();
    this.inflight.set(e, work);
    return work;
  }

  async refreshAll({ blockingOnlyCold = false } = {}) {
    await Promise.all(this.config.providers.map((p) => {
      const work = this.refresh(p);
      if (!blockingOnlyCold || !this.entry(p).updatedAt) return work;
      work?.catch?.(() => {});
    }));
  }

  list() {
    const seen = new Set();
    const data = [];
    for (const p of this.config.providers) {
      if (!this.state.isConfigured(p)) continue;
      const suffix = this.suffix(p);
      this.suffixes.add(suffix);
      for (const m of this.entry(p).models) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        // id stays the official name: Claude Code / the desktop catalog match capabilities
        // (effort levels etc.) by exact id, so the relay name lives only in display_name.
        data.push({ ...m, type: 'model', id: m.id, display_name: m.display_name + ' (' + p.name + ')' });
      }
    }
    return { data, has_more: false, first_id: data[0]?.id || null, last_id: data.at(-1)?.id || null };
  }
}

module.exports = { Models };
