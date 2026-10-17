'use strict';
// Classifies an upstream failure into a category that decides what the router does next.
//
// penalty: none     -> provider health untouched (problem is the request, not the relay)
//          soft     -> counts toward failureThreshold consecutive failures
//          cooldown -> short pause (rate limit), escalates to "down" when repeated
//          fatal    -> provider goes offline at once until a probe succeeds (quota / auth)
// failover: try the next provider for this request
// retrySame: worth one quick retry on the same provider first

const CATEGORIES = {
  body_too_large: { label: '请求体超限', penalty: 'none', failover: true, retrySame: false },
  context_overflow: { label: '上下文超限', penalty: 'none', failover: true, retrySame: false },
  quota: { label: '额度不足', penalty: 'fatal', failover: true, retrySame: false },
  auth: { label: '令牌无效', penalty: 'fatal', failover: true, retrySame: false },
  model_unavailable: { label: '模型不可用', penalty: 'none', failover: true, retrySame: false },
  rate_limit: { label: '限流', penalty: 'cooldown', failover: true, retrySame: false },
  overloaded: { label: '上游过载', penalty: 'soft', failover: true, retrySame: true },
  server_error: { label: '服务端错误', penalty: 'soft', failover: true, retrySame: true },
  network: { label: '网络错误', penalty: 'soft', failover: true, retrySame: true },
  timeout: { label: '超时', penalty: 'soft', failover: true, retrySame: false },
  stream_error: { label: '流式中断', penalty: 'soft', failover: true, retrySame: true },
  forbidden: { label: '拒绝访问', penalty: 'soft', failover: true, retrySame: false },
  bad_request: { label: '请求被拒', penalty: 'none', failover: true, retrySame: false },
};

function has(text, list) {
  if (!text || !list) return false;
  const t = text.toLowerCase();
  return list.some((p) => p && t.includes(String(p).toLowerCase()));
}

function make(category, extra) {
  return { category, ...CATEGORIES[category], ...extra };
}

/**
 * @param {object} o
 * @param {number} [o.status] HTTP status from upstream
 * @param {string} [o.text] error body / message
 * @param {string} [o.errorType] anthropic error.type if parsed
 * @param {boolean} [o.network] transport error
 * @param {boolean} [o.timeout]
 * @param {boolean} [o.streamError] error event inside a 200 SSE stream
 * @param {boolean} [o.nearLimit] request size is close to the provider's context hint
 * @param {object} patterns settings.patterns
 */
function classify(o, patterns) {
  const P = patterns || {};
  const text = `${o.errorType || ''} ${o.text || ''}`;
  const st = o.status || 0;

  if (st === 413) return make('body_too_large');
  if (o.timeout) return make('timeout');
  if (o.network) return make('network');

  if (has(text, P.context)) return make('context_overflow');
  if (st === 402 || has(text, P.quota)) return make('quota');
  if (has(text, P.model) || (st === 404 && /model/i.test(text))) return make('model_unavailable');
  if (st === 429 || has(text, P.rateLimit)) return make('rate_limit');
  if (st === 401 || o.errorType === 'authentication_error' || has(text, P.auth)) return make('auth');
  if (st === 529 || o.errorType === 'overloaded_error' || has(text, P.overloaded)) return make('overloaded');
  if (o.streamError) return make('stream_error');
  if (st >= 500) return make('server_error');
  if (st === 403 || o.errorType === 'permission_error') return make('forbidden');
  if (st === 400 && o.nearLimit) return make('context_overflow', { label: '上下文超限（推断）', inferred: true });
  if (st >= 400) return make('bad_request');
  return make('server_error');
}

module.exports = { classify, CATEGORIES };
