'use strict';
// Persistent configuration: providers (relay stations) + router settings, stored in data/config.json.
const fs = require('node:fs');
const path = require('node:path');
const { randomId, mergeDefaults, clone } = require('./util');

const DATA_DIR = process.env.SMART_ROUTER_DATA || path.join(__dirname, '..', 'data');

// Error text patterns (case-insensitive substrings) used to classify upstream failures.
const DEFAULT_PATTERNS = {
  context: [
    'prompt is too long', 'input is too long', 'is too long', 'context length', 'context_length',
    'context window', 'context limit', 'maximum context', 'too many tokens', 'content_length_exceeds_threshold',
    'request too large', 'payload too large', 'request entity too large', 'max_prompt_tokens',
    '上下文', '输入过长', '长度超', '超出最大长度', '超过最大长度', 'token 数超', 'tokens超',
  ],
  quota: [
    'insufficient_user_quota', 'insufficient_quota', 'insufficient balance', 'insufficient credit',
    'credit balance is too low', 'out of credits', 'balance is insufficient', 'quota exhausted', 'quota_exhausted',
    'exceeded your current quota', 'payment required', '额度不足', '额度已用尽', '额度用尽', '余额不足',
    '预扣费', '剩余额度', '令牌额度', '欠费', '套餐已用完', '用量已达上限',
  ],
  auth: [
    'authentication_error', 'invalid api key', 'invalid x-api-key', 'invalid token', 'incorrect api key',
    'api key not valid', 'unauthorized', '无效的令牌', '令牌已过期', '令牌已被禁用', '令牌状态不可用',
    '用户已被封禁', '未提供令牌', 'token expired', 'token is disabled',
  ],
  model: [
    'model_not_found', 'no available channel', '无可用渠道', 'model not found', 'model does not exist',
    'unsupported model', 'model is not supported', 'not supported model', '模型不存在', '不支持该模型', 'invalid model',
  ],
  rateLimit: [
    'rate_limit', 'rate limit', 'too many requests', '请求过于频繁', '频率限制', '负载已饱和', 'concurrency limit', '并发',
  ],
  overloaded: [
    'overloaded', 'service unavailable', 'temporarily unavailable', 'bad gateway', 'upstream_error',
    'upstream error', '服务繁忙', '服务器繁忙', '上游', 'gateway timeout',
  ],
};

const DEFAULT_SETTINGS = {
  host: '127.0.0.1',
  port: 18787,
  routerKey: '',
  requireKey: true,
  mode: 'auto', // 'auto' = priority failover, 'pinned' = always use pinnedProviderId
  pinnedProviderId: null,
  failureThreshold: 3, // consecutive soft failures before a provider is taken offline
  probeIntervalMin: 10,
  cooldownSec: 60, // default rate-limit cooldown when upstream sends no retry-after
  maxAttempts: 5,
  sameProviderRetry: 1, // quick retries on the same provider for network/5xx errors
  cacheTtlSec: 300,
  // Over a relay's size limit: false = stay on it and hand the request back as "prompt is too long",
  // so the client compacts and keeps the cheap, warm relay; true = fail over to the next relay (cold cache).
  sizeFailover: false,
  // Claude Code at or above this version compacts by itself on "prompt is too long", so the router skips its own summary.
  reactiveCompactMinVersion: '2.1.195',
  costAwareFailover: {
    minTokens: 100000,
    extraRetries: 2, // additional attempts, excluded from maxAttempts (which counts ordinary attempts)
  },
  firstByteTimeoutSec: 180,
  idleTimeoutSec: 300,
  nonStreamTimeoutSec: 600,
  learnedLimitTtlHours: 24,
  modelUnavailableTtlMin: 10,
  logRetentionDays: 30,
  saveErrorBodies: true,
  compaction: {
    enabled: true,
    compactOnFailover: true,
    preemptive: false, // start summarizing in the background before the limit is hit
    triggerRatio: 0.85, // of the provider's known context limit
    keepRatio: 0.35, // recent messages kept verbatim, as a fraction of the limit
    reportFullUsage: true, // report the full-history size to the client so Claude Code's own auto-compact still fires
    summaryMaxTokens: 6000,
    summarizerModel: '', // empty = same model as the request
    summarizerProviderId: '', // empty = automatic (priority order)
    transcriptMaxTokens: 90000,
    toolResultMaxChars: 2000,
    sessionTtlHours: 72,
  },
  patterns: DEFAULT_PATTERNS,
};

const PROVIDER_DEFAULTS = {
  id: '',
  name: '',
  baseUrl: '',
  apiKey: '',
  authHeader: 'bearer', // 'bearer' | 'x-api-key' | 'both'
  enabled: true,
  contextLimit: 0, // soft hint in estimated tokens; 0 = unknown
  allowCompaction: false,
  modelMap: {}, // { "claude-haiku-*": "claude-sonnet-5" }
  extraHeaders: {},
  probeModel: '',
  note: '',
  ccSwitchId: '',
};

function normalizeProvider(p) {
  const out = mergeDefaults(PROVIDER_DEFAULTS, p || {});
  out.id = out.id || 'p_' + randomId(6);
  out.baseUrl = String(out.baseUrl || '').trim().replace(/\/+$/, '');
  out.contextLimit = Math.max(0, parseInt(out.contextLimit, 10) || 0);
  if (!['bearer', 'x-api-key', 'both'].includes(out.authHeader)) out.authHeader = 'bearer';
  out.enabled = out.enabled !== false;
  out.allowCompaction = !!out.allowCompaction;
  return out;
}

function normalizeSettings(s) {
  const integer = (v, fallback) => Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : fallback;
  s.cacheTtlSec = integer(s.cacheTtlSec, DEFAULT_SETTINGS.cacheTtlSec);
  s.costAwareFailover = mergeDefaults(DEFAULT_SETTINGS.costAwareFailover, s.costAwareFailover || {});
  for (const k of ['minTokens', 'extraRetries']) s.costAwareFailover[k] = integer(s.costAwareFailover[k], DEFAULT_SETTINGS.costAwareFailover[k]);
  s.sizeFailover = s.sizeFailover === true;
  s.reactiveCompactMinVersion = /^\d+(\.\d+)*$/.test(String(s.reactiveCompactMinVersion || '').trim())
    ? String(s.reactiveCompactMinVersion).trim() : DEFAULT_SETTINGS.reactiveCompactMinVersion;
  s.compaction.compactOnFailover = s.compaction.compactOnFailover !== false;
  s.compaction.reportFullUsage = s.compaction.reportFullUsage !== false;
  return s;
}

// New installations start without providers; add or import them explicitly in the dashboard.
function initialProviders() {
  return [];
}

class Config {
  constructor(dataDir = DATA_DIR) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    this.data = null;
    this.listeners = new Set();
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    let raw = null;
    if (fs.existsSync(this.file)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (e) {
        const bak = this.file + '.broken-' + Date.now();
        fs.copyFileSync(this.file, bak);
        console.error(`[config] config.json 解析失败，已备份到 ${bak}，使用默认配置`);
      }
    }
    const fresh = !raw;
    raw = raw || { settings: {}, providers: initialProviders() };
    const settings = normalizeSettings(mergeDefaults(DEFAULT_SETTINGS, raw.settings || {}));
    settings.patterns = mergeDefaults(DEFAULT_PATTERNS, settings.patterns || {});
    if (!settings.routerKey) settings.routerKey = 'sr-' + randomId(18);
    if (process.env.SMART_ROUTER_PORT) settings.port = parseInt(process.env.SMART_ROUTER_PORT, 10);
    this.data = { settings, providers: (raw.providers || []).map(normalizeProvider), codex: {
      mode: raw.codex?.mode === 'pinned' ? 'pinned' : 'auto',
      pinnedAccountId: raw.codex?.pinnedAccountId || null,
      accounts: (raw.codex?.accounts || []).map((a) => ({ ...a, type: a.type === 'relay' ? 'relay' : 'chatgpt', enabled: a.enabled !== false })),
    } };
    if (fresh || !raw.settings || !raw.settings.routerKey) this.save();
    return this;
  }

  get settings() {
    return this.data.settings;
  }
  get providers() {
    return this.data.providers;
  }
  provider(id) {
    return this.data.providers.find((p) => p.id === id) || null;
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    for (const fn of this.listeners) fn();
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  updateSettings(patch) {
    const s = this.data.settings;
    for (const [k, v] of Object.entries(patch || {})) {
      if (['host', 'routerKey'].includes(k)) continue; // changed via dedicated actions only
      if (k === 'compaction' || k === 'patterns' || k === 'costAwareFailover') s[k] = { ...s[k], ...v };
      else if (k in DEFAULT_SETTINGS) s[k] = v;
    }
    normalizeSettings(s);
    this.save();
  }

  upsertProvider(p) {
    const idx = this.data.providers.findIndex((x) => x.id === p.id);
    if (idx >= 0) {
      const merged = { ...this.data.providers[idx], ...p };
      // Empty key in an edit means "keep the stored key".
      if (!p.apiKey) merged.apiKey = this.data.providers[idx].apiKey;
      this.data.providers[idx] = normalizeProvider(merged);
    } else {
      this.data.providers.push(normalizeProvider(p));
    }
    this.save();
    return this.provider(p.id) || this.data.providers[this.data.providers.length - 1];
  }

  removeProvider(id) {
    this.data.providers = this.data.providers.filter((p) => p.id !== id);
    if (this.data.settings.pinnedProviderId === id) {
      this.data.settings.pinnedProviderId = null;
      this.data.settings.mode = 'auto';
    }
    this.save();
  }

  moveProvider(id, dir) {
    const arr = this.data.providers;
    const i = arr.findIndex((p) => p.id === id);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    this.save();
  }

  regenerateKey() {
    this.data.settings.routerKey = 'sr-' + randomId(18);
    this.save();
    return this.data.settings.routerKey;
  }
}

module.exports = { Config, DATA_DIR, DEFAULT_SETTINGS, DEFAULT_PATTERNS, normalizeProvider, clone };
