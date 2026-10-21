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

// OUR OWN STALL IS NOT A BAD LINK (2026-10-21 audit). When harbor-server's own
// event loop blocks past the 10 s request timeout, every daemon deadline fires
// the moment it resumes, against a daemon that answered long ago. The audit
// drove the real watchdog to exit on four such recovered stalls 30 s apart.
// Two-sided: the same errors still trip when this process did not stall, and
// errors that land well after a stall count again.
const { createLoopLagMonitor } = require('../../src/server/link-watchdog.js');

function lagHarness() {
  let t = 0;
  const exits = [];
  const logs = [];
  const stalls = []; // { at, ms }: when this process's loop was seen to stall
  const watchdog = createLinkWatchdog({
    ping: async () => {},
    exit: (code) => exits.push(code),
    log: (m) => logs.push(m),
    now: () => t,
    loopLag: { worstSince: (since) => Math.max(0, ...stalls.filter((s) => s.at >= since).map((s) => s.ms)) },
  });
  return { watchdog, exits, logs, stalls, at: (ms) => { t = ms; }, now: () => t };
}

test('link errors right after the server\'s own long stall never trip it', async () => {
  const h = lagHarness();
  for (const at of [0, 30_000, 60_000, 90_000]) {
    h.at(at);
    h.stalls.push({ at, ms: 18_500 }); // the regex stall, observed as it ended
    oneStall(h.watchdog);
    await tick();
  }
  await tick();
  assert.deepEqual(h.exits, [], 'four recovered stalls of our own are not a stale link');
  assert.equal(h.watchdog.pending, 0);
  assert.equal(h.watchdog.excused, 40);
  assert.equal(h.logs.filter((m) => /own 18500ms event-loop stall/.test(m)).length, 4, 'said once per stall, not per error');
});

test('the same errors with no stall of our own, or only jitter, still trip', async () => {
  const h = lagHarness();
  for (const at of [0, 30_000, 60_000, 90_000]) {
    h.at(at);
    h.stalls.push({ at, ms: 1_500 }); // jitter, not a stall that can cost a request its deadline
    oneStall(h.watchdog);
    await tick();
  }
  await tick();
  assert.deepEqual(h.exits, [75]);
  assert.equal(h.watchdog.excused, 0);
});

// Second Sol review: a request 8 s into its 10 s budget misses on a 2 s stall,
// so four recovered 8 s stalls tripped the first rule (10 s threshold).
test('stalls shorter than the request timeout still excuse the timeouts they cause', async () => {
  const h = lagHarness();
  for (const at of [0, 30_000, 60_000, 90_000]) {
    h.at(at);
    h.stalls.push({ at, ms: 8_000 });
    oneStall(h.watchdog);
    await tick();
  }
  await tick();
  assert.deepEqual(h.exits, []);
  assert.ok(h.watchdog.excused >= 4);
});

test('a stall excuses only the errors that land within a few seconds of it', async () => {
  const h = lagHarness();
  h.stalls.push({ at: 0, ms: 15_000 });
  h.at(4_000);
  h.watchdog.note('sidebar', new Error('list request timed out after 10000ms'));
  assert.equal(h.watchdog.excused, 1);
  // A link that keeps failing long after the stall (past a request's lifetime
  // plus grace, 15 s) is the link's own fault.
  for (const at of [20_000, 32_000, 44_000, 56_000]) { h.at(at); oneStall(h.watchdog); await tick(); }
  await tick();
  assert.deepEqual(h.exits, [75]);
});

test('the lag monitor logs a late tick, counts a stall still being caught up on, and lets go of old ones', () => {
  let t = 1_000_000;
  const logs = [];
  let armed = null;
  const monitor = createLoopLagMonitor({
    now: () => t,
    log: (m) => logs.push(m),
    setIntervalFn: (fn, ms) => { armed = { fn, ms }; return { unref() { armed.unref = true; } }; },
    clearIntervalFn: () => { armed = null; },
  });
  assert.equal(armed.ms, 1000);
  assert.equal(armed.unref, true, 'the monitor must never hold the process open');
  t += 1000; monitor.tick();
  t += 1200; monitor.tick();
  assert.deepEqual(logs, [], 'a tick 200 ms late is ordinary jitter');
  // The loop is blocked 12 s: before the tick runs, a deadline timer that fired
  // first already sees the stall in progress.
  t += 13_000;
  assert.equal(monitor.worstSince(t - 5000), 12_000);
  monitor.tick();
  assert.deepEqual(logs, ['event loop lag observed: 12000ms']);
  t += 1000; monitor.tick();
  assert.equal(monitor.worstSince(t - 5000), 12_000, 'still within a few seconds of the stall');
  assert.equal(monitor.worstSince(t + 1), 0, 'and forgotten once the window has passed it');
  monitor.close();
  assert.equal(armed, null);
});
