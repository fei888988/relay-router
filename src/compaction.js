'use strict';
// Proxy-side rolling compaction.
// When a provider (e.g. Example Relay, ~100k context) rejects a long conversation, older turns are
// summarized by another provider in the background; later requests for that session are rewritten as
// [summary] + [recent turns verbatim] so the cheap provider can keep serving them.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha1, truncate } = require('./util');
const { messageTokens, overheadTokens, textTokens, estimateRequest } = require('./tokens');
const { attempt } = require('./upstream');
const { classify } = require('./classify');

const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function isClientCompact(body) {
  const text = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '';
  const lastUser = body && Array.isArray(body.messages) && body.messages.findLast((m) => m.role === 'user');
  const matches = (s) => /\b(?:create|write|provide|produce)\s+(?:a\s+)?(?:detailed|comprehensive)\s+summary\s+of\s+(?:the|our|this)\s+conversation\b/i.test(s);
  return !!(body && (matches(text(body.system)) || matches(text(lastUser && lastUser.content))));
}

const SUMMARY_SYSTEM = `你是一个对话压缩器。你会收到一段 AI 编程助手与用户之间较早的对话记录（可能附带更早的摘要），请把它压缩成一份"前情摘要"，用来替换这些原始消息，让助手无缝继续工作。
要求：
1. 用对话中用户主要使用的语言书写。
2. 按以下小节组织：
   - 用户的目标与全部明确要求（逐条保留原意，包括约束、偏好、被否决的方案）
   - 关键技术背景与决策（架构、依赖、命令、配置）
   - 涉及的文件与改动（精确路径、函数/类名、关键代码片段或改动要点）
   - 遇到的错误及解决方式
   - 已完成的工作
   - 当前进行中的工作与下一步（最后几轮正在做什么，必须足够具体）
3. 精确保留文件路径、标识符、命令、版本号、数字、URL；不要编造记录中没有的内容。
4. 只输出摘要正文，不要寒暄，不要提到"压缩"本身。`;

const WRAP = (summary) =>
  `<context-summary>\n[智能路由自动生成] 为节省上下文，本会话较早的消息已被压缩为以下摘要。请把它当作真实发生过的对话记录，直接延续当前任务，无需向用户提及此摘要。\n\n${summary}\n</context-summary>`;

// --- session identity & prefix hashing ---

function sessionKey(body) {
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return null;
  const uid = body.metadata && body.metadata.user_id;
  let sid = null;
  if (typeof uid === 'string') {
    try {
      const j = JSON.parse(uid);
      sid = j.session_id || j.sessionId || null;
    } catch {}
    if (!sid) {
      const m = uid.match(/session_([0-9a-f-]{8,})/i);
      sid = m ? m[1] : null;
    }
  }
  // First message distinguishes the main thread from subagents sharing a session id.
  const first = body.messages[0];
  const firstText = JSON.stringify(skeletonOf(first)).slice(0, 4000);
  return sha1((sid || 'anon') + '|' + firstText).slice(0, 16);
}

// Stable view of a message: ignores cache_control, tool_result contents (Claude Code may clear old ones),
// thinking text and signatures.
function skeletonOf(m) {
  if (!m) return null;
  const c = m.content;
  if (typeof c === 'string') return [m.role, c];
  if (!Array.isArray(c)) return [m.role];
  return [
    m.role,
    ...c.map((b) => {
      if (!b || typeof b !== 'object') return String(b);
      switch (b.type) {
        case 'text':
          return 't:' + b.text;
        case 'tool_use':
        case 'server_tool_use':
          return 'u:' + b.id + ':' + b.name;
        case 'tool_result':
          return 'r:' + b.tool_use_id;
        case 'thinking':
        case 'redacted_thinking':
          return 'k';
        default:
          return b.type || '?';
      }
    }),
  ];
}

function chainHash(msgs, k) {
  const h = crypto.createHash('sha1');
  for (let i = 0; i < k && i < msgs.length; i++) h.update(JSON.stringify(skeletonOf(msgs[i])) + '\u0001');
  return h.digest('hex');
}

function startsWithToolResult(m) {
  return !!(m && m.role === 'user' && Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result');
}

// Valid places to cut: summary goes before msgs[k].
function isBoundary(msgs, k) {
  const m = msgs[k];
  if (!m) return false;
  if (m.role === 'assistant') return true;
  return m.role === 'user' && !startsWithToolResult(m);
}

// --- transcript rendering for the summarizer ---

function stripReminders(s) {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, (x) => truncate(x, 300));
}

function renderTranscript(msgs, prevSummary, lim) {
  const parts = [];
  if (prevSummary) parts.push(`<更早的摘要>\n${prevSummary}\n</更早的摘要>`);
  parts.push('<对话记录>');
  for (const m of msgs) {
    const who = m.role === 'assistant' ? '助手' : '用户';
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    const lines = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') lines.push(truncate(stripReminders(b.text || ''), lim.text));
      else if (b.type === 'tool_use' || b.type === 'server_tool_use')
        lines.push(`[调用工具 ${b.name}] ${truncate(JSON.stringify(b.input || {}), lim.tool)}`);
      else if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x && x.type === 'text' ? x.text : `[${x && x.type}]`)).join('\n') : '';
        lines.push(`[工具结果${b.is_error ? '（错误）' : ''}] ${truncate(c, lim.tool)}`);
      } else if (b.type === 'image') lines.push('[图片]');
      else if (b.type === 'document') lines.push('[文档]');
    }
    if (lines.length) parts.push(`【${who}】\n${lines.join('\n')}`);
  }
  parts.push('</对话记录>');
  return parts.join('\n\n');
}

function fitTranscript(msgs, prevSummary, s) {
  let lim = { text: 20000, tool: s.toolResultMaxChars };
  let out = renderTranscript(msgs, prevSummary, lim);
  for (let i = 0; i < 4 && textTokens(out) > s.transcriptMaxTokens; i++) {
    lim = { text: Math.max(1500, lim.text >> 1), tool: Math.max(300, lim.tool >> 1) };
    out = renderTranscript(msgs, prevSummary, lim);
  }
  if (textTokens(out) > s.transcriptMaxTokens) {
    const maxChars = s.transcriptMaxTokens * 3;
    out = out.slice(0, maxChars * 0.3) + '\n\n…（中间部分过长已省略）…\n\n' + out.slice(-maxChars * 0.7);
  }
  return out;
}

class Compactor {
  constructor({ config, state, bus, store, dataDir }) {
    this.config = config;
    this.state = state;
    this.bus = bus;
    this.store = store;
    this.file = path.join(dataDir, 'compaction.json');
    this.sessions = {};
    this.running = new Map();
    this.stripThinking = new Set(); // `${providerId}|${sessionKey}`
    try {
      if (fs.existsSync(this.file)) this.sessions = JSON.parse(fs.readFileSync(this.file, 'utf8')).sessions || {};
      for (const s of Object.values(this.sessions)) if (s.status === 'running') s.status = s.summary ? 'ready' : 'idle';
    } catch {}
    this.saveTimer = null;
  }

  get cs() {
    return this.config.settings.compaction;
  }

  save(immediate) {
    const write = () => {
      this.saveTimer = null;
      const ttl = this.cs.sessionTtlHours * 3600000;
      const entries = Object.entries(this.sessions)
        .filter(([, v]) => Date.now() - (v.lastUsedAt || v.updatedAt || 0) < ttl)
        .sort((a, b) => (b[1].lastUsedAt || 0) - (a[1].lastUsedAt || 0))
        .slice(0, 300);
      this.sessions = Object.fromEntries(entries);
      try {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify({ sessions: this.sessions }));
        fs.renameSync(this.file + '.tmp', this.file);
      } catch (e) {
        console.error('[compaction] save failed', e.message);
      }
    };
    if (immediate) {
      clearTimeout(this.saveTimer);
      return write();
    }
    if (!this.saveTimer) this.saveTimer = setTimeout(write, 1500);
  }

  sessionKey(body) {
    return sessionKey(body);
  }

  eligible(provider, kind, body) {
    return !!(
      this.cs.enabled &&
      provider.allowCompaction &&
      kind === 'messages' &&
      body &&
      Array.isArray(body.messages) &&
      body.messages.length >= 4
    );
  }

  // Ready summary whose covered prefix still matches this request, else null.
  lookup(key, body, { allowStale = false } = {}) {
    const s = key && this.sessions[key];
    const okStatus = s && (s.status === 'ready' || s.status === 'running' || (allowStale && s.status === 'stale'));
    if (!s || !s.summary || !okStatus) return null;
    const msgs = body.messages;
    if (msgs.length <= s.coveredCount) return null;
    if (chainHash(msgs, s.coveredCount) !== s.coveredHash) {
      if (s.status === 'ready') {
        this.invalidate(key, '会话历史已变化（可能客户端已自行压缩），丢弃旧摘要');
      }
      return null;
    }
    if (!isBoundary(msgs, s.coveredCount)) return null;
    return s;
  }

  // Build a compacted copy of body using session state s.
  apply(body, s) {
    const msgs = body.messages;
    const tail = msgs.slice(s.coveredCount).map((m) => ({ ...m }));
    const block = { type: 'text', text: WRAP(s.summary) };
    if (tail[0].role === 'user') {
      const c = tail[0].content;
      tail[0].content = [block, ...(typeof c === 'string' ? [{ type: 'text', text: c }] : c || [])];
    } else {
      tail.unshift({ role: 'user', content: [block] });
    }
    return { ...body, messages: tail };
  }

  markUsed(key, { fullEst, sentEst }) {
    const s = this.sessions[key];
    if (!s) return;
    s.lastUsedAt = Date.now();
    s.uses = (s.uses || 0) + 1;
    s.lastFullEst = fullEst;
    s.lastSentEst = sentEst;
    this.save();
  }

  touch(key) {
    if (this.sessions[key]) this.sessions[key].lastUsedAt = Date.now();
  }

  invalidate(key, reason, { shrink } = {}) {
    const s = this.sessions[key];
    if (!s) return;
    if (shrink) {
      s.tailScale = Math.max(0.3, (s.tailScale || 1) * 0.6);
      s.status = 'stale';
    } else {
      s.summary = null;
      s.coveredCount = 0;
      s.coveredHash = null;
      s.status = 'idle';
    }
    s.updatedAt = Date.now();
    if (reason) this.bus.log('info', 'compaction', `会话 ${key.slice(0, 6)}：${reason}`, s.providerId);
    this.save();
  }

  // Kick off a background summarization so `provider` can serve this session again.
  schedule(key, body, provider, reason) {
    if (!key || isClientCompact(body) || !this.eligible(provider, 'messages', body)) return false;
    if (this.running.has(key) || this.running.size >= 2) return false;
    const limit = this.state.effectiveLimit(provider);
    const byteLimit = this.state.effectiveByteLimit(provider);
    if (!limit && !byteLimit) return false;
    const s = (this.sessions[key] = this.sessions[key] || { key, status: 'idle', builds: 0, createdAt: Date.now() });
    if (s.failedAt && Date.now() - s.failedAt < 120000) return false;

    const msgs = body.messages;
    const prev = this.lookup(key, body, { allowStale: true });
    const overhead = overheadTokens(body);
    const tailBudget = limit ? Math.min(
      Math.floor(limit * this.cs.keepRatio * (s.tailScale || 1)),
      limit - overhead - this.cs.summaryMaxTokens - 2000
    ) : Infinity;
    // Reserve UTF-8/JSON space for the summary, wrapper and fixed request fields.
    const fixedBytes = Buffer.byteLength(JSON.stringify({ ...body, messages: [] }));
    const tailBytes = byteLimit ? Math.min(
      Math.floor(byteLimit * this.cs.keepRatio * (s.tailScale || 1)),
      Math.floor(byteLimit * 0.95) - fixedBytes - this.cs.summaryMaxTokens * 6 - 2048
    ) : Infinity;
    if (tailBudget < 2000 || tailBytes <= 0) {
      this.bus.log('warn', 'compaction', `${provider.name} 的上下文上限太小（系统提示和工具定义已占 ${Math.round(overhead / 1000)}k），无法压缩`, provider.id);
      s.failedAt = Date.now();
      return false;
    }
    // Choose the earliest boundary whose verbatim tail fits the budget.
    const suffix = new Array(msgs.length + 1).fill(0);
    const suffixBytes = new Array(msgs.length + 1).fill(0);
    for (let i = msgs.length - 1; i >= 0; i--) {
      suffix[i] = suffix[i + 1] + messageTokens(msgs[i]);
      suffixBytes[i] = suffixBytes[i + 1] + Buffer.byteLength(JSON.stringify(msgs[i])) + 1;
    }
    const minK = prev ? prev.coveredCount + 1 : 2;
    let k = -1;
    for (let i = minK; i <= msgs.length - 1; i++) {
      if (isBoundary(msgs, i) && suffix[i] <= tailBudget && suffixBytes[i] <= tailBytes) {
        k = i;
        break;
      }
    }
    if (k < 0 && !byteLimit) {
      for (let i = msgs.length - 1; i >= minK; i--) if (isBoundary(msgs, i)) { k = i; break; }
    }
    if (k < 0) return false;

    const fromIdx = prev ? prev.coveredCount : 0;
    const task = this.run(key, body, provider, { k, fromIdx, prevSummary: prev ? prev.summary : null, reason, overhead });
    this.running.set(key, task);
    task.finally(() => this.running.delete(key));
    return true;
  }

  async run(key, body, provider, { k, fromIdx, prevSummary, reason, overhead }) {
    const s = this.sessions[key];
    const msgs = body.messages;
    const prevStatus = s.status;
    s.status = 'running';
    s.providerId = provider.id;
    s.updatedAt = Date.now();
    this.bus.log('info', 'compaction', `开始压缩会话 ${key.slice(0, 6)}（${reason}）：摘要第 ${fromIdx + 1}–${k} 条消息，保留最近 ${msgs.length - k} 条`, provider.id);
    this.bus.stateChanged();
    const transcript = fitTranscript(msgs.slice(fromIdx, k), prevSummary, this.cs);
    try {
      const { text, providerName, usage } = await this.summarize(transcript, body, provider);
      const bytes = Buffer.byteLength(JSON.stringify(this.apply(body, { coveredCount: k, summary: text })));
      if (this.state.tooManyBytes(provider, bytes)) throw new Error('摘要加近期消息仍超过请求体字节上限');
      const fullEst = overhead + msgs.reduce((n, m) => n + messageTokens(m), 0);
      const summaryTokens = textTokens(text);
      Object.assign(s, {
        status: 'ready',
        summary: text,
        summaryTokens,
        coveredCount: k,
        coveredHash: chainHash(msgs, k),
        builds: (s.builds || 0) + 1,
        updatedAt: Date.now(),
        lastUsedAt: Date.now(),
        lastFullEst: fullEst,
        lastSentEst: overhead + summaryTokens + msgs.slice(k).reduce((n, m) => n + messageTokens(m), 0),
        summarizer: providerName,
        summarizerUsage: usage || null,
        failedAt: 0,
        lastError: null,
      });
      this.bus.log(
        'success',
        'compaction',
        `会话 ${key.slice(0, 6)} 压缩完成（由 ${providerName} 生成）：≈${Math.round(fullEst / 1000)}k → ≈${Math.round(s.lastSentEst / 1000)}k，后续请求可继续走 ${provider.name}`,
        provider.id
      );
    } catch (e) {
      // Keep a previous (older) summary usable; it still beats sending the full history.
      s.status = prevSummary ? (prevStatus === 'stale' ? 'stale' : 'ready') : 'failed';
      s.failedAt = Date.now();
      s.lastError = e.message;
      s.updatedAt = Date.now();
      this.bus.log('error', 'compaction', `会话 ${key.slice(0, 6)} 压缩失败：${e.message}`, provider.id);
    }
    this.save();
    this.bus.stateChanged();
  }

  async summarize(transcript, body, target) {
    const cs = this.cs;
    const settings = this.config.settings;
    const est = textTokens(transcript) + 2000;
    const order = [];
    if (cs.summarizerProviderId) order.push(this.config.provider(cs.summarizerProviderId));
    const tLimit = this.state.effectiveLimit(target);
    if (tLimit && est + 3000 < tLimit * 0.9) order.push(target);
    order.push(...this.state.candidates().list.filter((p) => p.id !== target.id));
    if (!tLimit || est + 3000 >= tLimit * 0.9) order.push(target);
    const seen = new Set();
    const list = order.filter((p) => p && this.state.isConfigured(p) && !seen.has(p.id) && seen.add(p.id));
    const model = cs.summarizerModel || body.model;
    const req = {
      model,
      max_tokens: cs.summaryMaxTokens,
      system: [
        { type: 'text', text: CC_IDENTITY },
        { type: 'text', text: SUMMARY_SYSTEM },
      ],
      messages: [{ role: 'user', content: transcript + '\n\n请输出前情摘要。' }],
    };
    const headers = { ...(this.state.lastClientHeaders || {}), 'content-type': 'application/json', accept: 'application/json' };
    const bodyBuf = Buffer.from(JSON.stringify(req));
    const sentEst = estimateRequest(req);
    delete headers['anthropic-beta'];
    const errors = [];
    for (const p of list) {
      if (!this.state.isUsable(p) && list.some((x) => this.state.isUsable(x))) continue;
      if (this.state.isModelUnavailable(p, model)) continue;
      const t0 = Date.now();
      const r = await attempt({
        provider: p,
        pathname: '/v1/messages',
        clientHeaders: headers,
        bodyBuf,
        settings,
      });
      const text = r.ok && r.json && Array.isArray(r.json.content) ? r.json.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() : '';
      const usage = r.ok && r.json ? r.json.usage : null;
      this.store.addRequest({
        ts: t0, kind: 'compact', model, stream: false, estTokens: est, sentTokens: sentEst,
        inputTokens: usage && usage.input_tokens, outputTokens: usage && usage.output_tokens,
        providerId: p.id, status: r.status || null, ok: !!(r.ok && text), durationMs: Date.now() - t0, ttfbMs: r.ttfbMs,
        attempts: [{ providerId: p.id, sentEst, sentBytes: bodyBuf.length, ok: !!(r.ok && text), status: r.status || null, category: r.ok ? null : 'error', ms: Date.now() - t0, message: r.ok ? null : truncate(r.text, 300) }],
        error: r.ok ? null : truncate(r.text, 500),
      });
      if (r.ok && text) {
        this.state.recordSuccess(p);
        this.state.learnAccepted(p, sentEst);
        this.state.learnAcceptedBytes(p, bodyBuf.length);
        return { text, providerName: p.name, usage };
      }
      if (!r.ok) {
        const cls = classify({ ...r }, settings.patterns);
        if (cls.category === 'body_too_large') this.state.learnRejectedBytes(p, bodyBuf.length);
        if (cls.category === 'context_overflow') this.state.learnRejected(p, sentEst);
        if (cls.penalty !== 'none') this.state.recordFailure(p, cls, { message: r.text, status: r.status, retryAfterSec: r.retryAfterSec });
        if (cls.category === 'model_unavailable') this.state.markModelUnavailable(p, model);
        errors.push(`${p.name}: ${cls.label} ${truncate(r.text, 120)}`);
      } else errors.push(`${p.name}: 返回为空`);
    }
    throw new Error(errors.length ? errors.join('；') : '没有可用于生成摘要的中转站');
  }

  list() {
    return Object.values(this.sessions)
      .sort((a, b) => (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0))
      .map((s) => ({ ...s, summary: undefined, summaryPreview: s.summary ? truncate(s.summary, 160) : null, running: this.running.has(s.key) }));
  }

  get(key) {
    return this.sessions[key] || null;
  }

  remove(key) {
    delete this.sessions[key];
    this.save();
  }
}

module.exports = { Compactor, sessionKey, chainHash, skeletonOf, isBoundary, WRAP, isClientCompact };
