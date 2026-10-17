'use strict';
// When a compacted history was sent upstream, the real usage is small and Claude Code would think the
// context is nearly empty, so its own auto-compact never fires. Scale the reported input back up to the
// size of the full history the client actually holds. Only what the client sees changes; logs keep real usage.

function totalInput(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// Adds `extra` to input_tokens (cache fields stay real so cost display is unaffected).
function inflate(u, extra) {
  if (!u || typeof u.input_tokens !== 'number' || extra <= 0) return u;
  return { ...u, input_tokens: u.input_tokens + extra };
}

class UsageRewriter {
  // ratio = fullEst / sentEst: how much bigger the client's real history is than what went upstream.
  constructor(ratio) {
    this.ratio = ratio;
    this.extra = null; // fixed once message_start arrives
    this.buf = '';
    this.decoder = new TextDecoder();
  }

  extraFor(u) {
    if (this.extra == null) this.extra = Math.max(0, Math.round(totalInput(u) * (this.ratio - 1)));
    return this.extra;
  }

  rewriteEvent(raw) {
    const lines = raw.split(/\r?\n/);
    const di = lines.findIndex((l) => l.startsWith('data:'));
    if (di < 0) return raw;
    let obj;
    try {
      obj = JSON.parse(lines[di].slice(5).trim());
    } catch {
      return raw;
    }
    if (obj.type === 'message_start' && obj.message && obj.message.usage) {
      obj.message.usage = inflate(obj.message.usage, this.extraFor(obj.message.usage));
    } else if (obj.type === 'message_delta' && obj.usage && typeof obj.usage.input_tokens === 'number') {
      obj.usage = inflate(obj.usage, this.extraFor(obj.usage));
    } else {
      return raw;
    }
    lines[di] = 'data: ' + JSON.stringify(obj);
    return lines.join('\n');
  }

  // Returns the rewritten text for every complete event in the chunk; holds back a partial tail.
  push(chunk) {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let out = '';
    let m;
    while ((m = this.buf.match(/\r?\n\r?\n/))) {
      const end = m.index + m[0].length;
      out += this.rewriteEvent(this.buf.slice(0, m.index)) + m[0];
      this.buf = this.buf.slice(end);
    }
    return out;
  }

  flush() {
    const rest = this.buf + this.decoder.decode();
    this.buf = '';
    return rest;
  }
}

function rewriteJsonUsage(json, ratio) {
  if (!json || !json.usage || ratio <= 1) return null;
  const extra = Math.max(0, Math.round(totalInput(json.usage) * (ratio - 1)));
  return { ...json, usage: inflate(json.usage, extra) };
}

module.exports = { UsageRewriter, rewriteJsonUsage };
