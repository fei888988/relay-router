'use strict';

// Only transform outbound copies. Never delete image blocks or touch source files.
const sharp = require('sharp');
const { createHash } = require('node:crypto');

const cache = new Map();
let cacheBytes = 0;
const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_ENTRIES = 128;

function images(body) {
  const found = [];
  function walk(content) {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block) continue;
      if (block.type === 'image') found.push(block);
      if (block.type === 'tool_result') walk(block.content);
    }
  }
  for (const message of body.messages || []) walk(message.content);
  return found;
}

function remember(key, value) {
  const bytes = value.data.length;
  if (bytes > CACHE_BYTES) return;
  while (cache.size >= CACHE_ENTRIES || cacheBytes + bytes > CACHE_BYTES) {
    const first = cache.keys().next().value;
    cacheBytes -= cache.get(first).data.length;
    cache.delete(first);
  }
  cache.set(key, value);
  cacheBytes += bytes;
}

async function encode(source, step, recent, minEdge) {
  const key = createHash('sha256').update(source.data).update(`|${step}|${recent}|${minEdge}`).digest('hex');
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const input = Buffer.from(source.data, 'base64');
  const options = { limitInputPixels: 40 * 1000 * 1000, failOn: 'warning' };
  const meta = await sharp(input, options).metadata();
  // Animation must not silently turn into its first frame.
  if ((meta.pages || 1) > 1) throw new Error('animated image');
  const edges = recent ? [Infinity, Infinity, 2048, 1600, minEdge] : [Infinity, Infinity, 1536, 1280, minEdge];
  const edge = Math.max(minEdge, edges[step]);
  let pipeline = sharp(input, options).rotate().timeout({ seconds: 3 });
  if (Number.isFinite(edge)) pipeline = pipeline.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
  // WebP keeps transparency; unlike JPEG it doesn't flatten design assets onto a new background.
  const output = await pipeline.webp(step === 0 ? { lossless: true, effort: 2 } : {
    quality: [100, 90, 86, 82, 78][step], alphaQuality: 100, effort: 2,
  }).toBuffer();
  const result = { data: output.toString('base64'), media_type: 'image/webp' };
  remember(key, result);
  return result;
}

async function fitImages(body, limit, settings = {}, signal) {
  const before = Buffer.byteLength(JSON.stringify(body));
  const target = Math.floor(limit * 0.94); // JSON/base64 are included, with room for relay overhead.
  if (settings.enabled === false || !limit || before <= target) return { body, before, after: before, changed: 0 };
  const originals = images(body);
  if (!originals.length) return { body, before, after: before, changed: 0 };
  const copy = structuredClone(body);
  const blocks = images(copy);
  const failed = new Set();
  let after = before;
  let changed = 0;
  const minEdge = settings.minLongestEdge || 1024;
  const deadline = Date.now() + 12000;
  // Older images first at each level. Stop as soon as the whole request fits.
  for (let step = 0; step < 5 && after > target; step++) {
    for (let i = 0; i < blocks.length && after > target; i++) {
      if (signal?.aborted) return { body, before, after: before, changed: 0, aborted: true };
      if (Date.now() >= deadline) break;
      const source = originals[i].source;
      if (failed.has(i) || source?.type !== 'base64' || typeof source.data !== 'string') continue;
      try {
        const candidate = await encode(source, step, i >= blocks.length - 2, minEdge);
        const replacement = { ...blocks[i].source, ...candidate };
        const saving = Buffer.byteLength(JSON.stringify(blocks[i].source)) - Buffer.byteLength(JSON.stringify(replacement));
        if (saving <= 0) continue;
        blocks[i].source = replacement;
        after -= saving;
      } catch {
        // Bad/unsupported files stay intact. No image contents in logs or persistent caches.
        failed.add(i);
      }
    }
  }
  changed = blocks.filter((block, i) => block.source?.data !== originals[i].source?.data).length;
  return { body: changed ? copy : body, before, after, changed, failed: failed.size, count: blocks.length, fits: after <= target };
}

module.exports = { fitImages, images };
