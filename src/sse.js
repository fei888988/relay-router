'use strict';
// Incremental SSE parser for Anthropic streams: extracts usage, errors and whether real content started.

const MEANINGFUL = new Set(['message_start', 'content_block_start', 'content_block_delta', 'message_delta', 'message_stop']);

class SseScanner {
  constructor() {
    this.buf = '';
    this.decoder = new TextDecoder();
    this.meaningful = false;
    this.error = null; // { type, message, raw }
    this.usage = {};
    this.stopped = false;
    this.events = 0;
  }

  push(chunk) {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = this.buf.slice(0, idx);
      const m = this.buf.slice(idx).match(/^\r?\n\r?\n/);
      this.buf = this.buf.slice(idx + m[0].length);
      this.handle(raw);
    }
    // Guard against a relay that never sends blank lines.
    if (this.buf.length > 4 * 1024 * 1024) this.buf = this.buf.slice(-65536);
  }

  handle(raw) {
    let event = null;
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!event && !data.length) return; // comment / keep-alive
    this.events++;
    let obj = null;
    const text = data.join('\n');
    if (text && text !== '[DONE]') {
      try {
        obj = JSON.parse(text);
      } catch {}
    }
    const type = event || (obj && obj.type) || null;
    if (type === 'error' || (obj && obj.type === 'error')) {
      const e = (obj && obj.error) || {};
      this.error = { type: e.type || 'error', message: e.message || text.slice(0, 500), raw: text.slice(0, 2000) };
      return;
    }
    if (MEANINGFUL.has(type)) this.meaningful = true;
    if (!obj) return;
    if (type === 'message_start' && obj.message && obj.message.usage) Object.assign(this.usage, obj.message.usage);
    else if (type === 'message_delta' && obj.usage) Object.assign(this.usage, obj.usage);
    else if (type === 'message_stop') this.stopped = true;
  }
}

module.exports = { SseScanner };
