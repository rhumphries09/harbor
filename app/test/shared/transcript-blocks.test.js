'use strict';

// One block key is one bubble (2026-10-06, Pat: "messages appear to be sending
// and receiving twice"). See src/shared/transcript-blocks.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyTranscriptUpdate } = require('../../src/shared/transcript-blocks.cjs');

test('sliding transcript windows remove by key and retain image identity', () => {
  const image = { key: 'b0', kind: 'user', images: [{ dataUri: 'synthetic'.repeat(10000) }] };
  const old = { key: 'b1', text: 'old' };
  const next = applyTranscriptUpdate([image, old], { removed: ['b1'], append: [{ key: 'b2', text: 'new' }] });
  assert.equal(next[0], image);
  assert.deepEqual(next.map((b) => b.key), ['b0', 'b2']);
});

const block = (key, text) => ({ key, kind: 'user', text });

test('an append whose block is already shown updates it instead of drawing it twice', () => {
  const shown = [block('b0', 'hi'), block('b1', 'queued message')];
  const next = applyTranscriptUpdate(shown, { append: [block('b1', 'queued message'), block('b2', 'reply')] });
  assert.deepEqual(next.map((b) => b.key), ['b0', 'b1', 'b2']);
});

test('the delivered copy wins, in place, so a late image still lands on its bubble', () => {
  const shown = [block('b0', 'a'), block('b1', 'b'), block('b2', 'c')];
  const withImage = { ...block('b1', 'b'), images: [{ dataUri: 'data:image/png;base64,x' }] };
  const next = applyTranscriptUpdate(shown, { append: [withImage] });
  assert.deepEqual(next.map((b) => b.key), ['b0', 'b1', 'b2']);
  assert.equal(next[1].images.length, 1);
});

test('replace, changed and a plain append behave as before', () => {
  const shown = [block('b0', 'a'), { key: 'b1', kind: 'action', status: 'pending' }];
  assert.deepEqual(applyTranscriptUpdate(shown, { replace: [block('b9', 'z')] }), [block('b9', 'z')]);
  const next = applyTranscriptUpdate(shown, {
    changed: [{ key: 'b1', kind: 'action', status: 'ok' }],
    append: [block('b2', 'c')],
  });
  assert.deepEqual(next.map((b) => b.key), ['b0', 'b1', 'b2']);
  assert.equal(next[1].status, 'ok');
  assert.equal(applyTranscriptUpdate(shown, { append: [], changed: [] }), shown, 'an empty delta keeps the same array');
});

test('a repeated key inside one append is drawn once', () => {
  const next = applyTranscriptUpdate([], { append: [block('b0', 'x'), block('b0', 'x')] });
  assert.equal(next.length, 1);
});

// A PATCH KEEPS WHAT IT DOES NOT NAME (2026-10-21 audit): a token tick on a
// screenshot prompt travels as `patched` without the screenshot, and must not
// erase it. Two-sided: `changed` still replaces whole, so a block the server
// sends complete can still drop a field.
test('a patch updates the held block in place and keeps its images', () => {
  const images = [{ dataUri: `data:image/png;base64,${'A'.repeat(1000)}` }];
  const prompt = { key: 'b0', kind: 'user', text: 'look', images, turnMeta: { outputTokens: 10, durationMs: 1000 } };
  const shown = [prompt, block('b1', 'reply')];
  const next = applyTranscriptUpdate(shown, {
    append: [block('b2', 'more')],
    changed: [],
    patched: [{ key: 'b0', kind: 'user', text: 'look', turnMeta: { outputTokens: 40, durationMs: 4000 } }],
  });
  assert.deepEqual(next.map((b) => b.key), ['b0', 'b1', 'b2']);
  assert.equal(next[0].images, images, 'the held images survive the patch');
  assert.deepEqual(next[0].turnMeta, { outputTokens: 40, durationMs: 4000 });
  assert.equal(prompt.turnMeta.outputTokens, 10, 'the held block is not mutated');
  const whole = applyTranscriptUpdate(shown, { append: [], changed: [{ key: 'b0', kind: 'user', text: 'look' }] });
  assert.equal(whole[0].images, undefined, 'control: changed still replaces the block whole');
});

test('a patch for a block not held is dropped, never drawn as a new bubble', () => {
  const shown = [block('b0', 'a')];
  const next = applyTranscriptUpdate(shown, { append: [], changed: [], patched: [{ key: 'b9', turnMeta: { outputTokens: 1 } }] });
  assert.deepEqual(next, shown);
});
