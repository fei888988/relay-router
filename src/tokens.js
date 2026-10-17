'use strict';
// Fast, dependency-free token estimate for Anthropic Messages requests.
// Not exact; the router only compares estimates against limits learned in the same units.

function textTokens(s) {
  if (!s) return 0;
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  // ~3.6 chars/token for English/code, ~0.8 tokens per CJK char.
  return Math.ceil(ascii / 3.6 + other * 0.8);
}

function blockTokens(b) {
  if (b == null) return 0;
  if (typeof b === 'string') return textTokens(b);
  switch (b.type) {
    case 'text':
      return textTokens(b.text);
    case 'thinking':
      return textTokens(b.thinking);
    case 'redacted_thinking':
      return Math.ceil((b.data || '').length / 4);
    case 'tool_use':
    case 'server_tool_use':
      return 12 + textTokens(b.name) + textTokens(JSON.stringify(b.input || {}));
    case 'tool_result':
    case 'web_search_tool_result': {
      const c = b.content;
      if (typeof c === 'string') return 8 + textTokens(c);
      if (Array.isArray(c)) return 8 + c.reduce((n, x) => n + blockTokens(x), 0);
      return 8;
    }
    case 'image':
      return 1600;
    case 'document': {
      const data = b.source && b.source.data;
      if (b.source && b.source.type === 'text') return textTokens(b.source.data);
      return data ? Math.ceil(data.length * 0.75 / 3000) * 1500 : 3000;
    }
    default:
      return textTokens(JSON.stringify(b));
  }
}

function messageTokens(m) {
  if (!m) return 0;
  const c = m.content;
  if (typeof c === 'string') return 4 + textTokens(c);
  if (Array.isArray(c)) return 4 + c.reduce((n, b) => n + blockTokens(b), 0);
  return 4;
}

function systemTokens(body) {
  const s = body.system;
  if (!s) return 0;
  if (typeof s === 'string') return textTokens(s);
  if (Array.isArray(s)) return s.reduce((n, b) => n + blockTokens(b), 0);
  return 0;
}

function toolsTokens(body) {
  return Array.isArray(body.tools) && body.tools.length ? textTokens(JSON.stringify(body.tools)) : 0;
}

function overheadTokens(body) {
  return systemTokens(body) + toolsTokens(body);
}

function estimateRequest(body) {
  if (!body || typeof body !== 'object') return 0;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  return overheadTokens(body) + msgs.reduce((n, m) => n + messageTokens(m), 0);
}

module.exports = { textTokens, blockTokens, messageTokens, overheadTokens, estimateRequest };
