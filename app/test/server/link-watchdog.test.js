'use strict';

// harbor-server heals its own wedged daemon links (2026-10-11). Two-sided: it
// exits when its links fail while the daemon answers a fresh ping, and it stays
// up when the daemon itself is unreachable or the errors are not link errors.
// Since 2026-10-20 it counts BURSTS: one slow daemon moment (a timeout plus the
// "connection closed" of every request in flight, all in one instant) is one
// burst and must never restart the server, while a link that fails on every
// poll still trips.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createLinkWatchdog } = require('../../src/server/link-watchdog.js');

function harness({ pingOk = true } = {}) {
  let t = 0;
  const exits = [];
  const logs = [];
  const watchdog = createLinkWatchdog({
    ping: async () => { if (!pingOk) throw new Error('daemon unreachable'); },
    exit: (code) => exits.push(code),
    log: (m) => logs.push(m),
    windowMs: 120_000,
    burstsToTrip: 4,
    now: () => t,
  });
  return { watchdog, exits, logs, advance: (ms) => { t += ms; } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// What one daemon stall longer than the client's 10 s timeout produces: the
// timed-out request, then every other in-flight request rejected by the
// socket the timeout destroyed.
function oneStall(watchdog) {
  watchdog.note('sidebar', new Error('list request timed out after 10000ms'));
  for (let i = 0; i < 9; i += 1) watchdog.note(i % 2 ? 'terminal-bridge' : 'sidebar', new Error('session daemon connection closed'));
}

test('repeated link errors with a healthy daemon exit so the respawn loop restarts the server', async () => {
  const h = harness();
  for (let i = 0; i < 3; i += 1) { h.watchdog.note('sidebar', new Error('list request timed out after 10000ms')); h.advance(10_000); }
  await tick();
  assert.deepEqual(h.exits, [], 'three errors are not a wedge');
  h.watchdog.note('terminal-bridge', new Error('session daemon connection closed'));
  await tick();
  assert.deepEqual(h.exits, [75]);
  h.watchdog.note('sidebar', new Error('list request timed out after 10000ms'));
  await tick();
  assert.deepEqual(h.exits, [75], 'trips once');
});

test('one slow daemon moment never restarts the server, however many requests it fails', async () => {
  const h = harness();
  oneStall(h.watchdog);
  await tick(); await tick();
  assert.deepEqual(h.exits, [], 'a timeout and the nine requests its socket took down are one burst');
  // Stalls minutes apart, the shape of the 2026-10-20 afternoon, stay separate events.
  h.advance(61_000); oneStall(h.watchdog);
  h.advance(61_000); oneStall(h.watchdog);
  await tick(); await tick();
  assert.deepEqual(h.exits, [], 'three stalls a minute apart are not a stale link');
  assert.equal(h.watchdog.pending, 2, 'only the stalls inside the window are counted, one each');
});

test('a link that fails on every poll still trips within a minute', async () => {
  const h = harness();
  for (let i = 0; i < 4; i += 1) { oneStall(h.watchdog); h.advance(10_000); }
  await tick(); await tick();
  assert.deepEqual(h.exits, [75]);
  assert.ok(h.logs.some((m) => /4 separate link-error bursts/.test(m)));
});

test('the same errors with the daemon itself down keep the server up', async () => {
  const h = harness({ pingOk: false });
  for (let i = 0; i < 6; i += 1) { h.watchdog.note('sidebar', new Error('session daemon connection closed')); h.advance(10_000); }
  await tick(); await tick();
  assert.deepEqual(h.exits, []);
  assert.ok(h.logs.some((m) => /daemon itself is unreachable/.test(m)));
});

test('errors spread wider than the window, or not link-shaped, never trip it', async () => {
  const h = harness();
  for (let i = 0; i < 8; i += 1) { h.watchdog.note('sidebar', new Error('list request timed out')); h.advance(60_000); }
  await tick();
  assert.deepEqual(h.exits, [], 'two per two minutes is not a storm');
  const h2 = harness();
  for (let i = 0; i < 8; i += 1) h2.watchdog.note('sidebar', new Error('a transcript could not be indexed'));
  await tick();
  assert.deepEqual(h2.exits, []);
  assert.equal(h2.watchdog.pending, 0);
});
