'use strict';
// One HTTP attempt against one relay. Everything before "commit" can still fail over:
// for SSE we hold the response until the first real event (an `error` event inside a 200 is a failure).
const { SseScanner } = require('./sse');

const DROP_REQ = new Set([
  'host', 'connection', 'content-length', 'authorization', 'x-api-key', 'accept-encoding', 'keep-alive',
  'transfer-encoding', 'proxy-authorization', 'proxy-connection', 'te', 'upgrade', 'expect', 'origin', 'referer',
  'cookie', 'x-panel',
]);
const DROP_RES = new Set([
  'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie',
  'strict-transport-security', 'alt-svc',
]);

const PRECOMMIT_MAX = 2 * 1024 * 1024;

function buildHeaders(clientHeaders, provider) {
  const h = {};
  for (const [k, v] of Object.entries(clientHeaders || {})) {
    const key = k.toLowerCase();
    if (DROP_REQ.has(key) || v == null) continue;
    h[key] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  h['accept-encoding'] = 'identity';
  if (provider.authHeader !== 'x-api-key') h['authorization'] = 'Bearer ' + provider.apiKey;
  if (provider.authHeader !== 'bearer') h['x-api-key'] = provider.apiKey;
  for (const [k, v] of Object.entries(provider.extraHeaders || {})) h[k.toLowerCase()] = String(v);
  return h;
}

function buildUrl(provider, pathname, search) {
  let base = provider.baseUrl.replace(/\/+$/, '');
  if (/\/v1$/.test(base) && pathname.startsWith('/v1/')) base = base.slice(0, -3);
  return base + pathname + (search || '');
}

function responseHeaders(headers, provider) {
  const out = {};
  headers.forEach((v, k) => {
    if (!DROP_RES.has(k.toLowerCase())) out[k] = v;
  });
  out['x-smart-router-provider'] = provider.id;
  return out;
}

function retryAfterSec(headers) {
  const v = headers && headers.get('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (!Number.isNaN(n)) return n;
  const d = Date.parse(v);
  return Number.isNaN(d) ? null : Math.max(0, (d - Date.now()) / 1000);
}

function parseError(text) {
  try {
    const j = JSON.parse(text);
    const e = j.error || j;
    const message = typeof e === 'string' ? e : e.message || j.message || j.msg || text;
    return { errorType: (e && e.type) || (e && e.code) || null, message: String(message) };
  } catch {
    return { errorType: null, message: text };
  }
}

async function readCapped(reader, max) {
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Perform one upstream attempt.
 * @returns failure: { ok:false, status, text, errorType, network, timeout, aborted, retryAfterSec, ttfbMs }
 *          success: { ok:true, stream:true, status, headers, reader, scanner, pending, controller, ttfbMs }
 *                   { ok:true, stream:false, status, headers, buf, json, ttfbMs }
 */
async function attempt({ provider, method = 'POST', pathname, search, clientHeaders, bodyBuf, settings, clientSignal }) {
  const t0 = Date.now();
  const ac = new AbortController();
  let timedOut = false;
  const onClientAbort = () => ac.abort();
  if (clientSignal) {
    if (clientSignal.aborted) return { ok: false, aborted: true, network: true, text: '客户端已取消' };
    clientSignal.addEventListener('abort', onClientAbort, { once: true });
  }
  const timer = (sec) =>
    setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, sec * 1000);
  let t = timer(settings.firstByteTimeoutSec);
  const cleanup = () => {
    clearTimeout(t);
    if (clientSignal) clientSignal.removeEventListener('abort', onClientAbort);
  };
  const fail = (o) => {
    cleanup();
    const aborted = !!(clientSignal && clientSignal.aborted);
    return { ok: false, ttfbMs: Date.now() - t0, aborted, ...o, ...(aborted ? { network: true } : {}) };
  };

  let res;
  try {
    res = await fetch(buildUrl(provider, pathname, search), {
      method,
      headers: buildHeaders(clientHeaders, provider),
      body: bodyBuf && method !== 'GET' && method !== 'HEAD' ? bodyBuf : undefined,
      signal: ac.signal,
      redirect: 'follow',
    });
  } catch (e) {
    const cause = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || String(e);
    return fail(timedOut ? { timeout: true, text: `等待响应超过 ${settings.firstByteTimeoutSec} 秒` } : { network: true, text: cause });
  }
  const ttfbMs = Date.now() - t0;
  const ctype = res.headers.get('content-type') || '';

  // Non-2xx: read (capped) body and report failure.
  if (res.status < 200 || res.status >= 300) {
    let buf = Buffer.alloc(0);
    try {
      buf = res.body ? await readCapped(res.body.getReader(), 64 * 1024) : buf;
    } catch {}
    const text = buf.toString('utf8');
    const pe = parseError(text);
    return fail({
      status: res.status,
      text: pe.message || `HTTP ${res.status}`,
      raw: text.slice(0, 4000),
      errorType: pe.errorType,
      retryAfterSec: retryAfterSec(res.headers),
      timeout: timedOut,
    });
  }

  // SSE: hold until first meaningful event or an error event.
  if (ctype.includes('text/event-stream') && res.body) {
    const reader = res.body.getReader();
    const scanner = new SseScanner();
    const pending = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (scanner.error) break;
          return fail({ status: res.status, streamError: true, text: '流在返回任何内容前就结束了' });
        }
        pending.push(value);
        size += value.length;
        scanner.push(value);
        if (scanner.error || scanner.meaningful || size > PRECOMMIT_MAX) break;
      }
    } catch (e) {
      return fail(timedOut ? { timeout: true, text: `等待首个事件超过 ${settings.firstByteTimeoutSec} 秒` } : { network: true, text: e.message });
    }
    if (scanner.error) {
      reader.cancel().catch(() => {});
      return fail({ status: res.status, streamError: true, text: scanner.error.message, errorType: scanner.error.type, raw: scanner.error.raw });
    }
    clearTimeout(t);
    return {
      ok: true,
      stream: true,
      status: res.status,
      headers: responseHeaders(res.headers, provider),
      reader,
      scanner,
      pending,
      controller: ac,
      ttfbMs: Date.now() - t0,
      t0,
      // Caller owns the rest of the stream; it must call release() when done.
      release: cleanup,
      isTimedOut: () => timedOut,
      setTimer: (sec) => {
        clearTimeout(t);
        t = timer(sec);
      },
    };
  }

  // Non-streaming body.
  clearTimeout(t);
  t = timer(settings.nonStreamTimeoutSec);
  let buf;
  try {
    buf = res.body ? await readCapped(res.body.getReader(), 64 * 1024 * 1024) : Buffer.alloc(0);
  } catch (e) {
    return fail(timedOut ? { timeout: true, text: `读取响应超过 ${settings.nonStreamTimeoutSec} 秒` } : { network: true, text: e.message });
  }
  cleanup();
  let json = null;
  if (ctype.includes('json') || buf[0] === 0x7b) {
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {}
  }
  if (json && json.type === 'error') {
    const pe = parseError(buf.toString('utf8'));
    return { ok: false, status: res.status, text: pe.message, errorType: pe.errorType, raw: buf.toString('utf8').slice(0, 4000), ttfbMs };
  }
  return { ok: true, stream: false, status: res.status, headers: responseHeaders(res.headers, provider), buf, json, ttfbMs, ctype };
}

function writeChunk(res, chunk) {
  return new Promise((resolve) => {
    if (res.write(chunk)) return resolve();
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

// Pipe a committed SSE attempt to the client. Resolves with { completed, error, aborted, usage }.
// An optional rewriter transforms what the client sees; the scanner always reads the original bytes.
async function pipeStream(att, res, settings, rewriter = null) {
  res.writeHead(att.status, att.headers);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const { reader, scanner } = att;
  let error = null;
  let aborted = false;
  const out = async (c) => {
    if (!rewriter) return writeChunk(res, c);
    const s = rewriter.push(c);
    if (s) await writeChunk(res, s);
  };
  try {
    for (const c of att.pending) await out(c);
    att.setTimer(settings.idleTimeoutSec);
    for (;;) {
      if (res.destroyed) {
        aborted = true;
        break;
      }
      // Some relays keep the connection open after message_stop; finish the client response right away.
      if (scanner.stopped) {
        reader.cancel().catch(() => {});
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      att.setTimer(settings.idleTimeoutSec);
      scanner.push(value);
      await out(value);
    }
    if (rewriter && !res.destroyed) {
      const rest = rewriter.flush();
      if (rest) await writeChunk(res, rest);
    }
  } catch (e) {
    if (res.destroyed) aborted = true;
    else error = att.isTimedOut() ? `流式输出空闲超过 ${settings.idleTimeoutSec} 秒` : e.message || String(e);
  }
  att.release();
  if (aborted) reader.cancel().catch(() => {});
  if (error && !res.destroyed) {
    const payload = { type: 'error', error: { type: 'api_error', message: `[智能路由] 上游流中断：${error}` } };
    res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  if (!res.destroyed) res.end();
  if (!error && !aborted && scanner.error) error = scanner.error.message;
  return { completed: !error && !aborted && scanner.stopped, error, aborted, usage: scanner.usage };
}

module.exports = { attempt, pipeStream, buildHeaders, buildUrl, parseError };
