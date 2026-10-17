'use strict';
// Request routing: priority failover across relays, error-aware retries, context-limit handling.
const { attempt, pipeStream } = require('./upstream');
const { classify } = require('./classify');
const { estimateRequest } = require('./tokens');
const { truncate } = require('./util');
const { isClientCompact } = require('./compaction');
const { UsageRewriter, rewriteJsonUsage } = require('./usage-rewrite');
const { setTimeout: delay } = require('node:timers/promises');

const MAX_BODY = 60 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, headers) {
  if (res.headersSent) return res.end();
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, ...(headers || {}) });
  res.end(buf);
}

function anthropicError(res, status, type, message) {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

function mapModel(provider, model) {
  const map = provider.modelMap || {};
  if (!model) return model;
  if (map[model]) return map[model];
  for (const [k, v] of Object.entries(map)) {
    if (k.endsWith('*') && model.startsWith(k.slice(0, -1)) && v) return v;
  }
  return model;
}

function stripThinking(body) {
  return {
    ...body,
    messages: body.messages.map((m) => {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
      const content = m.content.filter((b) => !b || (b.type !== 'thinking' && b.type !== 'redacted_thinking'));
      return { ...m, content: content.length ? content : [{ type: 'text', text: '(…)' }] };
    }),
  };
}

const isSignatureError = (text) => /signature/i.test(text || '') && /thinking/i.test(text || '');

// "claude-cli/2.1.295 (external, ...)" -> [2, 1, 295]; null for other clients.
function claudeCliVersion(ua) {
  const m = /claude-cli\/(\d+(?:\.\d+)*)/i.exec(ua || '');
  return m ? m[1].split('.').map(Number) : null;
}

function versionAtLeast(v, min) {
  const want = String(min).split('.').map(Number);
  for (let i = 0; i < Math.max(v.length, want.length); i++) {
    const a = v[i] || 0;
    const b = want[i] || 0;
    if (a !== b) return a > b;
  }
  return true;
}

// Base64 image/document bytes: these can't be summarized away, only stripped.
function mediaBytes(body) {
  let n = 0;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (!b) continue;
      if ((b.type === 'image' || b.type === 'document') && b.source && typeof b.source.data === 'string') n += b.source.data.length;
      if (b.type === 'tool_result') walk(b.content);
    }
  };
  for (const m of (body && body.messages) || []) walk(m.content);
  return n;
}

class Router {
  constructor({ config, state, bus, store, compactor, models }) {
    Object.assign(this, { config, state, bus, store, compactor, models });
  }

  get s() {
    return this.config.settings;
  }

  checkKey(req) {
    if (!this.s.requireKey) return true;
    const k = this.s.routerKey;
    const x = req.headers['x-api-key'];
    const a = req.headers['authorization'] || '';
    return x === k || a === 'Bearer ' + k;
  }

  async handle(req, res, url) {
    if (!this.checkKey(req)) {
      return anthropicError(res, 401, 'authentication_error', '[智能路由] 路由密钥不正确：请把 CC Switch 里的 API Key 设为面板「接入指南」中的路由密钥');
    }
    if (req.method === 'GET' && /^\/v1\/models\/?$/.test(url.pathname)) {
      await this.models.refreshAll();
      return sendJson(res, 200, this.models.list());
    }
    let bodyBuf;
    try {
      bodyBuf = await readBody(req);
    } catch (e) {
      return anthropicError(res, e.status || 400, 'invalid_request_error', e.message);
    }
    const pathname = url.pathname;
    const kind =
      req.method === 'POST' && /\/v1\/messages\/?$/.test(pathname)
        ? 'messages'
        : req.method === 'POST' && /\/v1\/messages\/count_tokens\/?$/.test(pathname)
          ? 'count_tokens'
          : 'other';
    let body = null;
    if (kind !== 'other') {
      try {
        body = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        return anthropicError(res, 400, 'invalid_request_error', '[智能路由] 请求体不是合法 JSON');
      }
    }
    if (kind !== 'other') {
      body.model = this.models.base(body.model);
      bodyBuf = Buffer.from(JSON.stringify(body));
      // Only block on providers never fetched; stale catalogs refresh in the background.
      await this.models.refreshAll({ blockingOnlyCold: true });
    }
    if (kind === 'messages') {
      this.state.lastClientHeaders = pickIdentityHeaders(req.headers);
      return this.handleMessages(req, res, url, body);
    }
    if (kind === 'count_tokens') return this.handleCountTokens(req, res, url, body, bodyBuf);
    return this.handleOther(req, res, url, bodyBuf);
  }

  modelCandidates(model) {
    const filtered = this.state.candidates((p) => !p || this.models.supports(p, mapModel(p, model)));
    // No catalog lists this id (alias, new model): the filter is advisory, keep old behaviour.
    return filtered.list.length ? filtered : this.state.candidates();
  }

  async handleMessages(req, res, url, body) {
    const t0 = Date.now();
    const s = this.s;
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    const fullEst = estimateRequest(body);
    const fullBytes = Buffer.byteLength(JSON.stringify(body));
    const clientCompact = isClientCompact(body);
    const key = this.compactor.sessionKey(body);
    const { list, lastResort } = this.modelCandidates(body.model);
    const attempts = [];
    const row = {
      ts: t0, kind: 'messages', session: key, model: body.model, stream: !!body.stream, estTokens: fullEst,
      attempts, compacted: false, clientCompact,
    };
    let lastFail = null;
    let allContext = true;
    let allBytes = true;
    let sizeBlocked = false;
    let tries = 0;
    const fullRejected = new Set();
    let failedOver = false;
    // Size rejections stay on the relay that rejected (unless sizeFailover): the client is told
    // "prompt is too long" and compacts there instead of re-sending the whole history to a cold relay.
    const holdOnSize = !s.sizeFailover;
    let sizeHold = null;
    const holdSize = (p, kind, est, bytes) => {
      if (holdOnSize && !sizeHold) sizeHold = { p, kind, est, bytes };
    };
    // Claude Code that compacts by itself on "prompt is too long" needs no router summary.
    const reactive = holdOnSize && this.clientCompactsItself(req);
    const maySchedule = !clientCompact && !reactive;

    if (!list.length) {
      row.error = '没有可用的中转站';
      this.finish(row, false);
      return anthropicError(res, 503, 'overloaded_error', '[智能路由] 没有可用的中转站：请在面板中启用或配置至少一个中转站');
    }

    // Client /compact gets a full-history pass across all providers before any summary fallback.
    for (const phase of clientCompact ? ['full', 'fallback'] : ['normal']) {
      if (phase === 'fallback' && !sizeHold && !list.every((p) => fullRejected.has(p.id))) break;
      for (let i = 0; i < list.length && tries < s.maxAttempts; i++) {
        const p = list[i];
        if (phase === 'fallback' && sizeHold && p.id !== sizeHold.p.id) continue;
        const isLast = i === list.length - 1;
        const model = mapModel(p, body.model);
        if (this.state.isModelUnavailable(p, model) && !isLast) {
          attempts.push({ providerId: p.id, skipped: true, reason: `不支持 ${model}` });
          continue;
        }

        // Pick the variant to send: full history, or summary + recent turns.
        let variant = 'full';
        let sendBody = body;
        let sendEst = fullEst;
        const eligible = this.compactor.eligible(p, 'messages', body);
        const ready = s.compaction.enabled ? this.compactor.lookup(key, body) : null;
        const compactedFailover = !!(!clientCompact && failedOver && s.compaction.enabled && s.compaction.compactOnFailover && ready);
        let comp = eligible || compactedFailover ? ready : null;
        const tooBig = this.state.tooBigFor(p, fullEst, fullBytes);
        if (clientCompact && phase === 'full' && tooBig) {
          sizeBlocked = true;
          if (!this.state.tooManyBytes(p, fullBytes)) allBytes = false;
          fullRejected.add(p.id);
          attempts.push({ providerId: p.id, skipped: true, reason: '完整历史超过已知上限' });
          holdSize(p, this.state.tooManyBytes(p, fullBytes) ? 'bytes' : 'tokens', fullEst, fullBytes);
          if (sizeHold) break;
          continue;
        }
        if ((!clientCompact && ((tooBig && comp) || compactedFailover)) || (phase === 'fallback' && comp)) variant = 'compacted';
        if (phase === 'fallback' && !comp) continue;

        let extraRetries = 0;
        let costRetry = false;
        for (let retry = 0; ; retry++) {
          if (variant === 'compacted') {
            sendBody = this.compactor.apply(body, comp);
            sendEst = estimateRequest(sendBody);
          } else {
            sendBody = body;
            sendEst = fullEst;
          }
          if (this.compactor.stripThinking.has(p.id + '|' + key)) sendBody = stripThinking(sendBody);
          if (model !== body.model) sendBody = { ...sendBody, model };
          sendEst = estimateRequest(sendBody);
          const bodyBuf = Buffer.from(JSON.stringify(sendBody));
          if (this.state.tooManyBytes(p, bodyBuf.length)) {
            sizeBlocked = true;
            attempts.push({ providerId: p.id, variant, skipped: true, sentBytes: bodyBuf.length, reason: '请求体超过已知字节上限' });
            if (clientCompact && phase === 'full') fullRejected.add(p.id);
            if (eligible && maySchedule) this.compactor.schedule(key, body, p, '请求体超过已知字节上限');
            holdSize(p, 'bytes', sendEst, bodyBuf.length);
            failedOver = true;
            break;
          }
          // maxAttempts counts ordinary sends only; cost-aware retries have a separate per-provider budget.
          if (!costRetry) tries++;
          const ta = Date.now();
          const r = await attempt({
            provider: p, pathname: url.pathname, search: url.search, clientHeaders: req.headers,
            bodyBuf, settings: s, clientSignal: ac.signal,
          });
          const rec = { providerId: p.id, model, variant, sentEst: sendEst, sentBytes: bodyBuf.length, ms: Date.now() - ta };
          if (costRetry) rec.costAwareRetry = extraRetries;
          if (compactedFailover && variant === 'compacted') {
            rec.compactedFailover = row.compactedFailover = true;
            if (retry === 0) this.bus.log('info', 'compacted_failover', `会话 ${key.slice(0, 6)} 切换到 ${p.name} 时发送已有摘要，减少缓存写入`, p.id);
          }
          costRetry = false;
          attempts.push(rec);

          if (r.ok) {
            rec.ok = true;
            rec.status = r.status;
            return this.deliver({ req, res, r, p, row, body, key, model, variant, sendEst, sentBytes: bodyBuf.length, fullEst, comp, t0 });
          }

          if (r.aborted) {
            rec.ok = false;
            rec.category = 'aborted';
            row.error = '客户端已取消请求';
            this.finish(row, false);
            return res.end();
          }

          const limit = this.state.effectiveLimit(p);
          const cls = classify({ ...r, nearLimit: !!(limit && sendEst >= limit * 0.9) }, s.patterns);
          if (cls.category === 'bad_request' && isSignatureError(r.text) && !this.compactor.stripThinking.has(p.id + '|' + key)) {
            // Thinking signatures from another relay's backend: drop old thinking blocks and retry here.
            this.compactor.stripThinking.add(p.id + '|' + key);
            Object.assign(rec, { ok: false, status: r.status, category: 'thinking_signature', label: '思考签名不兼容', message: truncate(r.text, 300) });
            if (tries < s.maxAttempts) continue;
          }
          Object.assign(rec, { ok: false, status: r.status || null, category: cls.category, label: cls.label, message: truncate(r.text, 300) });
          if (s.saveErrorBodies && r.raw) rec.raw = truncate(r.raw, 1500);
          lastFail = { r, cls, p };
          const sizeError = cls.category === 'context_overflow' || cls.category === 'body_too_large';
          if (!sizeError) allContext = false;
          if (cls.category !== 'body_too_large') allBytes = false;

          if (cls.penalty !== 'none') {
            this.state.recordFailure(p, cls, { message: r.text, status: r.status, retryAfterSec: r.retryAfterSec });
          }
          if (cls.category === 'model_unavailable') this.state.markModelUnavailable(p, model);

          if (sizeError) {
            if (cls.category === 'body_too_large') this.state.learnRejectedBytes(p, bodyBuf.length);
            else this.state.learnRejected(p, sendEst);
            holdSize(p, cls.category === 'body_too_large' ? 'bytes' : 'tokens', sendEst, bodyBuf.length);
            if (clientCompact && phase === 'full') {
              fullRejected.add(p.id);
              break;
            }
            if (variant === 'compacted') {
              this.compactor.invalidate(key, `压缩后（≈${Math.round(sendEst / 1000)}k）仍被 ${p.name} 拒绝，将保留更少的近期消息重新压缩`, { shrink: true });
              if (eligible && maySchedule) this.compactor.schedule(key, body, p, '压缩后仍超限');
            } else if (eligible) {
              const ready = this.compactor.lookup(key, body);
              if (ready && tries < s.maxAttempts) {
                // A summary is already prepared: retry this same cheap provider with it.
                variant = 'compacted';
                comp = ready;
                rec.next = '使用已有摘要重试';
                continue;
              }
              if (maySchedule) this.compactor.schedule(key, body, p, `${p.name} 拒绝了 ≈${Math.round(sendEst / 1000)}k 的请求`);
            }
            break;
          }

          const retryable = cls.retrySame && retry < s.sameProviderRetry && tries < s.maxAttempts && this.state.health(p.id).status !== 'down';
          let waitMs = 400 + retry * 600;
          if (!retryable) {
            const transient = ['network', 'timeout', 'server_error', 'overloaded', 'stream_error'].includes(cls.category);
            let next = null;
            for (const q of list.slice(i + 1)) {
              if (this.state.isModelUnavailable(q, mapModel(q, body.model))) continue;
              const qTooBig = this.state.tooBigFor(q, fullEst, fullBytes);
              if (clientCompact && phase === 'full' && qTooBig) continue;
              const qComp = ready && ((phase === 'fallback' && this.compactor.eligible(q, 'messages', body)) ||
                (!clientCompact && s.compaction.enabled && (s.compaction.compactOnFailover || (qTooBig && this.compactor.eligible(q, 'messages', body)))));
              if (phase === 'fallback' && !qComp) continue;
              let qBody = qComp ? this.compactor.apply(body, ready) : body;
              if (this.compactor.stripThinking.has(q.id + '|' + key)) qBody = stripThinking(qBody);
              qBody = { ...qBody, model: mapModel(q, body.model) };
              if (this.state.tooManyBytes(q, Buffer.byteLength(JSON.stringify(qBody)))) continue;
              next = { p: q, variant: qComp ? 'compacted' : 'full' };
              break;
            }
            if (!transient || sendEst < s.costAwareFailover.minTokens || extraRetries >= s.costAwareFailover.extraRetries ||
                !next || this.state.isWarm(next.p, key, next.variant)) break;
            waitMs = extraRetries === 0 ? 1500 : 4000;
            extraRetries++;
            costRetry = true;
            row.costAwareRetry = true;
            rec.next = `缓存保护：同线路额外重试 ${extraRetries}`;
            this.bus.log('info', 'cost_retry', `${p.name} 临时故障，下一线路缓存冷：额外重试 ${extraRetries}/${s.costAwareFailover.extraRetries}`, p.id, { session: key, sentEst: sendEst });
          }
          const waited = await delay(waitMs, null, { signal: ac.signal }).then(() => true, () => false);
          if (!waited) {
            row.error = '客户端已取消请求';
            this.finish(row, false);
            return res.end();
          }
        }
        failedOver = true;
        if (sizeHold || tries >= s.maxAttempts) break;
      }
    }

    // Every provider failed.
    row.error = attempts.filter((a) => !a.skipped).map((a) => `${this.pname(a.providerId)}: ${a.label || a.category}`).join(' → ') || '全部跳过';
    if (sizeHold) return this.replySizeHold(res, row, body, sizeHold);
    this.finish(row, false, lastFail ? lastFail.r.status : sizeBlocked ? (allBytes ? 413 : 400) : null);
    if (allContext && (lastFail || sizeBlocked)) {
      if (allBytes) return anthropicError(res, 413, 'request_too_large', '[智能路由] 请求体超过所有可用中转站的字节上限，请执行 /compact 或减少图片及附件。');
      return anthropicError(res, 400, 'invalid_request_error',
        `Prompt is too long: 所有中转站都拒绝了这么长的上下文（约 ${Math.round(fullEst / 1000)}k 估算 tokens）。[智能路由] 请执行 /compact 压缩会话。`);
    }
    const st = lastFail ? lastFail.r.status : 0;
    const status = st === 429 ? 429 : st === 400 ? 400 : st === 529 ? 529 : lastResort ? 503 : 502;
    const type = status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : status === 529 ? 'overloaded_error' : 'api_error';
    const detail = lastFail ? `${lastFail.cls.label}：${truncate(lastFail.r.text, 400)}` : '';
    return anthropicError(res, status, type, `[智能路由] 所有中转站均失败（${row.error}）。最后错误 ${detail}`);
  }

  clientCompactsItself(req) {
    const v = claudeCliVersion(req.headers['user-agent']);
    return !!(v && versionAtLeast(v, this.s.reactiveCompactMinVersion));
  }

  // The request is over a relay's size limit and we are not failing over. Answer in the shape Claude Code
  // recognises ("Prompt is too long: N tokens > M maximum"), so it runs its reactive compaction and,
  // when the summary request itself is too big, keeps more recent turns verbatim and summarizes less.
  replySizeHold(res, row, body, hold) {
    const { p, kind, est, bytes } = hold;
    const name = p.name;
    if (kind === 'bytes' && bytes && mediaBytes(body) >= bytes * 0.4) {
      // Mostly images/documents: summarizing can't shrink them; Claude Code strips media on request_too_large.
      row.error += ` → 已交回客户端（${name} 请求体超限，主要是图片/文档）`;
      this.finish(row, false, 413);
      return anthropicError(res, 413, 'request_too_large',
        `[智能路由] 请求体超过 ${name} 的字节上限（约 ${Math.round(bytes / 1024)} KiB），主要由图片或文档组成，请减少附件。`);
    }
    const cal = this.state.data.calibration[p.id];
    const ratio = cal && cal.ratio > 0 ? cal.ratio : 1;
    let factor = 0.9;
    if (kind === 'bytes') {
      const limit = this.state.effectiveByteLimit(p);
      if (limit && bytes) factor = (limit * 0.95) / bytes;
    } else {
      const limit = this.state.effectiveLimit(p);
      if (limit && est) factor = (limit * 0.95) / est;
    }
    factor = Math.min(Math.max(factor, 0.1), 0.97);
    const actual = Math.max(1, Math.round((est || estimateRequest(body)) * ratio));
    const maximum = Math.max(1, Math.floor(actual * factor));
    const what = kind === 'bytes' ? `请求体约 ${Math.round(bytes / 1024)} KiB，超过 ${name} 的字节上限` : `超过 ${name} 的上下文上限`;
    row.error += ` → 已交回客户端压缩（${what}）`;
    this.finish(row, false, 400);
    return anthropicError(res, 400, 'invalid_request_error',
      `Prompt is too long: ${actual} tokens > ${maximum} maximum [智能路由] ${what}，未切换到更贵的线路；请压缩会话（/compact）。`);
  }

  pname(id) {
    const p = this.config.provider(id);
    return p ? p.name : id;
  }

  async deliver({ res, r, p, row, body, key, model, variant, sendEst, sentBytes, fullEst, comp, t0 }) {
    row.providerId = p.id;
    row.status = r.status;
    row.sentTokens = sendEst;
    row.compacted = variant === 'compacted';
    row.ttfbMs = r.ttfbMs;
    let usage = {};
    let ok = true;
    // Compacted upstream: tell Claude Code the size of the history it really holds, so its native compaction runs.
    const ratio = variant === 'compacted' && this.s.compaction.reportFullUsage && fullEst > sendEst && sendEst > 0 ? fullEst / sendEst : 1;
    if (r.stream) {
      const out = await pipeStream(r, res, this.s, ratio > 1 ? new UsageRewriter(ratio) : null);
      usage = out.usage || {};
      if (out.error) {
        ok = false;
        row.error = `流式中断：${out.error}`;
        this.state.recordFailure(p, classify({ streamError: true, text: out.error }, this.s.patterns), { message: out.error });
      } else if (out.aborted) {
        ok = false;
        row.error = '客户端中途取消';
      }
    } else {
      const rewritten = ratio > 1 ? rewriteJsonUsage(r.json, ratio) : null;
      const buf = rewritten ? Buffer.from(JSON.stringify(rewritten)) : r.buf;
      const headers = { ...r.headers, 'content-length': buf.length };
      res.writeHead(r.status, headers);
      res.end(buf);
      usage = (r.json && r.json.usage) || {};
    }
    Object.assign(row, {
      inputTokens: usage.input_tokens != null ? usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : null,
      outputTokens: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
    });
    if (ok) {
      this.state.recordSuccess(p);
      this.state.learnAccepted(p, sendEst);
      this.state.learnAcceptedBytes(p, sentBytes);
      this.state.markWarm(p, key, variant);
      this.state.setLastGoodModel(p, model);
      if (row.inputTokens) this.state.calibrate(p, sendEst, row.inputTokens);
      if (variant === 'compacted') this.compactor.markUsed(key, { fullEst, sentEst: sendEst });
      else if (key) this.compactor.touch(key);
    }
    this.finish(row, ok, r.status, Date.now() - t0);
  }

  finish(row, ok, status, durationMs) {
    row.ok = ok;
    if (status != null && row.status == null) row.status = status;
    row.durationMs = durationMs || Date.now() - row.ts;
    try {
      row.id = this.store.addRequest(row);
    } catch (e) {
      console.error('[store]', e.message);
    }
    this.bus.request(row);
    this.state.refreshActive();
  }

  async handleCountTokens(req, res, url, body, bodyBuf) {
    const { list } = this.modelCandidates(body.model);
    for (const p of list) {
      const model = mapModel(p, body.model);
      const buf = model !== body.model ? Buffer.from(JSON.stringify({ ...body, model })) : bodyBuf;
      const r = await attempt({ provider: p, pathname: url.pathname, search: url.search, clientHeaders: req.headers, bodyBuf: buf, settings: this.s });
      if (r.ok && !r.stream && r.json && typeof r.json.input_tokens === 'number') {
        res.writeHead(200, { ...r.headers, 'content-length': r.buf.length });
        return res.end(r.buf);
      }
      if (r.ok && r.stream) r.reader.cancel().catch(() => {});
    }
    // No relay supports count_tokens: answer with our own estimate.
    sendJson(res, 200, { input_tokens: estimateRequest(body) }, { 'x-smart-router-provider': 'estimate' });
  }

  async handleOther(req, res, url, bodyBuf) {
    const { list } = this.state.candidates();
    let last = null;
    for (const p of list) {
      const r = await attempt({ provider: p, method: req.method, pathname: url.pathname, search: url.search, clientHeaders: req.headers, bodyBuf, settings: this.s });
      if (r.ok && r.stream) {
        await pipeStream(r, res, this.s);
        return;
      }
      if (r.ok) {
        res.writeHead(r.status, { ...r.headers, 'content-length': r.buf.length });
        return res.end(r.buf);
      }
      last = r;
      if (r.status && r.status < 500 && r.status !== 429) break;
    }
    if (last && last.status) return sendJson(res, last.status, safeParse(last.raw) || { type: 'error', error: { type: 'api_error', message: last.text } });
    anthropicError(res, 502, 'api_error', '[智能路由] 没有中转站响应：' + (last ? last.text : '无可用中转站'));
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Headers worth replaying in health probes (identify the client as Claude Code).
function pickIdentityHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (key === 'user-agent' || key === 'x-app' || key === 'anthropic-version' || key === 'anthropic-beta' || key.startsWith('x-stainless') || key === 'anthropic-dangerous-direct-browser-access') {
      out[key] = v;
    }
  }
  return out;
}

module.exports = { Router, mapModel, stripThinking, pickIdentityHeaders };
