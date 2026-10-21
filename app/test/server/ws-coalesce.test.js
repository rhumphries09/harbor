'use strict';

// A SLOW CLIENT MUST NOT BE DISCONNECTED FOR RECEIVING A STORM OF SNAPSHOTS
// (live-caught 2026-08-06, on Pat's phone).
//
// He opened Harbor on his phone and it showed "Cannot reach harbor-server",
// then connected for about half a second, then went back to Disconnected, over
// and over. The server log showed four clients authenticating successfully
// within twelve seconds, so the handshake was never the problem: the socket was
// being closed immediately after it opened.
//
// Measured against his running machine with a real WebSocket client: 50 pushes
// in 20 seconds, 48 of them `transcript:update` for ONE session, identical
// content, in bursts of about thirteen every five seconds. The queue's own
// comment already records that such a payload is 0.19 to 0.50 MB, so one burst
// is most of the 8MB cap. A localhost client drains fast enough to survive it.
// A phone over Tailscale does not, and the overflow path closes any channel
// that is not `terminal:frame` with 1013 "client too slow". Flood, close,
// reconnect, flood.
//
// The MOBILE-9 security gate proves a slow client drops terminal FRAMES rather
// than growing unbounded, and it passes, because terminal frames are the one
// channel with an eviction rule. Nothing covered the channel that was actually
// killing him.
//
// The fix is coalescing, not a bigger cap: these payloads are whole-state
// snapshots, so a newer one supersedes an older one and dropping the older is
// lossless. A bigger cap would only move the same failure further out.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ClientQueue, coalesceKey } = require('../../src/server/transport/ws.js');

const push = (channel, args) => ({ type: 'push', channel, args });

test('mobile coalescing preserves transcript evictions without resending images', () => {
  const { applyTranscriptUpdate } = require('../../src/shared/transcript-blocks.cjs');
  const queue = new ClientQueue();
  const image = { key: 'image', images: [{ dataUri: 'synthetic-image' }] };
  const initial = [image, { key: 'old', text: 'old' }];
  const deltas = [
    { sessionId: 'sample', append: [{ key: 'a', text: 'a' }], removed: ['old'] },
    { sessionId: 'sample', append: [{ key: 'b', text: 'b' }], removed: ['a'] },
    { sessionId: 'sample', append: [], changed: [{ key: 'b', text: 'finished' }] },
  ];
  for (const delta of deltas) {
    const payload = push('transcript:update', [delta]);
    queue.enqueue('transcript:update', payload, coalesceKey('transcript:update', payload.args));
  }
  assert.equal(queue.length, 1);
  const combined = JSON.parse(queue.items[0].text).args[0];
  const actual = applyTranscriptUpdate(initial, combined);
  assert.deepEqual(actual, deltas.reduce(applyTranscriptUpdate, initial));
  assert.equal(actual[0], image);
});

test('a burst of transcript snapshots for one session costs ONE queue slot', () => {
  const queue = new ClientQueue({ limit: 256, maxBytes: 8 * 1024 * 1024 });
  const channel = 'transcript:update';

  for (let i = 0; i < 13; i += 1) {
    const payload = push(channel, [{ sessionId: 'S1', replace: [{ id: 'b', seq: i }], contextTokens: 578693, seq: i }]);
    assert.equal(queue.enqueue(channel, payload, coalesceKey(channel, payload.args)), true);
  }

  assert.equal(queue.length, 1, 'thirteen snapshots of one session must collapse to one');
  // And the survivor is the NEWEST, which is the whole justification.
  assert.match(queue.items[0].text, /"seq":12/);
});

test('two different sessions do NOT collapse into each other', () => {
  const queue = new ClientQueue({ limit: 256, maxBytes: 8 * 1024 * 1024 });
  const channel = 'transcript:update';
  for (const id of ['S1', 'S2', 'S1', 'S2', 'S3']) {
    const payload = push(channel, [{ sessionId: id, replace: [] }]);
    queue.enqueue(channel, payload, coalesceKey(channel, payload.args));
  }
  assert.equal(queue.length, 3, 'one slot per session, not one slot total');
});

test('a coalesced replacement keeps its predecessor\'s position', () => {
  // Otherwise a client can see one channel jump ahead of another and render
  // state that never existed in that order.
  const queue = new ClientQueue({ limit: 256, maxBytes: 8 * 1024 * 1024 });
  const t = push('transcript:update', [{ sessionId: 'S1', replace: [], seq: 1 }]);
  queue.enqueue('transcript:update', t, coalesceKey('transcript:update', t.args));
  queue.enqueue('send:status', push('send:status', [{ phase: 'sent' }]), null);
  const t2 = push('transcript:update', [{ sessionId: 'S1', replace: [], seq: 2 }]);
  queue.enqueue('transcript:update', t2, coalesceKey('transcript:update', t2.args));

  assert.equal(queue.length, 2);
  assert.equal(queue.items[0].channel, 'transcript:update', 'the replacement stays first');
  assert.match(queue.items[0].text, /"seq":2/);
  assert.equal(queue.items[1].channel, 'send:status');
});

test('byte accounting stays exact across a replacement', () => {
  // The cap is a BYTE cap; a replacement that forgot to subtract the old size
  // would leak the queue toward the limit and reintroduce the disconnect.
  const queue = new ClientQueue({ limit: 256, maxBytes: 8 * 1024 * 1024 });
  const small = push('transcript:update', [{ sessionId: 'S1', replace: [], pad: 'x' }]);
  queue.enqueue('transcript:update', small, coalesceKey('transcript:update', small.args));
  const afterSmall = queue.bytes;

  const big = push('transcript:update', [{ sessionId: 'S1', replace: [], pad: 'x'.repeat(5000) }]);
  queue.enqueue('transcript:update', big, coalesceKey('transcript:update', big.args));
  assert.equal(queue.length, 1);
  assert.ok(queue.bytes > afterSmall, 'bytes must follow the new payload');
  assert.equal(queue.bytes, Buffer.byteLength(queue.items[0].text), 'bytes must equal what is actually queued');

  const back = push('transcript:update', [{ sessionId: 'S1', replace: [], pad: 'y' }]);
  queue.enqueue('transcript:update', back, coalesceKey('transcript:update', back.args));
  assert.equal(queue.bytes, Buffer.byteLength(queue.items[0].text), 'and shrink again, not leak');
});

test('the storm that disconnected the phone no longer overflows', () => {
  // The real shape: half-megabyte snapshots, bursts of thirteen, four bursts,
  // against a client that never drains. Before coalescing this exceeded 8MB and
  // returned false, which is what closed the socket.
  const queue = new ClientQueue({ limit: 256, maxBytes: 8 * 1024 * 1024 });
  const channel = 'transcript:update';
  let refused = 0;
  for (let burst = 0; burst < 4; burst += 1) {
    for (let i = 0; i < 13; i += 1) {
      const payload = push(channel, [{ sessionId: 'S1', replace: [], blob: 'x'.repeat(500 * 1024) }]);
      if (!queue.enqueue(channel, payload, coalesceKey(channel, payload.args))) refused += 1;
    }
  }
  assert.equal(refused, 0, 'no push may be refused, because a refusal closes the connection');
  assert.equal(queue.length, 1);
  assert.ok(queue.bytes < 8 * 1024 * 1024);
});

test('channels that are NOT snapshots keep their append-only behaviour', () => {
  // send:status is a sequence of distinct events; collapsing it would lose the
  // phases a user reads to know a send landed.
  assert.equal(coalesceKey('send:status', [{ phase: 'sent' }]), null);
  assert.equal(coalesceKey('terminal:frame', [{ data: 'x' }]), null);
  assert.equal(coalesceKey('sidebar:update', [{}]), 'sidebar:update');
  // A transcript push with no session id has nothing to key on and must not
  // collapse unrelated updates together.
  assert.equal(coalesceKey('transcript:update', [{}]), null);
});

// AN APPEND IS A DELTA AND MUST NEVER BE COALESCED (live-caught by Pat on his
// phone, 2026-08-07).
//
// `transcript:update` carries two shapes. `{ replace: blocks }` is the whole
// live block list, so a newer one makes an older one redundant, which is what
// this file's coalescing exists for. `{ append, changed }` is a DELTA emitted
// when new blocks arrive, i.e. exactly when a message is sent. Coalescing those
// discarded the earlier one: a second message about fifteen seconds after the
// first replaced the first append in the queue, and the blocks in it were never
// delivered. The message itself had landed, so desktop (IPC, no coalescing)
// showed it, and the phone never did, permanently, because an append is only
// sent once and nothing re-sends it.

test('two appends MERGE into one item and neither loses its blocks', () => {
  const first = { args: [{ sessionId: 's1', append: [{ id: 'b1' }], changed: [] }] };
  const second = { args: [{ sessionId: 's1', append: [{ id: 'b2' }], changed: [] }] };

  const queue = new ClientQueue({ clientId: 'append-test' });
  queue.enqueue('transcript:update', first, coalesceKey('transcript:update', first.args));
  queue.enqueue('transcript:update', second, coalesceKey('transcript:update', second.args));

  // ONE slot, so a burst cannot grow the backlog without bound...
  assert.equal(queue.length, 1, 'appends must not accumulate; that is what closes a slow connection');
  // ...and BOTH messages are still in it, which is the half that matters to Pat.
  assert.match(queue.items[0].text, /b1/, 'the first append must survive the merge');
  assert.match(queue.items[0].text, /b2/, 'the second append must survive the merge');
});

test('a replace still supersedes, so the flood this was built for is unaffected', () => {
  const a = { args: [{ sessionId: 's1', replace: [{ id: 'b1' }] }] };
  const b = { args: [{ sessionId: 's1', replace: [{ id: 'b1' }, { id: 'b2' }] }] };

  const queue = new ClientQueue({ clientId: 'replace-test' });
  queue.enqueue('transcript:update', a, coalesceKey('transcript:update', a.args));
  queue.enqueue('transcript:update', b, coalesceKey('transcript:update', b.args));
  assert.equal(queue.length, 1, 'a newer whole-state snapshot supersedes its predecessor');
  assert.equal(queue.coalesced, 1);
});

test('a replace and an append for one session stay separate, in order', () => {
  // They carry different KINDS of truth: the snapshot is everything up to a
  // point, the delta is what came after it. Collapsing them either way loses
  // blocks, so they get different keys and both are delivered.
  const snapshot = { args: [{ sessionId: 's1', replace: [{ id: 'b1' }] }] };
  const delta = { args: [{ sessionId: 's1', append: [{ id: 'b2' }], changed: [] }] };

  const queue = new ClientQueue({ clientId: 'mixed-test' });
  queue.enqueue('transcript:update', snapshot, coalesceKey('transcript:update', snapshot.args));
  queue.enqueue('transcript:update', delta, coalesceKey('transcript:update', delta.args));
  assert.equal(queue.length, 2);
  assert.match(queue.items[0].text, /"replace"/);
  assert.match(queue.items[1].text, /"append"/);
});

test('appends for DIFFERENT sessions never merge into each other', () => {
  const one = { args: [{ sessionId: 's1', append: [{ id: 'a1' }], changed: [] }] };
  const two = { args: [{ sessionId: 's2', append: [{ id: 'a2' }], changed: [] }] };
  const queue = new ClientQueue({ clientId: 'cross-session' });
  queue.enqueue('transcript:update', one, coalesceKey('transcript:update', one.args));
  queue.enqueue('transcript:update', two, coalesceKey('transcript:update', two.args));
  assert.equal(queue.length, 2, 'one slot per session, never one slot total');
});

test('byte accounting stays exact when an append merges', () => {
  const queue = new ClientQueue({ clientId: 'bytes' });
  const first = { args: [{ sessionId: 's1', append: [{ id: 'b1' }], changed: [] }] };
  const second = { args: [{ sessionId: 's1', append: [{ id: 'b2' }], changed: [] }] };
  queue.enqueue('transcript:update', first, coalesceKey('transcript:update', first.args));
  queue.enqueue('transcript:update', second, coalesceKey('transcript:update', second.args));
  const actual = queue.items.reduce((sum, item) => sum + item.bytes, 0);
  assert.equal(queue.bytes, actual, 'a merge that mis-accounts bytes leaks the queue toward its cap');
});

// A NEWER SNAPSHOT OVERTOOK THE APPEND IT ALREADY CONTAINED (2026-10-06, Pat:
// "messages appear to be sending and receiving twice in harbor").
//
// A replace takes its predecessor's position, which is AHEAD of an append queued
// after that predecessor. The client then received the full list, already
// holding the new message, and then the append that minted it, and drew the
// message twice. The phone opens every chat twice and each open broadcasts a
// replace, so this was routine. The newer replace now drops queued appends for
// its session: everything they carried is in it.
test('a newer replace drops the appends queued for its session, so nothing arrives twice', () => {
  const { applyTranscriptUpdate } = require('../../src/shared/transcript-blocks.cjs');
  const queue = new ClientQueue({ clientId: 'overtake' });
  const enqueue = (payload) => queue.enqueue('transcript:update', { args: [payload] }, coalesceKey('transcript:update', [payload]));
  enqueue({ sessionId: 's1', replace: [{ key: 'b0' }] });
  enqueue({ sessionId: 's1', append: [{ key: 'b1' }], changed: [] });
  enqueue({ sessionId: 's2', append: [{ key: 'x1' }], changed: [] });
  enqueue({ sessionId: 's1', replace: [{ key: 'b0' }, { key: 'b1' }] });

  const delivered = queue.items.map((item) => JSON.parse(item.text).args[0]);
  assert.deepEqual(delivered.map((p) => `${p.sessionId}:${p.replace ? 'replace' : 'append'}`), ['s1:replace', 's2:append'],
    'the overtaken s1 append is gone; another session\'s append is untouched');
  assert.equal(queue.bytes, queue.items.reduce((sum, item) => sum + item.bytes, 0), 'bytes stay exact after the drop');

  let blocks = [];
  for (const payload of delivered.filter((p) => p.sessionId === 's1')) blocks = applyTranscriptUpdate(blocks, payload);
  assert.deepEqual(blocks.map((b) => b.key), ['b0', 'b1']);
});

test('an append queued AFTER the newest replace still arrives after it', () => {
  const queue = new ClientQueue({ clientId: 'after' });
  const enqueue = (payload) => queue.enqueue('transcript:update', { args: [payload] }, coalesceKey('transcript:update', [payload]));
  enqueue({ sessionId: 's1', replace: [{ key: 'b0' }] });
  enqueue({ sessionId: 's1', append: [{ key: 'b1' }], changed: [] });
  assert.equal(queue.length, 2, 'a delta newer than every snapshot is never dropped');
});

// THE CAP HOLDS AFTER A MERGE, AND A MERGE KEEPS ONE COPY PER KEY (2026-10-21
// audit). The merge path returned before any bound was checked, and it
// concatenated `changed`, so a slow phone's one slot grew by a whole
// image-bearing prompt per token tick: a queue capped at 1,024 bytes accepted
// twenty merged deltas holding 18,536 bytes.
test('a merged delta that outgrows the byte cap is refused, after frames are evicted first', () => {
  const queue = new ClientQueue({ maxBytes: 1024, logger: { warn() {} } });
  const results = [];
  for (let i = 0; i < 20; i += 1) {
    const payload = push('transcript:update', [{ sessionId: 's', append: [{ key: `b${i}`, text: 'x'.repeat(900) }] }]);
    results.push(queue.enqueue('transcript:update', payload, coalesceKey('transcript:update', payload.args)));
  }
  assert.equal(results[0], true, 'the first push fits as before');
  assert.equal(results[1], false, 'a merge that grows the slot past the cap is refused (the transport closes 1013)');
  assert.ok(queue.bytes <= 1024, `retained ${queue.bytes} bytes against a 1024 byte cap`);

  // Frames are the recoverable channel, so they go before a merge is refused.
  const framed = new ClientQueue({ maxBytes: 1024, logger: { warn() {} } });
  framed.enqueue('terminal:frame', push('terminal:frame', [{ data: 'f'.repeat(500) }]));
  const first = push('transcript:update', [{ sessionId: 's', append: [{ key: 'b0', text: 'x'.repeat(300) }] }]);
  const second = push('transcript:update', [{ sessionId: 's', append: [{ key: 'b1', text: 'x'.repeat(300) }] }]);
  assert.equal(framed.enqueue('transcript:update', first, coalesceKey('transcript:update', first.args)), true);
  assert.equal(framed.enqueue('transcript:update', second, coalesceKey('transcript:update', second.args)), true);
  assert.equal(framed.droppedFrames, 1);
  assert.deepEqual(framed.items.map((item) => item.channel), ['transcript:update']);
  assert.equal(framed.bytes, Buffer.byteLength(framed.items[0].text));
});

test('a superseding snapshot alone in the queue is still admitted however large', () => {
  const queue = new ClientQueue({ maxBytes: 1024, logger: { warn() {} } });
  const big = (n) => push('transcript:update', [{ sessionId: 's', replace: [{ key: 'b0', text: 'x'.repeat(4096), n }] }]);
  assert.equal(queue.enqueue('transcript:update', big(1), coalesceKey('transcript:update', big(1).args)), true);
  assert.equal(queue.enqueue('transcript:update', big(2), coalesceKey('transcript:update', big(2).args)), true,
    'a newer snapshot replaces its slot; it is one payload, not a backlog');
  assert.equal(queue.length, 1);
});

test('repeated versions of one image prompt keep ONE copy in the slot, latest wins', () => {
  const { applyTranscriptUpdate } = require('../../src/shared/transcript-blocks.cjs');
  const image = `data:image/png;base64,${'I'.repeat(4000)}`;
  const prompt = (n) => ({ key: 'p', kind: 'user', text: 'look', images: [{ dataUri: image }], turnMeta: { outputTokens: n } });
  const initial = [prompt(0)];
  const deltas = [];
  for (let i = 1; i <= 12; i += 1) {
    // The pre-patch provider shape: the whole prompt rode in `changed` each time.
    deltas.push({ sessionId: 's', append: [{ key: `r${i}`, text: `reply ${i}` }], changed: [prompt(i)] });
  }
  deltas.push({ sessionId: 's', append: [], changed: [], patched: [{ key: 'p', turnMeta: { outputTokens: 99 } }] });
  const queue = new ClientQueue();
  for (const delta of deltas) {
    const payload = push('transcript:update', [delta]);
    queue.enqueue('transcript:update', payload, coalesceKey('transcript:update', payload.args));
  }
  assert.equal(queue.length, 1);
  assert.equal(queue.items[0].text.split(image).length - 1, 1, 'one copy of the image, not twelve');
  const combined = JSON.parse(queue.items[0].text).args[0];
  assert.deepEqual(applyTranscriptUpdate(initial, combined), deltas.reduce(applyTranscriptUpdate, initial));
  assert.equal(applyTranscriptUpdate(initial, combined)[0].turnMeta.outputTokens, 99);
});

test('any sequence of deltas merges into one that applies exactly like the sequence', () => {
  const { applyTranscriptUpdate } = require('../../src/shared/transcript-blocks.cjs');
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const keys = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'];
  const pick = () => keys[rand(keys.length)];
  const some = (make) => Array.from({ length: rand(3) }, make);
  for (let trial = 0; trial < 400; trial += 1) {
    const initial = keys.slice(0, rand(4)).map((key) => ({ key, v: 'held', img: 'kept' }));
    const deltas = Array.from({ length: 2 + rand(5) }, (_, d) => ({
      sessionId: 's',
      ...(rand(3) === 0 ? { removed: some(pick) } : {}),
      changed: some(() => ({ key: pick(), v: `c${trial}.${d}` })),
      ...(rand(2) ? { patched: some(() => ({ key: pick(), [`p${rand(2)}`]: `${trial}.${d}` })) } : {}),
      append: some(() => ({ key: pick(), v: `a${trial}.${d}` })),
    }));
    const queue = new ClientQueue();
    for (const delta of deltas) {
      const payload = push('transcript:update', [delta]);
      queue.enqueue('transcript:update', payload, coalesceKey('transcript:update', payload.args));
    }
    assert.equal(queue.length, 1);
    const combined = JSON.parse(queue.items[0].text).args[0];
    assert.deepEqual(applyTranscriptUpdate(initial, combined), deltas.reduce(applyTranscriptUpdate, initial),
      `trial ${trial}: ${JSON.stringify(deltas)}`);
  }
});
