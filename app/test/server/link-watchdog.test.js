'use strict';

// harbor-server heals its own wedged daemon links (2026-10-11). Two-sided: it
// exits when its links fail while the daemon answers a fresh ping, and it stays
// up when the daemon itself is unreachable or the errors are not link errors.

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
    errorsToTrip: 4,
    now: () => t,
  });
  return { watchdog, exits, logs, advance: (ms) => { t += ms; } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

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

test('the same errors with the daemon itself down keep the server up', async () => {
  const h = harness({ pingOk: false });
  for (let i = 0; i < 6; i += 1) h.watchdog.note('sidebar', new Error('session daemon connection closed'));
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
