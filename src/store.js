'use strict';
// SQLite-backed request & event log (node:sqlite, no external deps).
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class Store {
  constructor(dataDir) {
    this.db = new DatabaseSync(path.join(dataDir, 'logs.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        session TEXT,
        model TEXT,
        stream INTEGER,
        est_tokens INTEGER,
        sent_tokens INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read INTEGER,
        cache_write INTEGER,
        provider_id TEXT,
        status INTEGER,
        ok INTEGER,
        duration_ms INTEGER,
        ttfb_ms INTEGER,
        attempts TEXT,
        compacted INTEGER DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_req_ts ON requests(ts);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        provider_id TEXT,
        message TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ev_ts ON events(ts);
    `);
    // Additive migration for existing request logs.
    const columns = new Set(this.db.prepare('PRAGMA table_info(requests)').all().map((c) => c.name));
    for (const name of ['client_compact', 'cost_aware_retry', 'compacted_failover']) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE requests ADD COLUMN ${name} INTEGER DEFAULT 0`);
    }
    this.insReq = this.db.prepare(`INSERT INTO requests
      (ts, kind, session, model, stream, est_tokens, sent_tokens, input_tokens, output_tokens, cache_read, cache_write,
       provider_id, status, ok, duration_ms, ttfb_ms, attempts, compacted, error, client_compact, cost_aware_retry, compacted_failover)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insEv = this.db.prepare(
      'INSERT INTO events (ts, level, type, provider_id, message, detail) VALUES (?, ?, ?, ?, ?, ?)'
    );
  }

  addRequest(r) {
    const n = (v) => (v == null || Number.isNaN(v) ? null : v);
    const info = this.insReq.run(
      r.ts, r.kind, n(r.session), n(r.model), r.stream ? 1 : 0, n(r.estTokens), n(r.sentTokens),
      n(r.inputTokens), n(r.outputTokens), n(r.cacheRead), n(r.cacheWrite), n(r.providerId), n(r.status),
      r.ok ? 1 : 0, n(r.durationMs), n(r.ttfbMs), JSON.stringify(r.attempts || []), r.compacted ? 1 : 0, n(r.error),
      r.clientCompact ? 1 : 0, r.costAwareRetry ? 1 : 0, r.compactedFailover ? 1 : 0
    );
    return Number(info.lastInsertRowid);
  }

  addEvent(e) {
    const info = this.insEv.run(
      e.ts, e.level, e.type, e.providerId || null, e.message, e.detail ? JSON.stringify(e.detail) : null
    );
    return Number(info.lastInsertRowid);
  }

  queryRequests({ limit = 100, beforeId, providerId, ok, kind, q, session } = {}) {
    const where = [];
    const args = [];
    if (beforeId) where.push('id < ?') && args.push(beforeId);
    if (providerId) where.push('provider_id = ?') && args.push(providerId);
    if (ok === '1' || ok === '0') where.push('ok = ?') && args.push(Number(ok));
    if (ok === 'failover') where.push("json_array_length(attempts) > 1");
    if (kind) where.push('kind = ?') && args.push(kind);
    if (session) where.push('session = ?') && args.push(session);
    if (q) {
      where.push('(model LIKE ? OR error LIKE ? OR attempts LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const sql = `SELECT * FROM requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT ?`;
    args.push(Math.min(500, Number(limit) || 100));
    return this.db.prepare(sql).all(...args).map((r) => ({ ...r, attempts: safeJson(r.attempts, []) }));
  }

  queryEvents({ limit = 200, beforeId, level, type } = {}) {
    const where = [];
    const args = [];
    if (beforeId) where.push('id < ?') && args.push(beforeId);
    if (level) where.push('level = ?') && args.push(level);
    if (type) where.push('type = ?') && args.push(type);
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    args.push(Math.min(1000, Number(limit) || 200));
    return this.db.prepare(sql).all(...args).map((e) => ({ ...e, detail: safeJson(e.detail, null) }));
  }

  // Aggregates for the dashboard: per-provider stats + hourly timeline over the window.
  stats(sinceMs) {
    const per = this.db
      .prepare(
        `SELECT provider_id, COUNT(*) AS total, SUM(ok) AS ok,
          SUM(CASE WHEN json_array_length(attempts) > 1 THEN 1 ELSE 0 END) AS failovers,
          AVG(CASE WHEN ok = 1 THEN duration_ms END) AS avg_ms,
          AVG(CASE WHEN ok = 1 AND stream = 1 THEN ttfb_ms END) AS avg_ttfb,
          SUM(COALESCE(input_tokens,0)) AS input_tokens, SUM(COALESCE(output_tokens,0)) AS output_tokens,
          SUM(COALESCE(cache_read,0)) AS cache_read, SUM(COALESCE(cache_write,0)) AS cache_write,
          SUM(compacted) AS compacted
         FROM requests WHERE ts >= ? AND kind = 'messages' GROUP BY provider_id`
      )
      .all(sinceMs);
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(ok) AS ok,
          SUM(CASE WHEN json_array_length(attempts) > 1 THEN 1 ELSE 0 END) AS failovers,
          SUM(compacted) AS compacted
         FROM requests WHERE ts >= ? AND kind = 'messages'`
      )
      .get(sinceMs);
    const timeline = this.db
      .prepare(
        `SELECT (ts / 3600000) * 3600000 AS hour, COALESCE(provider_id, '_none') AS provider_id, COUNT(*) AS n,
          SUM(1 - ok) AS failed
         FROM requests WHERE ts >= ? AND kind = 'messages' GROUP BY hour, provider_id ORDER BY hour`
      )
      .all(sinceMs);
    return { per, totals, timeline };
  }

  cleanup(retentionDays) {
    const cutoff = Date.now() - retentionDays * 86400000;
    this.db.prepare('DELETE FROM requests WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}

function safeJson(s, dflt) {
  try {
    return s ? JSON.parse(s) : dflt;
  } catch {
    return dflt;
  }
}

module.exports = { Store };
