'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { randomBytes } = require('node:crypto');
const { fitImages, images } = require('../src/image-budget');

test('budget includes JSON/base64; nested images, transparency and originals survive', async () => {
  const png = await sharp(randomBytes(1400 * 1000 * 4), { raw: { width: 1400, height: 1000, channels: 4 } }).png().toBuffer();
  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } };
  const body = { messages: [{ role: 'user', content: [
    { type: 'text', text: 'Inspect layout and transparency' },
    { type: 'tool_result', tool_use_id: 'read-1', content: [block] },
  ] }] };
  const before = JSON.stringify(body);
  const fit = await fitImages(body, 2800000);
  assert.equal(JSON.stringify(body), before);
  assert.equal(fit.changed, 1);
  assert.ok(fit.after <= 2800000 * 0.94);
  assert.equal(fit.after, Buffer.byteLength(JSON.stringify(fit.body)));
  const sent = images(fit.body)[0];
  const meta = await sharp(Buffer.from(sent.source.data, 'base64')).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.hasAlpha, true);
  assert.ok(Math.max(meta.width, meta.height) >= 1024);
  assert.equal(images(fit.body).length, images(body).length);
  assert.deepEqual(await fitImages(body, 2800000), fit, 'cached transforms are deterministic');
});

test('floor, disabled, malformed and aborted cases preserve every image and text', async () => {
  const png = await sharp(randomBytes(1100 * 800 * 3), { raw: { width: 1100, height: 800, channels: 3 } }).png().toBuffer();
  const good = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } };
  const bad = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not-an-image' } };
  const body = { messages: [{ role: 'user', content: [good, bad, { type: 'text', text: 'keep me' }] }] };
  const fit = await fitImages(body, 1000);
  assert.equal(fit.fits, false);
  assert.equal(images(fit.body).length, 2);
  assert.deepEqual(images(fit.body)[1], bad);
  const meta = await sharp(Buffer.from(images(fit.body)[0].source.data, 'base64')).metadata();
  assert.equal(Math.max(meta.width, meta.height), 1024);
  assert.equal(fit.body.messages[0].content[2].text, 'keep me');
  assert.equal((await fitImages(body, 1000, { enabled: false })).body, body);
  assert.equal((await fitImages(body, 1000, {}, AbortSignal.abort())).body, body);
});

test('small requests remain byte-identical; URL images are never fetched or replaced', async () => {
  const body = { messages: [{ content: [{ type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } }] }] };
  assert.equal((await fitImages(body, 100000)).body, body);
  assert.equal((await fitImages(body, 10)).body, body);
});

test('lossless first, then optimize older images before reducing recent image quality', async () => {
  const png = await sharp(randomBytes(600 * 400 * 3), { raw: { width: 600, height: 400, channels: 3 } }).png().toBuffer();
  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } };
  const body = { messages: [{ content: [block, structuredClone(block), structuredClone(block)] }] };
  const before = Buffer.byteLength(JSON.stringify(body));
  const fit = await fitImages(body, before * 0.91);
  const sent = images(fit.body);
  assert.equal(fit.fits, true);
  assert.notEqual(sent[0].source.data, block.source.data);
  const originalPixels = await sharp(png).raw().toBuffer();
  for (const recent of sent.slice(1)) {
    const pixels = await sharp(Buffer.from(recent.source.data, 'base64')).raw().toBuffer();
    assert.ok(pixels.equals(originalPixels), 'recent images retain identical decoded pixels');
  }
  const meta = await sharp(Buffer.from(sent[0].source.data, 'base64')).metadata();
  assert.equal(meta.width, 600, 'small originals are never upscaled');
});
