'use strict';
// Configurable fake Anthropic relay for tests.
const http = require('node:http');

function sseBody(text, usage) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return (
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: usage.input || 10, output_tokens: 1 } } }) +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) +
    ev('message_stop', {})
  );
}

// behavior(ctx) -> { status, json } | { sse: text } | { raw, status, headers } | 'hang'
function createMock(name, behavior) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {}
      const ctx = { name, method: req.method, path: req.url, headers: req.headers, body, n: calls.length };
      calls.push(ctx);
      const out = mock.behavior(ctx);
      if (out === 'disconnect') return req.socket.destroy();
      if (out === 'hang') return;
      if (out.sse != null) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (out.hold) return res.write(out.sse); // never closes, like some relays
        return res.end(out.sse);
      }
      if (out.raw != null) {
        res.writeHead(out.status || 200, out.headers || {});
        return res.end(out.raw);
      }
      const buf = Buffer.from(JSON.stringify(out.json));
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) });
      res.end(buf);
    });
  });
  const mock = {
    name,
    calls,
    behavior,
    server,
    url: null,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      mock.url = `http://127.0.0.1:${server.address().port}`;
      return mock;
    },
    close() {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
  return mock;
}

const ok = (ctx, text = `hello from ${ctx.name}`) => {
  if (ctx.body && ctx.body.stream) return { sse: sseBody(text, {}) };
  return {
    json: {
      id: 'msg_1', type: 'message', role: 'assistant', model: ctx.body && ctx.body.model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
};

const err = (status, type, message) => ({ status, json: { type: 'error', error: { type, message } } });

module.exports = { createMock, ok, err, sseBody };
